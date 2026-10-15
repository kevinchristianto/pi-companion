//! Bounded, app-owned placement preferences. Never reads or edits Pi settings.
//! Reuses the same handle-pinned private I/O as the observer export/credential.
use crate::taskbar::Placement;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{self, Read, Write},
    path::Path,
};

const NAME: &str = "taskbar-placement.json";
const MAX_BYTES: u64 = 2048;
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub version: u8,
    pub placement: Placement,
    pub monitor: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            placement: Placement::default(),
            monitor: None,
        }
    }
}
impl Preferences {
    pub fn validate(&self) -> bool {
        self.version == 1
            && self.placement.validate()
            && self.monitor.as_ref().is_none_or(|name| {
                !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control)
            })
    }
    pub fn set_monitor(&mut self, name: Option<&str>) {
        self.monitor = name
            .filter(|name| {
                !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control)
            })
            .map(str::to_owned);
    }
}
struct Directory<'a> {
    handle: File,
    path: &'a Path,
}
impl<'a> Directory<'a> {
    fn open(path: &'a Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        #[cfg(unix)]
        let handle = crate::unix_private::directory(path)?;
        #[cfg(windows)]
        let handle = crate::windows_private::directory(path)?;
        Ok(Self { handle, path })
    }
    fn read(&self) -> io::Result<File> {
        #[cfg(unix)]
        {
            crate::unix_private::read_named(&self.handle, NAME)
        }
        #[cfg(windows)]
        {
            crate::windows_private::read(&self.path.join(NAME))
        }
    }
    fn verify(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            crate::unix_private::verify_directory(self.path, &self.handle)
        }
        #[cfg(windows)]
        {
            crate::windows_private::verify_directory(self.path, &self.handle)
        }
    }
    fn preferences(&self) -> io::Result<Preferences> {
        let file = match self.read() {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Preferences::default())
            }
            Err(error) => return Err(error),
        };
        if file.metadata()?.len() > MAX_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut data = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut data)?;
        if data.len() as u64 > MAX_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let object: serde_json::Value =
            serde_json::from_slice(&data).map_err(|_| io::ErrorKind::InvalidData)?;
        if !object.is_object()
            || !object
                .get("placement")
                .is_some_and(serde_json::Value::is_object)
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let value: Preferences =
            serde_json::from_value(object).map_err(|_| io::ErrorKind::InvalidData)?;
        if !value.validate() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(value)
    }
}
pub fn load(config: &Path) -> io::Result<Preferences> {
    let directory = Directory::open(config)?;
    let value = directory.preferences()?;
    directory.verify()?;
    Ok(value)
}
struct Staged<'a, 'b> {
    directory: &'a Directory<'b>,
    file: File,
    #[cfg(unix)]
    name: String,
    committed: bool,
}
impl Drop for Staged<'_, '_> {
    fn drop(&mut self) {
        if !self.committed {
            #[cfg(unix)]
            let _ = crate::unix_private::remove_named(&self.directory.handle, &self.name);
            #[cfg(windows)]
            let _ = crate::windows_private::discard_temporary(&self.file);
        }
    }
}
pub fn save(config: &Path, value: &Preferences) -> io::Result<()> {
    if !value.validate() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let directory = Directory::open(config)?;
    // Existing unsafe or malformed preferences are never silently repaired.
    directory.preferences()?;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io::Error::other("OS randomness unavailable"))?;
    let nonce: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let name = format!(".placement-{nonce}.tmp");
    #[cfg(unix)]
    let file = crate::unix_private::create_named(&directory.handle, &name)?;
    #[cfg(windows)]
    let file = crate::windows_private::create_temporary(&directory.path.join(&name))?;
    let mut staged = Staged {
        directory: &directory,
        file,
        #[cfg(unix)]
        name,
        committed: false,
    };
    let data = serde_json::to_vec(value).map_err(|_| io::ErrorKind::InvalidData)?;
    staged.file.write_all(&data)?;
    staged.file.sync_all()?;
    directory.preferences()?;
    directory.verify()?;
    #[cfg(unix)]
    crate::unix_private::replace_named(&directory.handle, &staged.name, NAME)?;
    #[cfg(windows)]
    crate::windows_private::replace_temporary(&staged.file, &staged.directory.handle, NAME)?;
    staged.committed = true;
    // Windows denies sharing while the writable temporary handle is live.
    drop(staged);
    directory.verify()?;
    if directory.preferences()? != *value {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taskbar::{Alignment, Placement};
    use std::fs;
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("Private Companion 日本語");
        crate::load_or_create_connection(&config).unwrap();
        (root, config)
    }
    #[test]
    fn missing_and_saved_preferences_round_trip_without_touching_credentials() {
        let (_root, config) = fixture();
        let credential = fs::read(config.join("connection.json")).unwrap();
        assert_eq!(load(&config).unwrap(), Preferences::default());
        assert!(!config.join(NAME).exists());
        for placement in [
            Placement::default(),
            Placement::aligned(Alignment::Right).unwrap(),
            Placement::free(0.26).unwrap(),
        ] {
            let preferences = Preferences {
                placement,
                monitor: Some("\\\\.\\DISPLAY2".into()),
                ..Preferences::default()
            };
            save(&config, &preferences).unwrap();
            assert_eq!(load(&config).unwrap(), preferences);
        }
        assert_eq!(
            fs::read(config.join("connection.json")).unwrap(),
            credential
        );
        assert!(!config.join("settings.json").exists());
        assert_eq!(fs::read_dir(&config).unwrap().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                fs::metadata(config.join(NAME)).unwrap().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn malformed_oversized_unknown_fields_and_out_of_range_are_not_replaced() {
        let (_root, config) = fixture();
        save(&config, &Preferences::default()).unwrap();
        for data in [
            "not json".to_owned(),
            r#"[1,{"alignment":"center","position":0.5},null]"#.into(),
            r#"{"version":1,"placement":["center",0.5],"monitor":null}"#.into(), " ".repeat(MAX_BYTES as usize + 1),
            r#"{"version":2,"placement":{"alignment":"center","position":0.5},"monitor":null}"#.into(),
            r#"{"version":1,"placement":{"alignment":"free","position":2},"monitor":null}"#.into(),
            r#"{"version":1,"placement":{"alignment":"left","position":0.5},"monitor":null}"#.into(),
            r#"{"version":1,"placement":{"alignment":"center","position":0.5},"monitor":null,"execute":"anything"}"#.into(),
        ] {
            fs::write(config.join(NAME), &data).unwrap();
            assert!(load(&config).is_err());
            assert!(save(&config, &Preferences::default()).is_err());
            assert_eq!(fs::read_to_string(config.join(NAME)).unwrap(), data);
            assert_eq!(fs::read_dir(&config).unwrap().count(), 2);
        }
    }
    #[test]
    fn unsafe_preference_values_and_relative_paths_are_rejected() {
        let (_root, config) = fixture();
        for position in [f64::NAN, f64::INFINITY, -0.01, 1.01] {
            let value = Preferences {
                placement: Placement {
                    alignment: Alignment::Free,
                    position,
                },
                ..Preferences::default()
            };
            assert!(save(&config, &value).is_err());
        }
        for name in [
            "".to_owned(),
            "x".repeat(257),
            "display\0one".into(),
            "display\none".into(),
        ] {
            let value = Preferences {
                monitor: Some(name),
                ..Preferences::default()
            };
            assert!(save(&config, &value).is_err());
        }
        assert!(load(Path::new("relative")).is_err());
        assert!(save(Path::new("relative"), &Preferences::default()).is_err());
        assert!(!config.join(NAME).exists());
    }
    #[test]
    fn linked_file_is_rejected_without_changing_either_name() {
        let (root, config) = fixture();
        save(&config, &Preferences::default()).unwrap();
        let before = fs::read(config.join(NAME)).unwrap();
        fs::hard_link(config.join(NAME), root.path().join("alias")).unwrap();
        assert!(load(&config).is_err());
        assert!(save(&config, &Preferences::default()).is_err());
        assert_eq!(fs::read(config.join(NAME)).unwrap(), before);
    }
    #[cfg(unix)]
    #[test]
    fn pinned_directory_replacement_cannot_redirect_preference_access() {
        use std::os::unix::fs::symlink;
        let (root, config) = fixture();
        save(&config, &Preferences::default()).unwrap();
        let directory = Directory::open(&config).unwrap();
        let old = root.path().join("old private");
        fs::rename(&config, &old).unwrap();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, &config).unwrap();
        assert_eq!(directory.preferences().unwrap(), Preferences::default());
        assert!(directory.verify().is_err());
        assert!(load(&config).is_err());
        assert!(save(&config, &Preferences::default()).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert_eq!(load(&old).unwrap(), Preferences::default());
    }
    #[cfg(windows)]
    #[test]
    fn reparse_point_preference_is_rejected_without_following_target() {
        use std::os::windows::fs::symlink_file;
        let (root, config) = fixture();
        let target = root.path().join("outside.json");
        fs::write(&target, "untouched").unwrap();
        match symlink_file(&target, config.join(NAME)) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(1314) => return,
            Err(error) => panic!("Could not create reparse fixture: {error}"),
        }
        assert!(load(&config).is_err());
        assert!(save(&config, &Preferences::default()).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched");
        assert!(fs::symlink_metadata(config.join(NAME))
            .unwrap()
            .is_symlink());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_public_modes_and_nonregular_files_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (root, config) = fixture();
        save(&config, &Preferences::default()).unwrap();
        let path = config.join(NAME);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&config).is_err());
        assert!(save(&config, &Preferences::default()).is_err());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::remove_file(&path).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, "untouched").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(load(&config).is_err());
        assert!(save(&config, &Preferences::default()).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "untouched");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(load(&config).is_err());
        assert!(save(&config, &Preferences::default()).is_err());
        let alias = root.path().join("config alias");
        symlink(&config, &alias).unwrap();
        assert!(load(&alias).is_err());
        assert!(save(&alias, &Preferences::default()).is_err());
    }
}
