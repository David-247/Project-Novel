mod ai;
mod export;
mod fonts;
mod preferences;
mod spellcheck;
mod menu;
mod storage;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .manage(storage::ProjectRoot::default())
        .manage(export::ExportState::default())
        .manage(ai::AiState::default())
        .manage(menu::MenuState::<tauri::Wry>::default());
    // macOS: the native menu bar, replaced by the command registry's snapshot (menu_set) once the
    // frontend is up. Windows has no native menu: the frontend draws its own menu bar.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::initial_menu);
    builder
        .setup(|app| {
            // The real connection resolver: ai-connections.json (app data dir) + the OS keychain.
            let file = app.path().app_data_dir()?.join(ai::connections::CONNECTIONS_FILE);
            app.state::<ai::AiState>().set_resolver(ai::app_resolver(file));
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            fonts::list_system_fonts,
            ai::ai_fetch,
            ai::ai_fetch_cancel,
            ai::ai_spike_autorun,
            ai::ai_spike_log,
            ai::ai_secret_set,
            ai::ai_secret_delete,
            ai::ai_secret_has,
            ai::ai_connections_get,
            ai::ai_connections_save,
            export::export_pick_save_path,
            export::export_write_file,
            export::export_render_pdf,
            export::export_cancel_render,
            export::export_reveal_in_folder,
            export::export_open_file,
            menu::menu_set,
            storage::storage_pick_project_folder,
            storage::storage_open_recent_root,
            storage::storage_restore_project_root,
            storage::storage_clear_project_root,
            storage::storage_write_file_atomic,
            storage::storage_write_files_atomic,
            storage::storage_read_text_file,
            storage::storage_path_exists,
            storage::storage_ensure_dir,
            storage::storage_remove_file,
            storage::storage_read_recent,
            storage::storage_remember_recent,
            storage::storage_exit_app,
            storage::storage_probe_recent_recovery,
            storage::storage_list_dir,
            spellcheck::spell_check,
            preferences::preferences_read,
            preferences::preferences_write,
            preferences::preferences_default_author,
            storage::storage_list_subdirs,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Novel")
        .run(|app, event| {
            // A programmatic exit request that the frontend has not approved is held
            // and routed through its unsaved-changes flow (see storage::allow_exit).
            // NOT covered: macOS Dock > Quit, logging off, and Windows shutdown end
            // the process without reaching the quit flow; there crash recovery
            // limits the loss to the last <= 30 s (docs/project-format.md).
            // Quitting mid-export: kill any running Typst process (bounded wait) so none outlives the app.
            if let tauri::RunEvent::Exit = event {
                app.state::<export::ExportState>().shutdown(std::time::Duration::from_secs(2));
                return;
            }
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
