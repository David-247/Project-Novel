//! Project storage commands: atomic file writes, project file reads,
//! the recent-projects file in the app config dir, and the native File menu.
//!
//! The frontend (src/features/storage) owns the project format; Rust only
//! provides safe primitives. No network access, no secrets.

use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{
    Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// File name of the recent-projects list inside the app config dir.
pub const RECENT_FILE_NAME: &str = "recent-projects.json";

/// Menu item ids.
pub const MENU_NEW_PROJECT: &str = "file.new_project";
pub const MENU_OPEN_PROJECT: &str = "file.open_project";
pub const MENU_OPEN_RECENT: &str = "file.open_recent";
pub const MENU_OPEN_RECENT_ITEM_PREFIX: &str = "file.open_recent.";
pub const MENU_OPEN_RECENT_EMPTY: &str = "file.open_recent.empty";
pub const MENU_SAVE: &str = "file.save";

/// Events emitted to the frontend when menu items are chosen.
pub const EVENT_NEW_PROJECT: &str = "menu://new-project";
pub const EVENT_OPEN_PROJECT: &str = "menu://open-project";
/// Payload: the project folder path (string).
pub const EVENT_OPEN_RECENT: &str = "menu://open-recent";
pub const EVENT_SAVE: &str = "menu://save";

/// Error returned to the frontend: a machine-readable kind plus a message.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct StorageError {
    /// "not_found" | "invalid_path" | "io"
    pub kind: &'static str,
    pub message: String,
}

impl StorageError {
    fn io(path: &Path, err: std::io::Error) -> Self {
        let kind = if err.kind() == ErrorKind::NotFound { "not_found" } else { "io" };
        StorageError { kind, message: format!("{}: {}", path.display(), err) }
    }
    fn invalid(message: impl Into<String>) -> Self {
        StorageError { kind: "invalid_path", message: message.into() }
    }
}

type Result<T> = std::result::Result<T, StorageError>;

fn absolute(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    if path.is_empty() || !p.is_absolute() {
        return Err(StorageError::invalid(format!("Expected an absolute path, got {path:?}")));
    }
    Ok(p)
}

/// Atomically replace `target` with `contents`: write `<target>.tmp` in the
/// same directory, fsync it, then rename it over the target. A crash at any
/// point leaves either the old file or the new file, never a partial one.
pub fn write_atomic(target: &Path, contents: &[u8]) -> Result<()> {
    let file_name = target
        .file_name()
        .ok_or_else(|| StorageError::invalid(format!("No file name in {}", target.display())))?;
    let dir = target
        .parent()
        .ok_or_else(|| StorageError::invalid(format!("No parent folder for {}", target.display())))?;
    if !dir.is_dir() {
        return Err(StorageError {
            kind: "not_found",
            message: format!("Folder does not exist: {}", dir.display()),
        });
    }
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(".tmp");
    let tmp = dir.join(tmp_name);

    let write = || -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, target)?;
        // Persist the rename itself (directory entry). Not supported on Windows.
        #[cfg(unix)]
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        StorageError::io(target, e)
    })
}

/// Atomically write a UTF-8 text file (absolute path; parent folder must exist).
#[tauri::command]
pub fn storage_write_file_atomic(path: String, contents: String) -> Result<()> {
    write_atomic(&absolute(&path)?, contents.as_bytes())
}

/// Read a UTF-8 text file (absolute path).
#[tauri::command]
pub fn storage_read_text_file(path: String) -> Result<String> {
    let p = absolute(&path)?;
    fs::read_to_string(&p).map_err(|e| StorageError::io(&p, e))
}

/// True when `path` is an existing file or folder.
#[tauri::command]
pub fn storage_path_exists(path: String) -> Result<bool> {
    Ok(absolute(&path)?.exists())
}

fn recent_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| StorageError { kind: "io", message: e.to_string() })?;
    Ok(dir.join(RECENT_FILE_NAME))
}

/// Raw contents of the recent-projects file, or `None` if it does not exist yet.
#[tauri::command]
pub fn storage_read_recent<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>> {
    let p = recent_file(&app)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(StorageError::io(&p, e)),
    }
}

/// Atomically replace the recent-projects file (creates the config dir).
#[tauri::command]
pub fn storage_write_recent<R: Runtime>(app: AppHandle<R>, contents: String) -> Result<()> {
    let p = recent_file(&app)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| StorageError::io(dir, e))?;
    }
    write_atomic(&p, contents.as_bytes())
}

/// One entry of the File > Open Recent submenu.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMenuEntry {
    pub path: String,
    pub label: String,
    #[serde(default)]
    pub missing: bool,
}

