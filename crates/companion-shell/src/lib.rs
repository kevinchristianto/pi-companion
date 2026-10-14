//! Platform-independent shell policy. Contains no webview and launches no process.
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{self, Read, Write},
    path::Path,
};

#[cfg(unix)]
mod unix_private;
#[cfg(windows)]
mod windows_private;

pub const BRIDGE_PORT: u16 = 4318;
pub const RECOVERY_SHORTCUT: &str = "CommandOrControl+Shift+P";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub pinned: bool,
    pub click_through: bool,
    pub recovery_available: bool,
}
impl WindowState {
    pub fn can_hide(&self) -> bool {
        self.recovery_available
    }
    pub fn can_close_to_tray(&self, tray_available: bool) -> bool {
        tray_available && self.recovery_available
    }
    pub fn can_click_through(&self, enabled: bool) -> bool {
        !enabled || self.recovery_available
    }
    pub fn restored(&mut self) {
        self.click_through = false;
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
pub fn fit_window(window: Rect, work: Rect) -> Rect {
    fn axis(position: f64, size: f64, origin: f64, extent: f64) -> (f64, f64) {
        let origin = if origin.is_finite() { origin } else { 0.0 };
        let extent = if extent.is_finite() {
            extent.max(1.0)
        } else {
            1.0
        };
        let size = if size.is_finite() {
            size.clamp(1.0, extent)
        } else {
            extent
        };
        let position = if position.is_finite() {
            position
        } else {
            origin
        };
        (position.clamp(origin, origin + extent - size), size)
    }
    let (x, width) = axis(window.x, window.width, work.x, work.width);
    let (y, height) = axis(window.y, window.height, work.y, work.height);
    Rect {
        x,
        y,
        width,
        height,
    }
}
pub fn preset_size(preset: &str) -> Option<(f64, f64)> {
    match preset {
        "compact" => Some((620.0, 480.0)),
        "wide" => Some((960.0, 480.0)),
        "tall" => Some((620.0, 760.0)),
        _ => None,
    }
}

// Deliberately no Debug or Serialize implementation: credentials never enter UI state or logs.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub version: u8,
    pub url: String,
    pub token: String,
}
impl Connection {
    pub fn validate(&self) -> bool {
        self.version == 1
            && self.url == format!("http://127.0.0.1:{BRIDGE_PORT}")
            && self.token.len() == 64
            && self.token.bytes().all(|c| c.is_ascii_hexdigit())
    }
}
fn read_connection(file: File) -> io::Result<Connection> {
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 1024 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut text = String::new();
    file.take(1025).read_to_string(&mut text)?;
    if text.len() > 1024 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let connection: Connection =
        serde_json::from_str(&text).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
    if !connection.validate() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(connection)
}
/// Loads or creates the one private, local observer credential. Called only by the native app.
/// Existing malformed or insecure files are never silently replaced or chmodded.
pub fn load_or_create_connection(directory: &Path) -> io::Result<Connection> {
    if !directory.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    #[cfg(unix)]
    let directory_handle = unix_private::directory(directory)?;
    #[cfg(windows)]
    let _directory_handle = windows_private::directory(directory)?;
    #[cfg(unix)]
    let read = || unix_private::read(&directory_handle);
    #[cfg(windows)]
    let read = || windows_private::read(&directory.join("connection.json"));
    match read().and_then(read_connection) {
        Ok(value) => return Ok(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| io::Error::other("OS randomness unavailable"))?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let value = serde_json::json!({"version":1,"url":format!("http://127.0.0.1:{BRIDGE_PORT}"),"token":token});
    #[cfg(unix)]
    let created = unix_private::create(&directory_handle);
    #[cfg(windows)]
    let created = windows_private::create(&directory.join("connection.json"));
    match created {
        Ok(mut file) => {
            file.write_all(value.to_string().as_bytes())?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    read().and_then(read_connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs;
    #[test]
    fn presets_are_bounded_and_unknown_denied() {
        assert_eq!(preset_size("wide"), Some((960.0, 480.0)));
        assert!(preset_size("javascript:open").is_none());
    }
    #[test]
    fn monitor_removal_and_negative_coordinates() {
        let work = Rect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        };
        assert_eq!(
            fit_window(
                Rect {
                    x: 5000.0,
                    y: -90.0,
                    width: 620.0,
                    height: 480.0
                },
                work
            ),
            Rect {
                x: -620.0,
                y: 0.0,
                width: 620.0,
                height: 480.0
            }
        );
    }
    #[test]
    fn tiny_work_area_clamps_size() {
        let w = Rect {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 200.0,
        };
        assert_eq!(
            fit_window(
                Rect {
                    x: 400.0,
                    y: 400.0,
                    width: 620.0,
                    height: 480.0
                },
                w
            ),
            w
        );
    }
    #[test]
    fn invalid_and_zero_monitor_geometry_never_panics() {
        let fitted = fit_window(
            Rect {
                x: f64::NAN,
                y: f64::INFINITY,
                width: f64::NAN,
                height: -1.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
        );
        assert_eq!(
            fitted,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0
            }
        );
    }
    #[cfg(unix)]
    #[test]
    fn hard_links_and_public_files_are_rejected_without_repair() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("connection.json");
        fs::write(&path, "fixture").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_or_create_connection(&directory).is_err());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::hard_link(&path, directory.join("alias")).unwrap();
        assert!(load_or_create_connection(&directory).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "fixture");
    }
    #[test]
    fn recovery_is_required_for_trapping_actions() {
        let mut s = WindowState::default();
        assert!(!s.can_hide());
        assert!(!s.can_click_through(true));
        assert!(s.can_click_through(false));
        s.recovery_available = true;
        s.click_through = true;
        s.restored();
        assert!(!s.click_through);
        assert!(s.can_hide());
        assert!(!s.can_close_to_tray(false));
        assert!(s.can_close_to_tray(true));
    }
    #[test]
    fn validates_only_fixed_local_connection_schema() {
        let mut c = Connection {
            version: 1,
            url: "http://127.0.0.1:4318".into(),
            token: "a".repeat(64),
        };
        assert!(c.validate());
        c.url = "http://example.org".into();
        assert!(!c.validate());
    }
    #[cfg(unix)]
    #[test]
    fn existing_fixture_is_read_without_replacement() {
        let root = tempfile::tempdir().unwrap();
        let d = root.path().join("private");
        fs::create_dir(&d).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let p = d.join("connection.json");
        fs::write(
            &p,
            format!(
                r#"{{"version":1,"url":"http://127.0.0.1:4318","token":"{}"}}"#,
                "a".repeat(64)
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(load_or_create_connection(&d).unwrap().validate());
        fs::write(&p, "bad").unwrap();
        assert!(load_or_create_connection(&d).is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), "bad");
    }
    #[cfg(unix)]
    #[test]
    fn symlink_and_public_directory_are_rejected() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let link = root.path().join("link");
        symlink(root.path(), &link).unwrap();
        assert!(load_or_create_connection(&link).is_err());
        let d = root.path().join("public");
        fs::create_dir(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(load_or_create_connection(&d).is_err());
    }
}
