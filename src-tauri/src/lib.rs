mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .manage(storage::RecentMenuState::default())
        .menu(|app| storage::build_menu(app, &[]))
        .on_menu_event(|app, event| storage::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            storage::storage_write_file_atomic,
            storage::storage_read_text_file,
            storage::storage_path_exists,
            storage::storage_read_recent,
            storage::storage_write_recent,
            storage::storage_set_recent_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Novel");
}
