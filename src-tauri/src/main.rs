#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use companion_core::{
    bridge::{self, BridgeConfig, BridgeHandle, SecretToken},
    BridgeStatus, Observer, Snapshot,
};
use companion_shell::{
    export_observer, fit_window, load_or_create_connection, minimum_size_for_work_area,
    preset_size,
    taskbar::{strip_rect, OfficeSnapshot, Visibility, VisibilityAction},
    Rect, WindowMode, WindowState, RECOVERY_SHORTCUT,
};
#[cfg(windows)]
mod windows_probe;

use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeView {
    status: BridgeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observer_entry: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionState {
    sequence: u64,
    snapshot: Snapshot,
    bridge: BridgeView,
    window: WindowState,
}
struct ViewState {
    sequence: u64,
    window: WindowState,
    message: Option<String>,
    connection_file: Option<String>,
    observer_entry: Option<String>,
}
#[derive(Default)]
struct NativeState {
    office: Option<OfficeSnapshot>,
    visibility: Visibility,
    // The app owns all changes to this property; Tauri has no getter.
    skip_taskbar: bool,
}
struct Shared {
    observer: Observer,
    view: Mutex<ViewState>,
    bridge: Mutex<Option<BridgeHandle>>,
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    stopping: AtomicBool,
    fitting: AtomicBool,
    minimum_size: Mutex<Option<(u32, u32)>>,
    native: Mutex<NativeState>,
    layout_queued: AtomicBool,
}
impl Shared {
    fn envelope(&self) -> Result<CompanionState, String> {
        // Capture the snapshot under the same ordering lock as its sequence.
        // Otherwise an older snapshot could be assigned a newer sequence.
        let mut view = self.view.lock().map_err(|_| "View state unavailable")?;
        let snapshot = self.observer.snapshot();
        view.sequence = view.sequence.saturating_add(1);
        Ok(CompanionState {
            sequence: view.sequence,
            bridge: BridgeView {
                status: snapshot.bridge_status,
                message: view.message.clone(),
                connection_file: view.connection_file.clone(),
                observer_entry: view.observer_entry.clone(),
            },
            snapshot,
            window: view.window.clone(),
        })
    }
    fn message(&self, message: &str) {
        if let Ok(mut view) = self.view.lock() {
            view.message = Some(message.into());
        }
    }
    fn stop(&self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut tasks) = self.tasks.lock() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
        // BridgeHandle::drop stops both listener and expiry ticker.
        if let Ok(mut bridge) = self.bridge.lock() {
            bridge.take();
        }
        self.observer.set_bridge_status(BridgeStatus::Stopped);
    }
}
fn emit_state(app: &tauri::AppHandle) {
    if let Some(shared) = app.try_state::<Shared>() {
        if !shared.stopping.load(Ordering::Acquire) {
            if let Ok(state) = shared.envelope() {
                let _ = app.emit_to("main", "companion-state", state);
            }
        }
    }
}
fn main_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Companion window unavailable".into())
}

