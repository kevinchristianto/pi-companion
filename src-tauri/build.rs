fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_state",
            "set_pinned",
            "set_window_mode",
            "set_click_through",
            "hide_window",
            "restore_window",
            "resize_window",
            "start_dragging",
        ]),
    ))
    .expect("Tauri configuration must validate");
}
