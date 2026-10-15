//! Bounded, read-only Win32 display inspection. Called on the native main thread.
//! No hooks, process handles, titles, screenshots, or Explorer embedding.
//!
//! API contracts:
//! https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-monitorfromwindow
//! https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getmonitorinfow
//! https://learn.microsoft.com/windows/win32/shell/abm-getautohidebarex
//! https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
use companion_shell::{
    taskbar::{covers_monitor, reserve_autohide_bar, Edge},
    Rect,
};
use std::mem::size_of;
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::{
        Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
        Gdi::{
            GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO,
            MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
        },
    },
    System::Threading::GetCurrentProcessId,
    UI::{
        Shell::{
            SHAppBarMessage, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETAUTOHIDEBAREX,
            APPBARDATA,
        },
        WindowsAndMessaging::{
            GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect,
            GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, GWL_STYLE, WS_CAPTION,
        },
    },
};

pub struct Display {
    pub work: Rect,
    pub scale: f64,
    pub fullscreen: Option<bool>,
}

fn rect(value: RECT) -> Rect {
    Rect {
        x: value.left.into(),
        y: value.top.into(),
        width: f64::from(value.right) - f64::from(value.left),
        height: f64::from(value.bottom) - f64::from(value.top),
    }
}

/// The foreground-only heuristic deliberately avoids treating a stale background
/// fullscreen window as active. Windows on other monitors never suppress the strip.
unsafe fn foreground_fullscreen(
    own: HWND,
    monitor: *mut std::ffi::c_void,
    bounds: Rect,
) -> Option<bool> {
    let candidate = GetForegroundWindow();
    if candidate.is_null() {
        return None;
    }
    if candidate == own || IsWindowVisible(candidate) == 0 || IsIconic(candidate) != 0 {
        return Some(false);
    }
    let mut process = 0;
    GetWindowThreadProcessId(candidate, &mut process);
    if process == 0 {
        return None;
    }
    let candidate_monitor = MonitorFromWindow(candidate, MONITOR_DEFAULTTONULL);
    if candidate_monitor.is_null() {
        return None;
    }
    if process == GetCurrentProcessId() || candidate_monitor != monitor {
        return Some(false);
    }
    let mut class = [0u16; 128];
    let len = GetClassNameW(candidate, class.as_mut_ptr(), class.len() as i32);
    if len <= 0 {
        return None;
    }
    if matches!(
        String::from_utf16_lossy(&class[..len as usize]).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return Some(false);
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(
        candidate,
        DWMWA_CLOAKED as u32,
        (&mut cloaked as *mut u32).cast(),
        size_of::<u32>() as u32,
    ) >= 0
        && cloaked != 0
    {
        return Some(false);
    }
    // Maximizing a normal captioned app with an auto-hide taskbar is not fullscreen.
    if IsZoomed(candidate) != 0 && GetWindowLongW(candidate, GWL_STYLE) as u32 & WS_CAPTION != 0 {
        return Some(false);
    }
    let mut frame: RECT = std::mem::zeroed();
    if DwmGetWindowAttribute(
        candidate,
        DWMWA_EXTENDED_FRAME_BOUNDS as u32,
        (&mut frame as *mut RECT).cast(),
        size_of::<RECT>() as u32,
    ) < 0
        && GetWindowRect(candidate, &mut frame) == 0
    {
        return None;
    }
    Some(covers_monitor(rect(frame), bounds))
}

pub fn inspect(own: HWND, fallback_scale: f64, selected: Rect) -> Option<Display> {
    // All pointers refer to initialized stack records of the exact documented
    // size. Handles are borrowed only for this call; every fallible read checked.
    unsafe {
        let monitor = MonitorFromPoint(
            POINT {
                x: (selected.x + selected.width / 2.0).round() as i32,
                y: (selected.y + selected.height / 2.0).round() as i32,
            },
            MONITOR_DEFAULTTONEAREST,
        );
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let bounds = rect(info.rcMonitor);
        let mut work = rect(info.rcWork);
        if work.width <= 0.0 || work.height <= 0.0 {
            return None;
        }
        for (native_edge, edge) in [
            (ABE_LEFT, Edge::Left),
            (ABE_TOP, Edge::Top),
            (ABE_RIGHT, Edge::Right),
            (ABE_BOTTOM, Edge::Bottom),
        ] {
            let mut appbar: APPBARDATA = std::mem::zeroed();
            appbar.cbSize = size_of::<APPBARDATA>() as u32;
            appbar.uEdge = native_edge;
            appbar.rc = info.rcMonitor;
            let bar = SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut appbar) as HWND;
            if !bar.is_null() && IsWindowVisible(bar) != 0 {
                let mut bar_rect: RECT = std::mem::zeroed();
                if GetWindowRect(bar, &mut bar_rect) != 0 {
                    work = reserve_autohide_bar(work, bounds, rect(bar_rect), edge);
                }
            }
        }
        Some(Display {
            work,
            // Tauri reports this selected monitor's DPI, even before the
            // HWND has moved there and processed WM_DPICHANGED.
            scale: fallback_scale,
            fullscreen: foreground_fullscreen(own, monitor, bounds),
        })
    }
}