/// Native actions are serialized by the event loop. Commands await completion;
/// callbacks enqueue bounded work rather than touching HWNDs from worker threads.
async fn on_main_thread(
    app: tauri::AppHandle,
    action: impl FnOnce(&tauri::AppHandle) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = send.send(action(&handle));
    })
    .map_err(|_| "Native event loop unavailable")?;
    receive.await.map_err(|_| "Native action interrupted")?
}
fn queue_native(
    app: &tauri::AppHandle,
    action: impl FnOnce(&tauri::AppHandle) -> Result<(), String> + Send + 'static,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(shared) = handle.try_state::<Shared>() else {
            return;
        };
        if shared.stopping.load(Ordering::Acquire) {
            return;
        }
        if let Err(message) = action(&handle) {
            shared.message(&message);
            emit_state(&handle);
        }
    });
}
struct FitGuard<'a>(&'a AtomicBool);
impl Drop for FitGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct DisplayLayout {
    work: Rect,
    scale: f64,
    fullscreen: Option<bool>,
}
fn display_layout(window: &WebviewWindow) -> Result<DisplayLayout, String> {
    let monitor = match window
        .current_monitor()
        .map_err(|_| "Cannot inspect monitor")?
    {
        Some(monitor) => monitor,
        None => window
            .primary_monitor()
            .map_err(|_| "Cannot inspect primary monitor")?
            .ok_or("No monitor available")?,
    };
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|_| "Cannot inspect native window")?;
        if let Some(display) = windows_probe::inspect(hwnd.0, monitor.scale_factor()) {
            return Ok(DisplayLayout {
                work: display.work,
                scale: display.scale,
                fullscreen: display.fullscreen,
            });
        }
        // A failed native read is not evidence that fullscreen has ended. Keep
        // the existing visibility decision and retry on the next layout tick.
        Err("Cannot inspect Windows work area".into())
    }
    #[cfg(not(windows))]
    {
        let area = monitor.work_area();
        Ok(DisplayLayout {
            work: Rect {
                x: area.position.x.into(),
                y: area.position.y.into(),
                width: area.size.width.into(),
                height: area.size.height.into(),
            },
            scale: monitor.scale_factor(),
            fullscreen: Some(false),
        })
    }
}
fn current_rect(window: &WebviewWindow) -> Result<Rect, String> {
    let position = window
        .outer_position()
        .map_err(|_| "Cannot inspect window position")?;
    let size = window
        .outer_size()
        .map_err(|_| "Cannot inspect window size")?;
    Ok(Rect {
        x: position.x.into(),
        y: position.y.into(),
        width: size.width.into(),
        height: size.height.into(),
    })
}
fn apply_rect(window: &WebviewWindow, target: Rect) -> Result<(), String> {
    let before = current_rect(window)?;
    if target.width.round() as u32 != before.width as u32
        || target.height.round() as u32 != before.height as u32
    {
        window
            .set_size(PhysicalSize::new(
                target.width.round() as u32,
                target.height.round() as u32,
            ))
            .map_err(|_| "Cannot fit window size")?;
    }
    if target.x.round() as i32 != before.x as i32 || target.y.round() as i32 != before.y as i32 {
        window
            .set_position(PhysicalPosition::new(
                target.x.round() as i32,
                target.y.round() as i32,
            ))
            .map_err(|_| "Cannot fit window position")?;
    }
    Ok(())
}
fn set_minimum(
    window: &WebviewWindow,
    shared: &Shared,
    minimum: Option<(u32, u32)>,
) -> Result<(), String> {
    if *shared
        .minimum_size
        .lock()
        .map_err(|_| "Window state unavailable")?
        != minimum
    {
        window
            .set_min_size(minimum.map(|(width, height)| PhysicalSize::new(width, height)))
            .map_err(|_| "Cannot adjust minimum window size")?;
        *shared
            .minimum_size
            .lock()
            .map_err(|_| "Window state unavailable")? = minimum;
    }
    Ok(())
}
fn fit_office(
    window: &WebviewWindow,
    shared: &Shared,
    display: &DisplayLayout,
) -> Result<(), String> {
    let minimum = minimum_size_for_work_area(
        display.scale,
        display.work.width.max(1.0) as u32,
        display.work.height.max(1.0) as u32,
    );
    set_minimum(window, shared, Some(minimum))?;
    apply_rect(window, fit_window(current_rect(window)?, display.work))
}
fn show_without_focus(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            IsWindowVisible, ShowWindow, SW_SHOWNOACTIVATE,
        };
        let hwnd = window.hwnd().map_err(|_| "Cannot inspect native window")?.0;
        // SW_SHOWNOACTIVATE explicitly preserves the user's foreground window.
        // ShowWindow's return value is previous visibility, not a success flag.
        unsafe {
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            if IsWindowVisible(hwnd) == 0 {
                return Err("Could not show companion without activation".into());
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        window.show().map_err(|_| "Could not show companion".into())
    }
}
fn apply_visibility(
    window: &WebviewWindow,
    shared: &Shared,
    mode: WindowMode,
    fullscreen: Option<bool>,
) -> Result<(), String> {
    let before = shared
        .native
        .lock()
        .map_err(|_| "Window state unavailable")?
        .visibility;
    let (next, action) = before.observed(mode, fullscreen);
    match action {
        VisibilityAction::None => {}
        VisibilityAction::Hide => window
            .hide()
            .map_err(|_| "Could not hide companion for fullscreen")?,
        VisibilityAction::ShowWithoutFocus => show_without_focus(window)?,
    }
    if before != next {
        shared
            .native
            .lock()
            .map_err(|_| "Window state unavailable")?
            .visibility = next;
        shared
            .view
            .lock()
            .map_err(|_| "Window state unavailable")?
            .window
            .fullscreen_hidden = next.fullscreen_hidden;
        emit_state(window.app_handle());
    }
    Ok(())
}
fn fit_to_monitor(window: &WebviewWindow) -> Result<(), String> {
    let shared = window
        .app_handle()
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    if shared.stopping.load(Ordering::Acquire) || shared.fitting.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let _guard = FitGuard(&shared.fitting);
    let mode = shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .mode;
    let display = display_layout(window)?;
    if mode == WindowMode::Taskbar {
        set_minimum(window, &shared, Some((1, 1)))?;
        apply_rect(window, strip_rect(display.work, display.scale))?;
    } else {
        let pending = shared
            .native
            .lock()
            .map_err(|_| "Window state unavailable")?
            .office;
        if let Some(saved) = pending {
            // Recovery may have restored input but encountered a transient
            // geometry/style error. Retry safely without re-entering the strip.
            apply_office_snapshot(window, &shared, saved)?;
            shared
                .native
                .lock()
                .map_err(|_| "Window state unavailable")?
                .office = None;
        } else {
            fit_office(window, &shared, &display)?;
        }
    }
    apply_visibility(window, &shared, mode, display.fullscreen)
}
/// Attempt every restoration step even if one fails. Keep the snapshot until all
/// steps succeed so the tray/hotkey can retry after a partial native failure.
fn apply_office_snapshot(
    window: &WebviewWindow,
    shared: &Shared,
    saved: OfficeSnapshot,
) -> Result<(), String> {
    let mut first_error = None;
    let mut attempt = |result: Result<(), String>| {
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    };
    attempt(set_minimum(window, shared, Some((1, 1))));
    attempt(
        window
            .set_resizable(saved.resizable)
            .map_err(|_| "Could not restore Office resizing".into()),
    );
    attempt(
        window
            .set_skip_taskbar(saved.skip_taskbar)
            .map_err(|_| "Could not restore Office taskbar entry".into()),
    );
    attempt(
        window
            .set_always_on_top(saved.pinned)
            .map_err(|_| "Could not restore Office pin preference".into()),
    );
    attempt(apply_rect(window, saved.rect));
    attempt(set_minimum(window, shared, saved.minimum));
    // Restore the physical Office rectangle first, then fit the monitor it now
    // belongs to (or the nearest surviving monitor after removal).
    match display_layout(window) {
        Ok(display) => attempt(fit_office(window, shared, &display)),
        Err(error) => attempt(Err(error)),
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    shared
        .native
        .lock()
        .map_err(|_| "Window state unavailable")?
        .skip_taskbar = saved.skip_taskbar;
    Ok(())
}
fn change_mode(app: &tauri::AppHandle, mode: WindowMode) -> Result<(), String> {
    let shared = app
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    if shared.stopping.load(Ordering::Acquire) {
        return Ok(());
    }
    let state = shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .clone();
    if !state.can_enter_mode(mode) {
        return Err("Taskbar mode requires a working tray or recovery shortcut".into());
    }
    let pending_snapshot = shared
        .native
        .lock()
        .map_err(|_| "Window state unavailable")?
        .office;
    if state.mode == mode && !(mode == WindowMode::Office && pending_snapshot.is_some()) {
        return Ok(());
    }
    if shared.fitting.swap(true, Ordering::AcqRel) {
        return Err("Window layout is updating; try again".into());
    }
    let guard = FitGuard(&shared.fitting);
    let window = main_window(app)?;
    match mode {
        WindowMode::Taskbar => {
            if let Some(saved) = pending_snapshot {
                // Never replace the original Office snapshot with a partially
                // mutated strip left by a failed entry/rollback.
                apply_office_snapshot(&window, &shared, saved)?;
                shared
                    .native
                    .lock()
                    .map_err(|_| "Window state unavailable")?
                    .office = None;
            }
            let display = display_layout(&window)?;
            let saved = OfficeSnapshot {
                rect: current_rect(&window)?,
                pinned: state.pinned,
                resizable: window
                    .is_resizable()
                    .map_err(|_| "Cannot inspect resizing state")?,
                minimum: *shared
                    .minimum_size
                    .lock()
                    .map_err(|_| "Window state unavailable")?,
                skip_taskbar: shared
                    .native
                    .lock()
                    .map_err(|_| "Window state unavailable")?
                    .skip_taskbar,
            };
            shared
                .native
                .lock()
                .map_err(|_| "Window state unavailable")?
                .office = Some(saved);
            let enter = (|| -> Result<(), String> {
                set_minimum(&window, &shared, Some((1, 1)))?;
                window
                    .set_resizable(false)
                    .map_err(|_| "Could not lock strip height")?;
                window
                    .set_skip_taskbar(true)
                    .map_err(|_| "Could not hide strip taskbar entry")?;
                window
                    .set_always_on_top(true)
                    .map_err(|_| "Could not keep strip above desktop")?;
                apply_rect(&window, strip_rect(display.work, display.scale))?;
                Ok(())
            })();
            if let Err(error) = enter {
                let rolled_back = apply_office_snapshot(&window, &shared, saved).is_ok();
                if rolled_back {
                    shared
                        .native
                        .lock()
                        .map_err(|_| "Window state unavailable")?
                        .office = None;
                }
                return Err(if rolled_back {
                    error
                } else {
                    format!("{error}. Use Restore to retry Office recovery.")
                });
            }
            shared
                .native
                .lock()
                .map_err(|_| "Window state unavailable")?
                .skip_taskbar = true;
        }
        WindowMode::Office => {
            if let Some(saved) = pending_snapshot {
                apply_office_snapshot(&window, &shared, saved)?;
                shared
                    .native
                    .lock()
                    .map_err(|_| "Window state unavailable")?
                    .office = None;
            }
        }
    }
    shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .mode = mode;
    drop(guard);
    // No focus change and no forced click-through. Explicitly hidden windows
    // remain hidden; only fullscreen-owned hiding may restore automatically.
    if let Err(error) = fit_to_monitor(&window) {
        shared.message(&error);
    }
    emit_state(app);
    Ok(())
}
fn restore(app: &tauri::AppHandle) -> Result<(), String> {
    let shared = app
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    if shared.stopping.load(Ordering::Acquire) {
        return Ok(());
    }
    let window = main_window(app)?;
    // Input recovery comes first, even if a subsequent monitor query fails.
    window
        .set_ignore_cursor_events(false)
        .map_err(|_| "Could not restore input")?;
    shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .click_through = false;
    let office_result = change_mode(app, WindowMode::Office);
    shared
        .native
        .lock()
        .map_err(|_| "Window state unavailable")?
        .visibility
        .restore_by_user();
    // Recovery always selects Office, including when native restoration needs
    // another attempt. Otherwise the next poll could put the user back into a
    // hidden strip immediately after the recovery shortcut.
    shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .restored();
    window
        .unminimize()
        .map_err(|_| "Could not restore window")?;
    window.show().map_err(|_| "Could not show window")?;
    if let Err(error) = office_result {
        shared.message(&format!("Input restored. {error}"));
    } else if fit_to_monitor(&window).is_err() {
        shared.message("Window restored; monitor layout could not be checked.");
    }
    window.set_focus().map_err(|_| "Could not focus window")?;
    emit_state(app);
    Ok(())
}
fn change_pinned(app: &tauri::AppHandle, pinned: bool) -> Result<(), String> {
    let shared = app
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    let mode = shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .mode;
    main_window(app)?
        .set_always_on_top(pinned || mode == WindowMode::Taskbar)
        .map_err(|_| "Could not change pin state")?;
    shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .pinned = pinned;
    if let Some(saved) = shared
        .native
        .lock()
        .map_err(|_| "Window state unavailable")?
        .office
        .as_mut()
    {
        saved.pinned = pinned;
    }
    emit_state(app);
    Ok(())
}
fn change_click_through(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let shared = app
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    if !shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .can_click_through(enabled)
    {
        return Err("Click-through requires a working tray or recovery shortcut".into());
    }
    main_window(app)?
        .set_ignore_cursor_events(enabled)
        .map_err(|_| "Could not change input mode")?;
    shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .click_through = enabled;
    emit_state(app);
    Ok(())
}
fn hide_by_user(app: &tauri::AppHandle) -> Result<(), String> {
    let shared = app
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    if !shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .can_hide()
    {
        return Err("Hiding requires a working tray or recovery shortcut".into());
    }
    main_window(app)?
        .hide()
        .map_err(|_| "Could not hide window")?;
    shared
        .native
        .lock()
        .map_err(|_| "Window state unavailable")?
        .visibility
        .hide_by_user();
    shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .fullscreen_hidden = false;
    emit_state(app);
    Ok(())
}
#[tauri::command]
fn get_state(state: State<'_, Shared>) -> Result<CompanionState, String> {
    state.envelope()
}
#[tauri::command]
async fn set_window_mode(app: tauri::AppHandle, mode: WindowMode) -> Result<(), String> {
    on_main_thread(app, move |app| change_mode(app, mode)).await
}
#[tauri::command]
async fn set_pinned(app: tauri::AppHandle, pinned: bool) -> Result<(), String> {
    on_main_thread(app, move |app| change_pinned(app, pinned)).await
}
#[tauri::command]
async fn set_click_through(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    on_main_thread(app, move |app| change_click_through(app, enabled)).await
}
#[tauri::command]
async fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    on_main_thread(app, hide_by_user).await
}
#[tauri::command]
async fn restore_window(app: tauri::AppHandle) -> Result<(), String> {
    on_main_thread(app, restore).await
}
#[tauri::command]
async fn start_dragging(app: tauri::AppHandle) -> Result<(), String> {
    on_main_thread(app, |app| {
        let shared = app
            .try_state::<Shared>()
            .ok_or("Window state unavailable")?;
        if shared
            .view
            .lock()
            .map_err(|_| "Window state unavailable")?
            .window
            .mode
            == WindowMode::Taskbar
        {
            return Ok(());
        }
        main_window(app)?
            .start_dragging()
            .map_err(|_| "Could not move window".into())
    })
    .await
}
#[tauri::command]
async fn resize_window(app: tauri::AppHandle, preset: String) -> Result<(), String> {
    on_main_thread(app, move |app| {
        let shared = app
            .try_state::<Shared>()
            .ok_or("Window state unavailable")?;
        if shared
            .view
            .lock()
            .map_err(|_| "Window state unavailable")?
            .window
            .mode
            != WindowMode::Office
        {
            return Err("Office sizes are unavailable in taskbar mode".into());
        }
        let (width, height) = preset_size(&preset).ok_or("Unknown window size")?;
        let window = main_window(app)?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|_| "Could not resize window")?;
        fit_to_monitor(&window)
    })
    .await
}
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(
        app,
        "restore",
        "Restore Office / restore input",
        true,
        None::<&str>,
    )?;
    let office = MenuItem::with_id(app, "office", "Office mode", true, None::<&str>)?;
    let taskbar = MenuItem::with_id(app, "taskbar", "Taskbar strip mode", true, None::<&str>)?;
    let pass_through = MenuItem::with_id(
        app,
        "click-through",
        "Toggle click-through",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit companion", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &office, &taskbar, &pass_through, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
    TrayIconBuilder::with_id("companion")
        .icon(icon)
        .tooltip("Pi Companion · read-only observer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "restore" | "office" => queue_native(app, restore),
            "taskbar" => queue_native(app, |app| {
                change_mode(app, WindowMode::Taskbar)?;
                let shared = app
                    .try_state::<Shared>()
                    .ok_or("Window state unavailable")?;
                let window = main_window(app)?;
                // An explicit show gets a fresh probe before changing the
                // visibility owner; failed probes leave user-hidden untouched.
                let display = display_layout(&window)?;
                let (next, action) = Visibility::requested_show(
                    WindowMode::Taskbar,
                    display.fullscreen.ok_or(
                        "Cannot inspect foreground window; use Restore or retry Taskbar mode",
                    )?,
                );
                match action {
                    VisibilityAction::Hide => window
                        .hide()
                        .map_err(|_| "Could not hide strip for fullscreen")?,
                    VisibilityAction::ShowWithoutFocus => show_without_focus(&window)?,
                    VisibilityAction::None => {}
                }
                shared
                    .native
                    .lock()
                    .map_err(|_| "Window state unavailable")?
                    .visibility = next;
                shared
                    .view
                    .lock()
                    .map_err(|_| "Window state unavailable")?
                    .window
                    .fullscreen_hidden = next.fullscreen_hidden;
                emit_state(app);
                fit_to_monitor(&window)
            }),
            "click-through" => queue_native(app, |app| {
                let shared = app
                    .try_state::<Shared>()
                    .ok_or("Window state unavailable")?;
                let enabled = !shared
                    .view
                    .lock()
                    .map_err(|_| "Window state unavailable")?
                    .window
                    .click_through;
                change_click_through(app, enabled)
            }),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                queue_native(tray.app_handle(), restore);
            }
        })
        .build(app)?;
    Ok(())
}
/// Coalesce event-driven and timer-driven layout requests into one pending job.
fn queue_layout(app: &tauri::AppHandle) -> Result<(), String> {
    let shared = app
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    if shared.stopping.load(Ordering::Acquire) || shared.layout_queued.swap(true, Ordering::AcqRel)
    {
        return Ok(());
    }
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let Some(shared) = handle.try_state::<Shared>() else {
                return;
            };
            // Keep the gate set while native mutations emit additional layout events.
            let _pending = FitGuard(&shared.layout_queued);
            if shared.stopping.load(Ordering::Acquire) {
                return;
            }
            if let Some(window) = handle.get_webview_window("main") {
                let _ = fit_to_monitor(&window);
            }
        })
        .is_err()
    {
        shared.layout_queued.store(false, Ordering::Release);
        return Err("Native event loop unavailable".into());
    }
    Ok(())
}
/// Sleep does no native work; every HWND probe and layout/visibility mutation is
/// dispatched to the main thread. Shared::stop aborts this task during exit.
fn start_layout_poll(app: &tauri::AppHandle) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            let Some(shared) = app.try_state::<Shared>() else {
                break;
            };
            if shared.stopping.load(Ordering::Acquire) || queue_layout(&app).is_err() {
                break;
            }
        }
    })
}
fn main() {
    let observer = Observer::new();
    observer.set_bridge_status(BridgeStatus::Starting);
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { queue_native(app, restore); }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state() == ShortcutState::Pressed { queue_native(app, restore); }
        }).build())
        .manage(Shared {
            observer,
            view: Mutex::new(ViewState { sequence: 0, window: WindowState::default(), message: None, connection_file: None, observer_entry: None }),
            bridge: Mutex::new(None), tasks: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false), fitting: AtomicBool::new(false), minimum_size: Mutex::new(None),
            native: Mutex::new(NativeState::default()), layout_queued: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![get_state, set_pinned, set_window_mode, set_click_through, hide_window, restore_window, resize_window, start_dragging])
        .setup(|app| {
            let handle = app.handle().clone();
            let tray_ok = setup_tray(&handle).is_ok();
            let shortcut_ok = app.global_shortcut().register(RECOVERY_SHORTCUT).is_ok();
            {
                let shared = app.state::<Shared>();
                let mut view = shared.view.lock().map_err(|_| "View state unavailable")?;
                view.window.recovery_available = tray_ok || shortcut_ok;
                if !shortcut_ok { view.message = Some("Recovery shortcut unavailable. Use the tray to restore input.".into()); }
                if !tray_ok && !shortcut_ok { view.message = Some("Tray and recovery shortcut unavailable. Hide and click-through are disabled.".into()); }
            }
            if let Some(window) = app.get_webview_window("main") {
                let h = handle.clone();
                window.on_window_event(move |event| {
                    let Some(shared) = h.try_state::<Shared>() else { return; };
                    if shared.stopping.load(Ordering::Acquire) { return; }
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            // Close-to-tray requires a real tray with a Quit item. A
                            // shortcut alone must not remove the ordinary exit route.
                            if shared.view.lock().is_ok_and(|view| view.window.can_close_to_tray(tray_ok)) {
                                api.prevent_close();
                                queue_native(&h, hide_by_user);
                            }
                        }
                        WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::Focused(true) => {
                            if !shared.fitting.load(Ordering::Acquire) { let _ = queue_layout(&h); }
                        }
                        _ => {}
                    }
                });
                let _ = fit_to_monitor(&window);
            }
            let layout_task = start_layout_poll(&handle);
            let mut changes = app.state::<Shared>().observer.subscribe();
            let delivery = handle.clone();
            let deliver_task = tauri::async_runtime::spawn(async move {
                while changes.changed().await.is_ok() { emit_state(&delivery); }
            });
            let bridge_task = tauri::async_runtime::spawn(async move {
                let Some(shared) = handle.try_state::<Shared>() else { return; };
                if shared.stopping.load(Ordering::Acquire) { return; }
                let directory = match handle.path().app_config_dir() {
                    Ok(directory) => directory,
                    Err(_) => {
                        shared.message("Could not locate the per-user application configuration directory.");
                        shared.observer.set_bridge_status(BridgeStatus::Error);
                        emit_state(&handle);
                        return;
                    }
                };
                let connection = match load_or_create_connection(&directory) {
                    Ok(connection) => connection,
                    Err(_) => {
                        shared.message("Could not open a private observer connection file. Check ownership and private access in the app configuration directory. Existing files were left unchanged.");
                        shared.observer.set_bridge_status(BridgeStatus::Error);
                        emit_state(&handle);
                        return;
                    }
                };
                if let Ok(mut view) = shared.view.lock() {
                    view.connection_file = Some(directory.join("connection.json").to_string_lossy().into_owned());
                }
                match export_observer(&directory) {
                    Ok(entry) => {
                        if let Ok(mut view) = shared.view.lock() {
                            view.observer_entry = Some(entry.to_string_lossy().into_owned());
                        }
                    }
                    Err(_) => {
                        shared.message(&format!("Could not prepare the observer extension in {}. Check that this directory and its files are private, owned by you, and not links, then restart Companion. The connection credential and Pi settings were left unchanged.", directory.join("observer").display()));
                        shared.observer.set_bridge_status(BridgeStatus::Error);
                        emit_state(&handle);
                        return;
                    }
                }
                let token = match SecretToken::new(connection.token) {
                    Ok(token) => token,
                    Err(_) => { shared.observer.set_bridge_status(BridgeStatus::Error); emit_state(&handle); return; }
                };
                match bridge::start(shared.observer.clone(), BridgeConfig::new(token)).await {
                    Ok(server) => {
                        if let Ok(mut slot) = shared.bridge.lock() {
                            // Exit and startup can race. Never install a listener after exit.
                            if !shared.stopping.load(Ordering::Acquire) { *slot = Some(server); }
                        }
                    }
                    Err(_) => {
                        shared.message("Local bridge could not start on port 4318. Another program was left untouched.");
                        shared.observer.set_bridge_status(BridgeStatus::Error);
                    }
                }
                emit_state(&handle);
            });
            app.state::<Shared>().tasks.lock().map_err(|_| "Task state unavailable")?.extend([deliver_task, bridge_task, layout_task]);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Pi Companion could not initialize");
    application.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            if let Some(shared) = app.try_state::<Shared>() {
                shared.stop();
            }
            // Do this while the event loop still accepts main-thread work.
            let _ = app.global_shortcut().unregister_all();
        }
        tauri::RunEvent::Exit => {
            if let Some(shared) = app.try_state::<Shared>() {
                shared.stop();
            }
        }
        tauri::RunEvent::Resumed => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = fit_to_monitor(&window);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shared() -> Shared {
        Shared {
            observer: Observer::new(),
            view: Mutex::new(ViewState {
                sequence: 0,
                window: WindowState::default(),
                message: None,
                connection_file: None,
                observer_entry: None,
            }),
            bridge: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false),
            fitting: AtomicBool::new(false),
            minimum_size: Mutex::new(None),
            native: Mutex::new(NativeState::default()),
            layout_queued: AtomicBool::new(false),
        }
    }
    #[test]
    fn envelopes_are_ordered_without_native_runtime() {
        let shared = shared();
        assert_eq!(shared.envelope().unwrap().sequence, 1);
        assert_eq!(shared.envelope().unwrap().sequence, 2);
    }
    #[test]
    fn stopping_is_idempotent_without_starting_bridge() {
        let shared = shared();
        shared.stop();
        shared.stop();
        assert!(shared.stopping.load(Ordering::Acquire));
        assert!(matches!(
            shared.observer.snapshot().bridge_status,
            BridgeStatus::Stopped
        ));
    }
}
