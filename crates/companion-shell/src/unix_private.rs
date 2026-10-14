//! Keep an open directory descriptor so pathname replacement cannot redirect
//! credential reads/writes between validation and use.
use std::{
    ffi::{CStr, CString},
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::Path,
};

fn validate(file: &File, directory: bool) -> io::Result<()> {
    let meta = file.metadata()?;
    if meta.is_dir() != directory
        || (!directory && (!meta.is_file() || meta.nlink() != 1))
        || meta.mode() & 0o077 != 0
        || meta.uid() != unsafe { libc::geteuid() }
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}
pub fn directory(path: &Path) -> io::Result<File> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    open_directory(path)
}
fn open_directory(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)?;
    validate(&file, true)?;
    Ok(file)
}
pub fn verify_directory(path: &Path, expected: &File) -> io::Result<()> {
    let current = open_directory(path)?;
    let current = current.metadata()?;
    let expected = expected.metadata()?;
    if (current.dev(), current.ino()) != (expected.dev(), expected.ino()) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}
fn filename(name: &str) -> io::Result<CString> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    CString::new(name).map_err(|_| io::ErrorKind::InvalidInput.into())
}
pub fn subdirectory(directory: &File, name: &str) -> io::Result<File> {
    let name = filename(name)?;
    // SAFETY: the descriptor remains live and the name is one NUL-terminated component.
    if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    validate(&file, true)?;
    Ok(file)
}
fn open(directory: &File, name: &CStr, create: bool) -> io::Result<File> {
    let mode = if create {
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL
    } else {
        libc::O_RDONLY
    };
    // SAFETY: descriptor is owned and live; the filename is NUL terminated.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            mode | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    validate(&file, false)?;
    Ok(file)
}
pub fn read(directory: &File) -> io::Result<File> {
    open(directory, c"connection.json", false)
}
pub fn create(directory: &File) -> io::Result<File> {
    open(directory, c"connection.json", true)
}
pub fn read_named(directory: &File, name: &str) -> io::Result<File> {
    open(directory, &filename(name)?, false)
}
pub fn create_named(directory: &File, name: &str) -> io::Result<File> {
    open(directory, &filename(name)?, true)
}
pub fn replace_named(directory: &File, from: &str, to: &str) -> io::Result<()> {
    let from = filename(from)?;
    let to = filename(to)?;
    // Both names resolve under the validated, pinned directory, never by an
    // unchecked absolute pathname. Rename replaces a name, not its link target.
    if unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    directory.sync_all()
}
pub fn remove_named(directory: &File, name: &str) -> io::Result<()> {
    let name = filename(name)?;
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