/// Paths currently shown in Open Recent, indexed by menu item suffix.
#[derive(Default)]
pub struct RecentMenuState(pub Mutex<Vec<String>>);

fn build_recent_submenu<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[RecentMenuEntry],
) -> tauri::Result<Submenu<R>> {
    let mut b = SubmenuBuilder::with_id(app, MENU_OPEN_RECENT, "Open Recent");
    if entries.is_empty() {
        let empty = MenuItemBuilder::with_id(MENU_OPEN_RECENT_EMPTY, "No Recent Projects")
            .enabled(false)
            .build(app)?;
        b = b.item(&empty);
    }
    for (i, e) in entries.iter().enumerate() {
        let label = if e.missing { format!("{} (missing)", e.label) } else { e.label.clone() };
        let item = MenuItemBuilder::with_id(format!("{MENU_OPEN_RECENT_ITEM_PREFIX}{i}"), label)
            .enabled(!e.missing)
            .build(app)?;
        b = b.item(&item);
    }
    b.build()
}

/// Build the application menu: File (New, Open, Open Recent, Save, Quit),
/// plus the app and Edit menus macOS needs for standard shortcuts.
pub fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    recent: &[RecentMenuEntry],
) -> tauri::Result<Menu<R>> {
    let new_project = MenuItemBuilder::with_id(MENU_NEW_PROJECT, "New Project...")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let open_project = MenuItemBuilder::with_id(MENU_OPEN_PROJECT, "Open Project...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id(MENU_SAVE, "Save").accelerator("CmdOrCtrl+S").build(app)?;
    let recent_menu = build_recent_submenu(app, recent)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new_project)
        .item(&open_project)
        .item(&recent_menu)
        .separator()
        .item(&save)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Novel")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        menu = menu.item(&app_menu).item(&file).item(&edit);
    }
    #[cfg(not(target_os = "macos"))]
    {
        menu = menu.item(&file);
    }
    menu.build()
}

/// Rebuild File > Open Recent from the frontend's list.
#[tauri::command]
pub fn storage_set_recent_menu<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RecentMenuState>,
    entries: Vec<RecentMenuEntry>,
) -> std::result::Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = entries.iter().map(|e| e.path.clone()).collect();
    let menu = build_menu(&app, &entries).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Route a menu click to a frontend event.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let result = match id {
        MENU_NEW_PROJECT => app.emit(EVENT_NEW_PROJECT, ()),
        MENU_OPEN_PROJECT => app.emit(EVENT_OPEN_PROJECT, ()),
        MENU_SAVE => app.emit(EVENT_SAVE, ()),
        _ => match id.strip_prefix(MENU_OPEN_RECENT_ITEM_PREFIX).and_then(|i| i.parse::<usize>().ok()) {
            Some(index) => {
                let path = app
                    .state::<RecentMenuState>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|paths| paths.get(index).cloned());
                match path {
                    Some(path) => app.emit(EVENT_OPEN_RECENT, path),
                    None => Ok(()),
                }
            }
            None => Ok(()),
        },
    };
    if let Err(e) = result {
        eprintln!("failed to emit menu event {id}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("novel-storage-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_creates_file_and_leaves_no_tmp() {
        let dir = temp_dir("create");
        let target = dir.join("manuscript.json");
        write_atomic(&target, b"{\"type\":\"doc\"}").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"type\":\"doc\"}");
        assert!(!dir.join("manuscript.json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = temp_dir("replace");
        let target = dir.join("project.json");
        fs::write(&target, "old contents that are longer than the new ones").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(!dir.join("project.json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_overwrites_stale_tmp_file() {
        let dir = temp_dir("stale");
        let target = dir.join("project.json");
        fs::write(dir.join("project.json.tmp"), "garbage from a crash").unwrap();
        write_atomic(&target, b"fresh").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "fresh");
        assert!(!dir.join("project.json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_fails_cleanly_when_folder_missing() {
        let dir = temp_dir("missing");
        let target = dir.join("nope").join("project.json");
        let err = write_atomic(&target, b"x").unwrap_err();
        assert_eq!(err.kind, "not_found");
        assert!(!target.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn commands_reject_relative_paths() {
        assert_eq!(storage_read_text_file("relative.json".into()).unwrap_err().kind, "invalid_path");
        assert_eq!(
            storage_write_file_atomic("relative.json".into(), "x".into()).unwrap_err().kind,
            "invalid_path"
        );
    }

    #[test]
    fn read_missing_file_reports_not_found() {
        let dir = temp_dir("read");
        let p = dir.join("manuscript.json");
        let err = storage_read_text_file(p.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(err.kind, "not_found");
        fs::remove_dir_all(dir).unwrap();
    }
}
