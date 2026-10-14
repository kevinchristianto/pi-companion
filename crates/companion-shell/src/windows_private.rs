//! Handle-based Windows credential-file security. Existing ACLs are validated,
//! never repaired silently. New objects receive a protected DACL at creation.
use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SE_FILE_OBJECT,
        },
        EqualSid, GetAce, GetTokenInformation, IsWellKnownSid, TokenUser,
        WinBuiltinAdministratorsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        CREATE_NEW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

fn denied() -> io::Error {
    io::ErrorKind::PermissionDenied.into()
}
fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let mut result: Vec<u16> = path.as_os_str().encode_wide().collect();
    if result.contains(&0) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    result.push(0);
    Ok(result)
}
struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: these allocations are returned by the Win32 LocalAlloc family.
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct UserSid(Vec<usize>);
impl UserSid {
    fn current() -> io::Result<Self> {
        let mut token = null_mut();
        // SAFETY: the process pseudo-handle is valid and the output pointer lives through the call.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcessToken returned an owned kernel handle.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut needed = 0;
        // SAFETY: the first call only queries the required byte count.
        unsafe {
            GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut needed);
        }
        if needed < size_of::<TOKEN_USER>() as u32 || needed > 65_536 {
            return Err(denied());
        }
        // usize storage provides TOKEN_USER's alignment, unlike a Vec<u8>.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        // SAFETY: the aligned buffer has at least `needed` initialized bytes.
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(buffer))
    }
    fn as_ptr(&self) -> PSID {
        // SAFETY: this buffer is a successful TOKEN_USER result and remains alive.
        unsafe { (*(self.0.as_ptr().cast::<TOKEN_USER>())).User.Sid }
    }
    fn sddl(&self) -> io::Result<String> {
        let mut pointer = null_mut();
        // SAFETY: the SID and output pointer are valid for this call.
        if unsafe { ConvertSidToStringSidW(self.as_ptr(), &mut pointer) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _allocation = LocalAllocation(pointer.cast());
        let mut length = 0;
        // SAFETY: ConvertSidToStringSidW returns a NUL-terminated UTF-16 SID string.
        unsafe {
            while *pointer.add(length) != 0 {
                length += 1;
            }
            String::from_utf16(std::slice::from_raw_parts(pointer, length)).map_err(|_| denied())
        }
    }
}
struct PrivateDescriptor(LocalAllocation);
impl PrivateDescriptor {
    fn new() -> io::Result<Self> {
        let sid = UserSid::current()?.sddl()?;
        // User owns the object. Only that user, SYSTEM and Administrators have
        // access; P prevents inheritance from broad parent-directory ACLs.
        let sddl = format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)\0");
        let wide: Vec<u16> = sddl.encode_utf16().collect();
        let mut descriptor = null_mut();
        // SAFETY: the input is NUL terminated and the output is freed with LocalFree.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(LocalAllocation(descriptor)))
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0 .0,
            bInheritHandle: 0,
        }
    }
}
fn check_acl(handle: HANDLE) -> io::Result<()> {
    let user = UserSid::current()?;
    let mut owner = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: the live handle has READ_CONTROL; all output pointers are valid.
    let error = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    let _allocation = LocalAllocation(descriptor);
    // Null DACL grants everybody access. The caller must own both directory and file.
    if owner.is_null() || dacl.is_null() || unsafe { EqualSid(owner, user.as_ptr()) } == 0 {
        return Err(denied());
    }
    // SAFETY: GetSecurityInfo returned a valid ACL owned by the live descriptor.
    for index in 0..unsafe { (*dacl).AceCount } {
        let mut ace = null_mut();
        if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if ace.is_null() {
            return Err(denied());
        }
        // Fail closed on callback/object/unknown ACE types rather than attempting
        // incomplete effective-access evaluation. ACCESS_ALLOWED_ACE_TYPE is 0.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceType != 0 || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>() {
            return Err(denied());
        }
        let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
        let sid = unsafe { std::ptr::addr_of!((*allowed).SidStart).cast_mut().cast() };
        let trusted = unsafe {
            EqualSid(sid, user.as_ptr()) != 0
                || IsWellKnownSid(sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
        };
        if !trusted {
            return Err(denied());
        }
    }
    Ok(())
}
fn validate_handle(file: &File, directory: bool) -> io::Result<()> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    // SAFETY: file owns a live handle; the structure is correctly sized.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(denied());
    }
    check_acl(file.as_raw_handle())
}
fn open(path: &Path, create: bool, directory: bool) -> io::Result<File> {
    let path = wide(path)?;
    let descriptor = if create {
        Some(PrivateDescriptor::new()?)
    } else {
        None
    };
    let attributes = descriptor.as_ref().map(PrivateDescriptor::attributes);
    // Directory handles deliberately deny FILE_SHARE_DELETE, preventing rename
    // or substitution while the credential file is opened. Readers deny writes.
    let share = if directory {
        FILE_SHARE_READ | FILE_SHARE_WRITE
    } else {
        FILE_SHARE_READ
    };
    let access = if create {
        GENERIC_READ | GENERIC_WRITE
    } else if directory {
        READ_CONTROL
    } else {
        GENERIC_READ
    };
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
    // SAFETY: path is NUL terminated; descriptor and attributes outlive the call.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            share,
            attributes.as_ref().map_or(null(), |v| v),
            if create { CREATE_NEW } else { OPEN_EXISTING },
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned an owned file/directory handle.
    let file = unsafe { File::from_raw_handle(handle) };
    validate_handle(&file, directory)?;
    Ok(file)
}
pub fn directory(path: &Path) -> io::Result<File> {
    match open(path, false, true) {
        Ok(file) => return Ok(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // The OS application-data parent must already exist. Do not create arbitrary
    // parent trees or silently change their security settings.
    let descriptor = PrivateDescriptor::new()?;
    let path_wide = wide(path)?;
    let attributes = descriptor.attributes();
    if unsafe { CreateDirectoryW(path_wide.as_ptr(), &attributes) } == 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    open(path, false, true)
}
pub fn read(path: &Path) -> io::Result<File> {
    open(path, false, false)
}
pub fn create(path: &Path) -> io::Result<File> {
    open(path, true, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn fixed_fixture_with_private_dacl_is_accepted() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("private");
        let _directory = directory(&path).unwrap();
        let file_path = path.join("connection.json");
        let mut file = create(&file_path).unwrap();
        write!(
            file,
            "{{\"version\":1,\"url\":\"http://127.0.0.1:4318\",\"token\":\"{}\"}}",
            "a".repeat(64)
        )
        .unwrap();
        drop(file);
        assert!(super::super::load_or_create_connection(&path)
            .unwrap()
            .validate());
    }
    #[test]
    fn world_readable_dacl_is_rejected_without_repair() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("public.json");
        let user = UserSid::current().unwrap().sddl().unwrap();
        let sddl: Vec<u16> = format!("O:{user}D:P(A;;FA;;;{user})(A;;FR;;;WD)\0")
            .encode_utf16()
            .collect();
        let mut descriptor = null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    null_mut(),
                )
            },
            0
        );
        let allocation = PrivateDescriptor(LocalAllocation(descriptor));
        let attributes = allocation.attributes();
        let path_wide = wide(&path).unwrap();
        let handle = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        let mut file = unsafe { File::from_raw_handle(handle) };
        file.write_all(b"fixture").unwrap();
        drop(file);
        assert_eq!(
            read(&path).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), "fixture");
    }
    #[test]
    fn hard_linked_fixture_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("private");
        let _directory = directory(&path).unwrap();
        let file_path = path.join("connection.json");
        drop(create(&file_path).unwrap());
        std::fs::hard_link(&file_path, path.join("second.json")).unwrap();
        assert!(read(&file_path).is_err());
    }
}
