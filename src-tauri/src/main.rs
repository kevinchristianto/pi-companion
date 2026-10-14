#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use companion_core::{
    bridge::{self, BridgeConfig, BridgeHandle, SecretToken},
    BridgeStatus, Observer, Snapshot,
};
use companion_shell::{
    export_observer, fit_window, load_or_create_connection, preset_size, Rect, WindowState,
    RECOVERY_SHORTCUT,
};
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
struct Shared {
    observer: Observer,
    view: Mutex<ViewState>,
    bridge: Mutex<Option<BridgeHandle>>,
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    stopping: AtomicBool,
    fitting: AtomicBool,
    minimum_size: Mutex<Option<(u32, u32)>>,
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

fn fit_to_monitor(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let shared = app
        .try_state::<Shared>()
        .ok_or("Window state unavailable")?;
    if shared.stopping.load(Ordering::Acquire) || shared.fitting.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    struct FitGuard<'a>(&'a AtomicBool);
    impl Drop for FitGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let _guard = FitGuard(&shared.fitting);
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
    let area = monitor.work_area();
    if area.size.width == 0 || area.size.height == 0 {
        return Ok(());
    }
    let pos = window
        .outer_position()
        .map_err(|_| "Cannot inspect window position")?;
    let size = window
        .outer_size()
        .map_err(|_| "Cannot inspect window size")?;
    let target = fit_window(
        Rect {
            x: f64::from(pos.x),
            y: f64::from(pos.y),
            width: f64::from(size.width),
            height: f64::from(size.height),
        },
        Rect {
            x: f64::from(area.position.x),
            y: f64::from(area.position.y),
            width: f64::from(area.size.width),
            height: f64::from(area.size.height),
        },
    );
    // Configuration minima are logical; monitor work areas are physical. Restore
    // the original logical minimum when moving from a tiny screen back to a large one.
    let scale = monitor.scale_factor();
    let minimum = (
        ((360.0 * scale).round() as u32).min(area.size.width),
        ((320.0 * scale).round() as u32).min(area.size.height),
    );
    let changed = shared
        .minimum_size
        .lock()
        .map_err(|_| "Window state unavailable")?
        .as_ref()
        != Some(&minimum);
    if changed {
        window
            .set_min_size(Some(PhysicalSize::new(minimum.0, minimum.1)))
            .map_err(|_| "Cannot adjust minimum window size")?;
        *shared
            .minimum_size
            .lock()
            .map_err(|_| "Window state unavailable")? = Some(minimum);
    }
    if target.width as u32 != size.width || target.height as u32 != size.height {
        window
            .set_size(PhysicalSize::new(target.width as u32, target.height as u32))
            .map_err(|_| "Cannot fit window size")?;
    }
    if target.x as i32 != pos.x || target.y as i32 != pos.y {
        window
            .set_position(PhysicalPosition::new(target.x as i32, target.y as i32))
            .map_err(|_| "Cannot fit window position")?;
    }
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
    window
        .set_ignore_cursor_events(false)
        .map_err(|_| "Could not restore input")?;
    shared
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .restored();
    emit_state(app);
    window
        .unminimize()
        .map_err(|_| "Could not restore window")?;
    window.show().map_err(|_| "Could not show window")?;
    // A transient monitor query failure must not prevent input recovery/show.
    if fit_to_monitor(&window).is_err() {
        shared.message("Window restored; monitor layout could not be checked.");
    }
    window.set_focus().map_err(|_| "Could not focus window")?;
    emit_state(app);
    Ok(())
}
#[tauri::command]
fn get_state(state: State<'_, Shared>) -> Result<CompanionState, String> {
    state.envelope()
}
#[tauri::command]
fn set_pinned(app: tauri::AppHandle, state: State<'_, Shared>, pinned: bool) -> Result<(), String> {
    main_window(&app)?
        .set_always_on_top(pinned)
        .map_err(|_| "Could not change pin state")?;
    state
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .pinned = pinned;
    emit_state(&app);
    Ok(())
}
#[tauri::command]
fn set_click_through(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    enabled: bool,
) -> Result<(), String> {
    if !state
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .can_click_through(enabled)
    {
        return Err("Click-through requires a working tray or recovery shortcut".into());
    }
    main_window(&app)?
        .set_ignore_cursor_events(enabled)
        .map_err(|_| "Could not change input mode")?;
    state
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .click_through = enabled;
    emit_state(&app);
    Ok(())
}
#[tauri::command]
fn hide_window(app: tauri::AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    if !state
        .view
        .lock()
        .map_err(|_| "Window state unavailable")?
        .window
        .can_hide()
    {
        return Err("Hiding requires a working tray or recovery shortcut".into());
    }
    main_window(&app)?
        .hide()
        .map_err(|_| "Could not hide window".into())
}
#[tauri::command]
fn restore_window(app: tauri::AppHandle) -> Result<(), String> {
    restore(&app)
}
#[tauri::command]
fn start_dragging(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?
        .start_dragging()
        .map_err(|_| "Could not move window".into())
}
#[tauri::command]
fn resize_window(app: tauri::AppHandle, preset: String) -> Result<(), String> {
    let (width, height) = preset_size(&preset).ok_or("Unknown window size")?;
    let window = main_window(&app)?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "Could not resize window")?;
    fit_to_monitor(&window)
}
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(
        app,
        "restore",
        "Show companion / restore input",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit companion", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
    TrayIconBuilder::with_id("companion")
        .icon(icon)
        .tooltip("Pi Companion · read-only observer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "restore" => {
                let _ = restore(app);
            }
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
                let _ = restore(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
fn main() {
    let observer = Observer::new();
    observer.set_bridge_status(BridgeStatus::Starting);
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { let _ = restore(app); }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state() == ShortcutState::Pressed { let _ = restore(app); }
        }).build())
        .manage(Shared {
            observer,
            view: Mutex::new(ViewState { sequence: 0, window: WindowState::default(), message: None, connection_file: None, observer_entry: None }),
            bridge: Mutex::new(None), tasks: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false), fitting: AtomicBool::new(false), minimum_size: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_state, set_pinned, set_click_through, hide_window, restore_window, resize_window, start_dragging])
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
                                if let Some(window) = h.get_webview_window("main") { let _ = window.hide(); }
                            }
                        }
                        WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::Focused(true) => {
                            if let Some(window) = h.get_webview_window("main") { let _ = fit_to_monitor(&window); }
                        }
                        _ => {}
                    }
                });
                let _ = fit_to_monitor(&window);
            }
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
            app.state::<Shared>().tasks.lock().map_err(|_| "Task state unavailable")?.extend([deliver_task, bridge_task]);
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
