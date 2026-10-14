//! Export only the observer shipped with this executable. No runtime resource
//! path, working directory, Pi configuration, or environment variable is trusted.
use std::{
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

// Dependencies first, entry point last. The public path stays the same across
// app upgrades (and moving the executable). A build embeds the matching sources.
const SOURCES: [(&str, &str); 5] = [
    (
        "connection.ts",
        include_str!("../../../observer/connection.ts"),
    ),
    ("protocol.ts", include_str!("../../../observer/protocol.ts")),
    (
        "subagents.ts",
        include_str!("../../../observer/subagents.ts"),
    ),
    (
        "transport.ts",
        include_str!("../../../observer/transport.ts"),
    ),
    ("index.ts", include_str!("../../../observer/index.ts")),
];

struct ExportDirectory {
    // Keep both ancestors open until every export operation has completed.
    _config: File,
    directory: File,
    #[cfg(windows)]
    path: PathBuf,
}
impl ExportDirectory {
    fn open(config: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let config = super::unix_private::directory(config)?;
            let directory = super::unix_private::subdirectory(&config, "observer")?;
            Ok(Self {
                _config: config,
                directory,
            })
        }
        #[cfg(windows)]
        {
            // The config/observer handles deny delete sharing, pinning each
            // directory against replacement while their children are accessed.
            let config_handle = super::windows_private::directory(config)?;
            let path = config.join("observer");
            let directory = super::windows_private::directory(&path)?;
            Ok(Self {
                _config: config_handle,
                directory,
                path,
            })
        }
    }
    fn read(&self, name: &str) -> io::Result<File> {
        #[cfg(unix)]
        {
            super::unix_private::read_named(&self.directory, name)
        }
        #[cfg(windows)]
        {
            super::windows_private::read(&self.path.join(name))
        }
    }
    fn verify_path(&self, config: &Path) -> io::Result<()> {
        #[cfg(unix)]
        use super::unix_private::verify_directory;
        #[cfg(windows)]
        use super::windows_private::verify_directory;
        verify_directory(config, &self._config)?;
        verify_directory(&config.join("observer"), &self.directory)
    }
    fn stage(&self, content: &str) -> io::Result<StagedFile<'_>> {
        // No predictable temporary file is ever opened or overwritten. Existing
        // unknown files, including leftovers from a crash, are not touched.
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| io::Error::other("OS randomness unavailable"))?;
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let name = format!(".observer-{nonce}.tmp");
        #[cfg(unix)]
        let file = super::unix_private::create_named(&self.directory, &name)?;
        #[cfg(windows)]
        let file = super::windows_private::create_temporary(&self.path.join(&name))?;
        let mut staged = StagedFile {
            directory: self,
            file,
            #[cfg(unix)]
            name,
            committed: false,
        };
        staged.file.write_all(content.as_bytes())?;
        staged.file.sync_all()?;
        Ok(staged)
    }
}
struct StagedFile<'a> {
    directory: &'a ExportDirectory,
    file: File,
    #[cfg(unix)]
    name: String,
    committed: bool,
}
impl StagedFile<'_> {
    fn commit(mut self, name: &str) -> io::Result<()> {
        // Recheck the destination immediately before replacing the directory
        // entry; an unsafe existing object is never repaired or followed.
        match self.directory.read(name) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        #[cfg(unix)]
        super::unix_private::replace_named(&self.directory.directory, &self.name, name)?;
        #[cfg(windows)]
        super::windows_private::replace_temporary(&self.file, &self.directory.directory, name)?;
        self.committed = true;
        Ok(())
    }
}
impl Drop for StagedFile<'_> {
    fn drop(&mut self) {
        if !self.committed {
            #[cfg(unix)]
            let _ = super::unix_private::remove_named(&self.directory.directory, &self.name);
            #[cfg(windows)]
            let _ = super::windows_private::discard_temporary(&self.file);
        }
    }
}

fn matches(mut file: File, content: &str) -> io::Result<bool> {
    if file.metadata()?.len() != content.len() as u64 {
        return Ok(false);
    }
    // Bound allocation/read even if an existing file changes during the read.
    let mut bytes = Vec::with_capacity(content.len());
    (&mut file)
        .take(content.len() as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes == content.as_bytes())
}

