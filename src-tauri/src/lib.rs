mod fonts;
mod storage;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .manage(storage::RecentMenuState::default())
        .manage(storage::ProjectRoot::default())
        .menu(|app| storage::build_menu(app, &[]))
        .on_menu_event(|app, event| storage::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            fonts::list_system_fonts,
            storage::storage_pick_project_folder,
            storage::storage_open_recent_root,
            storage::storage_restore_project_root,
            storage::storage_clear_project_root,
            storage::storage_write_file_atomic,
            storage::storage_read_text_file,
            storage::storage_path_exists,
            storage::storage_ensure_dir,
            storage::storage_remove_file,
            storage::storage_read_recent,
            storage::storage_remember_recent,
            storage::storage_set_recent_menu,
            storage::storage_exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Novel")
        .run(|app, event| {
            // Quit paths other than our menu item (e.g. macOS Dock > Quit) must
            // also go through the frontend's unsaved-changes flow.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if !storage::allow_exit(code, app.webview_windows().len()) {
                    api.prevent_exit();
                    if let Err(e) = app.emit(storage::EVENT_QUIT, ()) {
                        eprintln!("failed to emit quit request: {e}");
                    }
                }
            }
        });
}
