//! Keep an open directory descriptor so pathname replacement cannot redirect
//! credential reads/writes between validation and use.
use std::{
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
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)?;
    validate(&file, true)?;
    Ok(file)
}
fn open(directory: &File, create: bool) -> io::Result<File> {
    let mode = if create {
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL
    } else {
        libc::O_RDONLY
    };
    // SAFETY: descriptor is owned and live; the fixed filename is NUL terminated.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c"connection.json".as_ptr(),
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
    open(directory, false)
}
pub fn create(directory: &File) -> io::Result<File> {
    open(directory, true)
}