/// Creates/refreshes the five trusted bundled sources under `<config>/observer`.
/// Returns the stable `index.ts` path only after verifying the complete export.
///
/// Existing private files in those five names are app-owned and upgradeable.
/// Every existing destination is validated before any source is refreshed; no
/// permissions are repaired, and other filenames and `connection.json` are never
/// changed. Unchanged sources retain their inode, timestamp, and content. Changed
/// files are staged privately, synced, and replaced atomically one at a time,
/// with index.ts last. An interrupted multi-file upgrade is retried next launch.
pub fn export_observer(config: &Path) -> io::Result<PathBuf> {
    if !config.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    export_sources(config, &SOURCES)
}
fn export_sources(config: &Path, sources: &[(&str, &str); 5]) -> io::Result<PathBuf> {
    let directory = ExportDirectory::open(config)?;
    let mut changed = Vec::new();
    // Preflight the entire owned set before staging or modifying a source.
    for &(name, content) in sources {
        let unchanged = match directory.read(name) {
            Ok(file) => matches(file, content)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error),
        };
        if !unchanged {
            changed.push((name, content));
        }
    }
    // Complete all writes before the first replacement; disk-full or creation
    // failure cannot truncate the previous working bundle.
    let staged = changed
        .iter()
        .map(|(name, content)| directory.stage(content).map(|file| (*name, file)))
        .collect::<io::Result<Vec<_>>>()?;
    for (name, file) in staged {
        file.commit(name)?;
    }
    for &(name, content) in sources {
        if !matches(directory.read(name)?, content)? {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    // A Unix directory may be renamed despite an open descriptor. Never return
    // a stale path that no longer names the pinned directories we just verified.
    directory.verify_path(config)?;
    Ok(config.join("observer").join("index.ts"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn config(root: &Path) -> PathBuf {
        let path = root.join("Pi Companion 日本語 🐾");
        super::super::load_or_create_connection(&path).unwrap();
        path
    }
    fn entries(path: &Path) -> Vec<String> {
        let mut entries = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }
    #[test]
    fn complete_private_export_is_stable_and_preserves_credentials() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let connection = fs::read(config.join("connection.json")).unwrap();
        let entry = export_observer(&config).unwrap();
        assert_eq!(entry, config.join("observer/index.ts"));
        let expected = [
            "connection.ts",
            "index.ts",
            "protocol.ts",
            "subagents.ts",
            "transport.ts",
        ];
        assert_eq!(entries(entry.parent().unwrap()), expected);
        let metadata = fs::metadata(&entry).unwrap();
        assert_eq!(export_observer(&config).unwrap(), entry);
        assert_eq!(
            metadata.modified().unwrap(),
            fs::metadata(&entry).unwrap().modified().unwrap()
        );
        assert_eq!(
            fs::read(config.join("connection.json")).unwrap(),
            connection
        );
        for (name, source) in SOURCES {
            let path = config.join("observer").join(name);
            assert_eq!(fs::read_to_string(&path).unwrap(), source);
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o600);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(metadata.ino(), fs::metadata(&entry).unwrap().ino());
            assert_eq!(
                fs::metadata(config.join("observer")).unwrap().mode() & 0o777,
                0o700
            );
        }
    }
    #[test]
    fn upgrades_refresh_only_owned_sources_and_repair_partial_exports() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let connection = fs::read(config.join("connection.json")).unwrap();
        let previous = SOURCES.map(|(name, _)| (name, "// older shipped observer\n"));
        export_sources(&config, &previous).unwrap();
        let observer = config.join("observer");
        fs::write(observer.join("user-note.txt"), b"leave untouched").unwrap();
        fs::write(
            observer.join(".observer-unrelated.tmp"),
            b"leave untouched too",
        )
        .unwrap();
        fs::remove_file(observer.join("transport.ts")).unwrap();
        export_observer(&config).unwrap();
        for (name, content) in SOURCES {
            assert_eq!(fs::read_to_string(observer.join(name)).unwrap(), content);
        }
        assert_eq!(
            fs::read_to_string(observer.join("user-note.txt")).unwrap(),
            "leave untouched"
        );
        assert_eq!(
            fs::read_to_string(observer.join(".observer-unrelated.tmp")).unwrap(),
            "leave untouched too"
        );
        assert_eq!(entries(&observer).len(), 7);
        assert_eq!(
            fs::read(config.join("connection.json")).unwrap(),
            connection
        );
    }
    #[test]
    fn relocation_needs_neither_resources_nor_settings_and_keeps_token() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        export_observer(&config).unwrap();
        let credential = fs::read(config.join("connection.json")).unwrap();
        let moved = root.path().join("relocated üser config");
        fs::rename(config, &moved).unwrap();
        assert_eq!(
            export_observer(&moved).unwrap(),
            moved.join("observer/index.ts")
        );
        assert_eq!(fs::read(moved.join("connection.json")).unwrap(), credential);
        assert!(!moved.join("settings.json").exists());
        assert_eq!(entries(&moved), ["connection.json", "observer"]);
    }
    #[test]
    fn relative_configuration_directory_is_rejected() {
        assert_eq!(
            export_observer(Path::new("relative")).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
    #[test]
    fn interrupted_staging_leaves_previous_sources_and_no_temporary_file() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let entry = export_observer(&config).unwrap();
        let previous = fs::read(&entry).unwrap();
        let directory = ExportDirectory::open(&config).unwrap();
        let stage = directory.stage("// not committed").unwrap();
        assert_eq!(entries(entry.parent().unwrap()).len(), 6);
        drop(stage);
        assert_eq!(entries(entry.parent().unwrap()).len(), 5);
        assert_eq!(fs::read(entry).unwrap(), previous);
    }
    #[cfg(windows)]
    #[test]
    fn reparse_point_export_directory_is_rejected() {
        use std::os::windows::fs::symlink_dir;
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let link = config.join("observer");
        match symlink_dir(&outside, &link) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!("Skipping reparse fixture: Windows symlink privilege is unavailable");
                return;
            }
            Err(error) => panic!("Could not create reparse fixture: {error}"),
        }
        assert_eq!(
            export_observer(&config).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(entries(&outside).len(), 0);
        assert!(fs::symlink_metadata(link).unwrap().is_symlink());
    }
    #[test]
    fn hardlinks_are_rejected_before_refreshing_other_sources() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let previous = SOURCES.map(|(name, _)| (name, "// previous\n"));
        export_sources(&config, &previous).unwrap();
        let observer = config.join("observer");
        fs::hard_link(observer.join("index.ts"), root.path().join("alias.ts")).unwrap();
        assert_eq!(
            export_observer(&config).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        for (name, content) in previous {
            assert_eq!(fs::read_to_string(observer.join(name)).unwrap(), content);
        }
        assert_eq!(entries(&observer).len(), 5);
    }
    #[cfg(unix)]
    #[test]
    fn unsafe_modes_are_rejected_without_repair_or_partial_refresh() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let previous = SOURCES.map(|(name, _)| (name, "// previous\n"));
        export_sources(&config, &previous).unwrap();
        let observer = config.join("observer");
        let index = observer.join("index.ts");
        fs::set_permissions(&index, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            export_observer(&config).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            fs::metadata(&index).unwrap().permissions().mode() & 0o777,
            0o644
        );
        for (name, content) in previous {
            assert_eq!(fs::read_to_string(observer.join(name)).unwrap(), content);
        }
        fs::set_permissions(&index, fs::Permissions::from_mode(0o600)).unwrap();
        for directory in [&observer, &config] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(export_observer(&config).is_err());
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o755
            );
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_config_directory_observer_directory_and_sources_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let alias = root.path().join("config alias");
        symlink(&config, &alias).unwrap();
        assert!(export_observer(&alias).is_err());
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, config.join("observer")).unwrap();
        assert!(export_observer(&config).is_err());
        assert_eq!(entries(&outside).len(), 0);
        fs::remove_file(config.join("observer")).unwrap();
        export_observer(&config).unwrap();
        let index = config.join("observer/index.ts");
        fs::remove_file(&index).unwrap();
        let target = outside.join("target.ts");
        fs::write(&target, "untouched").unwrap();
        symlink(&target, &index).unwrap();
        assert!(export_observer(&config).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
        assert!(fs::symlink_metadata(index).unwrap().is_symlink());
    }
    #[cfg(unix)]
    #[test]
    fn pinned_directory_cannot_redirect_writes_after_path_replacement() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let directory = ExportDirectory::open(&config).unwrap();
        let stage = directory.stage("// trusted source\n").unwrap();
        let observer = config.join("observer");
        let saved = config.join("old observer");
        fs::rename(&observer, &saved).unwrap();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, &observer).unwrap();
        stage.commit("index.ts").unwrap();
        assert!(directory.verify_path(&config).is_err());
        assert_eq!(entries(&outside).len(), 0);
        assert_eq!(
            fs::read_to_string(saved.join("index.ts")).unwrap(),
            "// trusted source\n"
        );
    }
    #[cfg(unix)]
    #[test]
    fn nonregular_sources_do_not_block_or_get_replaced() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        export_observer(&config).unwrap();
        let index = config.join("observer/index.ts");
        fs::remove_file(&index).unwrap();
        let name = CString::new(index.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(
            export_observer(&config).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        fs::remove_file(&index).unwrap();
        fs::create_dir(&index).unwrap();
        assert!(export_observer(&config).is_err());
        assert!(index.is_dir());
    }
}
