//! Project storage commands: atomic file writes, project file reads,
//! and the recent-projects file in the app config dir. (The native menu lives
//! in menu.rs and is built from the frontend's command registry.)
//!
//! The frontend (src/features/storage) owns the project format; Rust only
//! provides safe primitives. No network access, no secrets.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

/// File name of the recent-projects list inside the app config dir.
pub const RECENT_FILE_NAME: &str = "recent-projects.json";

/// Quit requested (the Quit command / Cmd+Q, or an exit request held by
/// `allow_exit`): the frontend runs its unsaved-changes flow and then calls
/// `storage_exit_app`. macOS Dock > Quit, logoff and Windows shutdown never get
/// here (they bypass `ExitRequested`); crash recovery covers them (<= 30 s lost).
pub const EVENT_QUIT: &str = "menu://quit";

/// Error returned to the frontend: a machine-readable kind plus a message.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct StorageError {
    /// "not_found" | "invalid_path" | "outside_project" | "symlink" |
    /// "disk_full" | "read_only" | "permission_denied" | "io"
    pub kind: &'static str,
    pub message: String,
}

/// Machine-readable kind for an io error, so the frontend can show friendly
/// text for the failures users can fix (full disk, read-only folder).
pub fn io_error_kind(err: &std::io::Error) -> &'static str {
    match err.kind() {
        ErrorKind::NotFound => return "not_found",
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => return "disk_full",
        ErrorKind::ReadOnlyFilesystem => return "read_only",
        ErrorKind::PermissionDenied => return "permission_denied",
        _ => {}
    }
    // Raw OS codes not (yet) mapped to an ErrorKind on every platform.
    #[cfg(unix)]
    match err.raw_os_error() {
        Some(28) /* ENOSPC */ | Some(122) /* EDQUOT (Linux) */ => return "disk_full",
        Some(30) /* EROFS */ => return "read_only",
        Some(1) /* EPERM */ | Some(13) /* EACCES */ => return "permission_denied",
        _ => {}
    }
    #[cfg(windows)]
    match err.raw_os_error() {
        Some(112) /* ERROR_DISK_FULL */ | Some(39) /* ERROR_HANDLE_DISK_FULL */ => return "disk_full",
        Some(19) /* ERROR_WRITE_PROTECT */ => return "read_only",
        Some(5) /* ERROR_ACCESS_DENIED */ => return "permission_denied",
        _ => {}
    }
    "io"
}

impl StorageError {
    fn io(path: &Path, err: std::io::Error) -> Self {
        StorageError { kind: io_error_kind(&err), message: format!("{}: {}", path.display(), err) }
    }
    fn invalid(message: impl Into<String>) -> Self {
        StorageError { kind: "invalid_path", message: message.into() }
    }
    fn outside(path: &Path) -> Self {
        StorageError {
            kind: "outside_project",
            message: format!("{} is outside the open project folder", path.display()),
        }
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

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Atomically replace `target` with `contents`.
///
/// The data goes to a temp file with a random name, created exclusively
/// (O_EXCL / CREATE_NEW, so a planted file or symlink is never followed) in the
/// same folder; it is fsynced, then renamed over the target. A crash leaves
/// either the old file or the new one, never a partial file. A target that is
/// a symlink is refused.
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
    if is_symlink(target) {
        return Err(StorageError {
            kind: "symlink",
            message: format!("Refusing to overwrite a symbolic link: {}", target.display()),
        });
    }
    let mut prefix = std::ffi::OsString::from(".");
    prefix.push(file_name);
    prefix.push(".");
    let mut tmp = tempfile::Builder::new()
        .prefix(&prefix)
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(|e| StorageError::io(dir, e))?;
    // On any error below, dropping `tmp` deletes the temp file.
    tmp.write_all(contents).map_err(|e| StorageError::io(target, e))?;
    tmp.as_file().sync_all().map_err(|e| StorageError::io(target, e))?;
    persist_retrying(tmp, target).map_err(|e| StorageError::io(target, e))?;
    // Persist the rename itself (directory entry). Not supported on Windows.
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Backoff before each retry of the final rename (total ~425 ms).
const PERSIST_BACKOFF_MS: [u64; 5] = [50, 75, 100, 100, 100];

/// True for errors caused by another process briefly holding the file
/// (antivirus, search indexer, OneDrive/Dropbox sync): worth retrying.
pub fn is_transient_lock_error(err: &std::io::Error) -> bool {
    if err.kind() == ErrorKind::PermissionDenied {
        return true;
    }
    // ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33).
    cfg!(windows) && matches!(err.raw_os_error(), Some(32) | Some(33))
}

/// Rename the temp file over `target`, retrying transient lock errors.
fn persist_retrying(mut tmp: tempfile::NamedTempFile, target: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match tmp.persist(target) {
            Ok(_) => return Ok(()),
            Err(e) if attempt < PERSIST_BACKOFF_MS.len() && is_transient_lock_error(&e.error) => {
                std::thread::sleep(std::time::Duration::from_millis(PERSIST_BACKOFF_MS[attempt]));
                attempt += 1;
                tmp = e.file;
            }
            Err(e) => return Err(e.error),
        }
    }
}

/// A project folder the user granted access to: the path as chosen (for
/// display and the recent list) and its canonical form (for confinement).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantedRoot {
    pub display: String,
    pub canonical: PathBuf,
}

/// Roots that file commands are confined to. Only Rust sets `active`: from a
/// native folder dialog, or from an entry of the Rust-written recent list.
/// `previous` lets the webview undo a grant after a failed create/open
/// (it can only go back to a root the user already granted).
#[derive(Default)]
pub struct ProjectRoot(pub Mutex<RootSlots>);

#[derive(Default, Debug)]
pub struct RootSlots {
    pub active: Option<GrantedRoot>,
    pub previous: Option<GrantedRoot>,
}

impl RootSlots {
    pub fn grant(&mut self, root: GrantedRoot) {
        self.previous = self.active.take();
        self.active = Some(root);
    }
    pub fn restore(&mut self) {
        self.active = self.previous.take();
    }
    pub fn clear(&mut self) {
        self.active = None;
        self.previous = None;
    }
}

fn lock_err<E: std::fmt::Display>(e: E) -> StorageError {
    StorageError { kind: "io", message: e.to_string() }
}

fn current_root(state: &ProjectRoot) -> Result<PathBuf> {
    state
        .0
        .lock()
        .map_err(lock_err)?
        .active
        .as_ref()
        .map(|r| r.canonical.clone())
        .ok_or_else(|| StorageError { kind: "outside_project", message: "No project folder is open".into() })
}

/// Resolve `path` for writing: canonicalize its parent folder (resolving `..`
/// and links) and require it to be inside `root` (already canonical).
pub fn resolve_for_write(root: &Path, path: &str) -> Result<PathBuf> {
    let p = absolute(path)?;
    let name = p
        .file_name()
        .ok_or_else(|| StorageError::invalid(format!("No file name in {path:?}")))?;
    let parent = p
        .parent()
        .ok_or_else(|| StorageError::invalid(format!("No parent folder in {path:?}")))?;
    let parent = fs::canonicalize(parent).map_err(|e| StorageError::io(parent, e))?;
    if !parent.starts_with(root) {
        return Err(StorageError::outside(&p));
    }
    Ok(parent.join(name))
}

/// Resolve an existing `path` for reading (following links) and require it to be inside `root`.
pub fn resolve_for_read(root: &Path, path: &str) -> Result<PathBuf> {
    let p = absolute(path)?;
    let canon = fs::canonicalize(&p).map_err(|e| StorageError::io(&p, e))?;
    if !canon.starts_with(root) {
        return Err(StorageError::outside(&p));
    }
    Ok(canon)
}

/// Canonicalize a folder chosen as project root.
pub fn canonical_root(path: &str) -> Result<PathBuf> {
    let abs = absolute(path)?;
    let canon = fs::canonicalize(&abs).map_err(|e| StorageError::io(&abs, e))?;
    if !canon.is_dir() {
        return Err(StorageError::invalid(format!("Not a folder: {}", abs.display())));
    }
    Ok(canon)
}

fn granted(path: &str) -> Result<GrantedRoot> {
    Ok(GrantedRoot { display: path.to_string(), canonical: canonical_root(path)? })
}

/// Show the native folder picker (Rust side, so the webview cannot choose the
/// path itself). If the user picks a folder it becomes the active project
/// root and its path is returned; `None` if cancelled.
#[tauri::command]
pub async fn storage_pick_project_folder<R: Runtime>(
    app: AppHandle<R>,
    title: String,
) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = dialog_app.dialog().file().set_title(title);
        // Modal to the main window, so the app cannot start a second New/Open meanwhile.
        if let Some(window) = dialog_app.get_webview_window("main") {
            builder = builder.set_parent(&window);
        }
        builder.blocking_pick_folder()
    })
    .await
    .map_err(lock_err)?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(lock_err)?;
    let display = path.to_string_lossy().into_owned();
    let root = granted(&display)?;
    app.state::<ProjectRoot>().0.lock().map_err(lock_err)?.grant(root);
    Ok(Some(display))
}

/// Make `path` the active project root, but only if it is in the recent list
/// (which only Rust writes). Errors: "not_found" if the folder is gone,
/// "not_recent" if it is not in the list.
pub fn grant_recent(slots: &mut RootSlots, recent: &RecentFile, path: &str) -> Result<()> {
    let wanted = granted(path)?;
    let listed = recent
        .projects
        .iter()
        .any(|e| fs::canonicalize(&e.path).map(|c| c == wanted.canonical).unwrap_or(false));
    if !listed {
        return Err(StorageError {
            kind: "not_recent",
            message: format!("{path} is not in the recent projects list"),
        });
    }
    slots.grant(wanted);
    Ok(())
}

/// Open Recent: grant a folder from the Rust-persisted recent list.
#[tauri::command]
pub fn storage_open_recent_root<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ProjectRoot>,
    path: String,
) -> Result<()> {
    let recent = load_recent(&recent_file(&app)?)?;
    grant_recent(&mut *state.0.lock().map_err(lock_err)?, &recent, &path)
}

/// Undo the last grant (after a failed create/open), returning to the previous root.
#[tauri::command]
pub fn storage_restore_project_root(state: State<'_, ProjectRoot>) -> Result<()> {
    state.0.lock().map_err(lock_err)?.restore();
    Ok(())
}

/// Close the project: no root, so file commands refuse everything.
#[tauri::command]
pub fn storage_clear_project_root(state: State<'_, ProjectRoot>) -> Result<()> {
    state.0.lock().map_err(lock_err)?.clear();
    Ok(())
}

/// Atomically write a UTF-8 text file inside the open project folder.
/// Runs off the main thread (a locked target may be retried for ~0.4 s).
#[tauri::command]
pub async fn storage_write_file_atomic(
    state: State<'_, ProjectRoot>,
    path: String,
    contents: String,
) -> Result<()> {
    let target = resolve_for_write(&current_root(&state)?, &path)?;
    tauri::async_runtime::spawn_blocking(move || write_atomic(&target, contents.as_bytes()))
        .await
        .map_err(lock_err)?
}

/// Read a UTF-8 text file inside the open project folder.
#[tauri::command]
pub fn storage_read_text_file(state: State<'_, ProjectRoot>, path: String) -> Result<String> {
    let root = current_root(&state)?;
    let p = resolve_for_read(&root, &path)?;
    fs::read_to_string(&p).map_err(|e| StorageError::io(&p, e))
}

/// Create the folder `path` (one level) inside `root` if it does not exist.
/// Its parent must already exist inside the root; an existing symlink or
/// non-folder at `path` is refused.
pub fn ensure_dir_in(root: &Path, path: &str) -> Result<PathBuf> {
    let dir = resolve_for_write(root, path)?;
    if is_symlink(&dir) {
        return Err(StorageError {
            kind: "symlink",
            message: format!("Refusing to use a symbolic link as a folder: {}", dir.display()),
        });
    }
    match fs::create_dir(&dir) {
        Ok(()) => Ok(dir),
        Err(e) if e.kind() == ErrorKind::AlreadyExists && dir.is_dir() => Ok(dir),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            Err(StorageError::invalid(format!("Not a folder: {}", dir.display())))
        }
        Err(e) => Err(StorageError::io(&dir, e)),
    }
}

/// Delete the file `path` inside `root`. A symlink is removed itself (its
/// target is never touched). Returns false if there was nothing to delete.
pub fn remove_file_in(root: &Path, path: &str) -> Result<bool> {
    let p = match resolve_for_write(root, path) {
        Ok(p) => p,
        // The parent folder does not exist, so neither does the file.
        Err(e) if e.kind == "not_found" => return Ok(false),
        Err(e) => return Err(e),
    };
    match fs::symlink_metadata(&p) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(StorageError::io(&p, e)),
        Ok(m) if m.is_dir() => return Err(StorageError::invalid(format!("Not a file: {}", p.display()))),
        Ok(_) => {}
    }
    match fs::remove_file(&p) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(StorageError::io(&p, e)),
    }
}

/// Names of the regular files directly inside the folder `path` within `root`
/// (sorted; subfolders and symlinks are skipped). A folder that does not exist
/// has no files.
pub fn list_dir_in(root: &Path, path: &str) -> Result<Vec<String>> {
    list_entries_in(root, path, false)
}

/// Names of the folders directly inside `path` (none if it does not exist); same rules as list_dir_in.
pub fn list_subdirs_in(root: &Path, path: &str) -> Result<Vec<String>> {
    list_entries_in(root, path, true)
}

fn list_entries_in(root: &Path, path: &str, dirs: bool) -> Result<Vec<String>> {
    let dir = match resolve_for_read(root, path) {
        Ok(d) => d,
        Err(e) if e.kind == "not_found" => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    if !dir.is_dir() {
        return Err(StorageError::invalid(format!("Not a folder: {}", dir.display())));
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| StorageError::io(&dir, e))? {
        let entry = entry.map_err(|e| StorageError::io(&dir, e))?;
        // Symlinks are neither (file_type does not follow them).
        let wanted = entry.file_type().map(|t| if dirs { t.is_dir() } else { t.is_file() }).unwrap_or(false);
        if let (true, Some(name)) = (wanted, entry.file_name().to_str()) {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// List the files of a folder inside the open project folder (e.g. set-aside
/// `.recovery/unrestored-*.json` backups, mentioned in the status bar on open).
#[tauri::command]
pub fn storage_list_dir(state: State<'_, ProjectRoot>, path: String) -> Result<Vec<String>> {
    let root = current_root(&state)?;
    list_dir_in(&root, &path)
}

/// List the folders directly inside a folder of the open project (Save a Copy reports them).
#[tauri::command]
pub fn storage_list_subdirs(state: State<'_, ProjectRoot>, path: String) -> Result<Vec<String>> {
    let root = current_root(&state)?;
    list_subdirs_in(&root, &path)
}

/// Create a subfolder (e.g. `.recovery`) inside the open project folder if needed.
#[tauri::command]
pub fn storage_ensure_dir(state: State<'_, ProjectRoot>, path: String) -> Result<()> {
    let root = current_root(&state)?;
    ensure_dir_in(&root, &path).map(|_| ())
}

/// Delete a file inside the open project folder (e.g. crash-recovery data).
#[tauri::command]
pub fn storage_remove_file(state: State<'_, ProjectRoot>, path: String) -> Result<bool> {
    let root = current_root(&state)?;
    remove_file_in(&root, &path)
}

/// Existence check confined to `roots` (canonical folders). `..` is refused;
/// the deepest existing ancestor is canonicalized (resolving links) and must be
/// inside a root, otherwise "outside_project".
pub fn exists_within(roots: &[PathBuf], path: &str) -> Result<bool> {
    let p = absolute(path)?;
    // Verbatim (\\?\) Windows paths keep ".." as a normal component, so compare the text too.
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir) || c.as_os_str() == "..") {
        return Err(StorageError::invalid(format!("Path may not contain '..': {path:?}")));
    }
    let mut probe = p.as_path();
    let existing = loop {
        if let Ok(c) = fs::canonicalize(probe) {
            break c;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err(StorageError::outside(&p)),
        }
    };
    if !roots.iter().any(|r| existing.starts_with(r)) {
        return Err(StorageError::outside(&p));
    }
    Ok(probe == p.as_path())
}

/// True when `path` exists. Only answers for paths inside the open project
/// folder or a folder in the recent list (used to flag missing recent projects
/// and to look for crash-recovery data).
#[tauri::command]
pub fn storage_path_exists<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ProjectRoot>,
    path: String,
) -> Result<bool> {
    let mut roots: Vec<PathBuf> = load_recent(&recent_file(&app)?)?
        .projects
        .iter()
        .filter_map(|e| fs::canonicalize(&e.path).ok())
        .collect();
    if let Some(active) = state.0.lock().map_err(lock_err)?.active.as_ref() {
        roots.push(active.canonical.clone());
    }
    exists_within(&roots, &path)
}

/// project.json and the crash-recovery snapshot of a recent project, read
/// before it is opened (to decide whether to offer reopening it after a crash).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryProbe {
    pub project: Option<String>,
    pub recovery: Option<String>,
}

/// Read `<folder>/project.json` and `<folder>/.recovery/manuscript.json` (each
/// confined to `folder`, missing = None), but only if `folder` is in the
/// Rust-written recent list. Nothing else can be read this way.
pub fn probe_recovery(recent: &RecentFile, folder: &str) -> Result<RecoveryProbe> {
    let root = canonical_root(folder)?;
    let listed = recent
        .projects
        .iter()
        .any(|e| fs::canonicalize(&e.path).map(|c| c == root).unwrap_or(false));
    if !listed {
        return Err(StorageError {
            kind: "not_recent",
            message: format!("{folder} is not in the recent projects list"),
        });
    }
    let read = |rel: &[&str]| -> Result<Option<String>> {
        let mut p = root.clone();
        for part in rel {
            p.push(part);
        }
        match resolve_for_read(&root, &p.to_string_lossy()) {
            Ok(c) => fs::read_to_string(&c).map(Some).map_err(|e| StorageError::io(&c, e)),
            Err(e) if e.kind == "not_found" => Ok(None),
            Err(e) => Err(e),
        }
    };
    Ok(RecoveryProbe {
        project: read(&["project.json"])?,
        recovery: read(&[".recovery", "manuscript.json"])?,
    })
}

/// Startup: look at the crash-recovery data of a recent project without opening it.
#[tauri::command]
pub fn storage_probe_recent_recovery<R: Runtime>(app: AppHandle<R>, path: String) -> Result<RecoveryProbe> {
    probe_recovery(&load_recent(&recent_file(&app)?)?, &path)
}

/// Exit the app. Called by the frontend after its quit flow (unsaved-changes
/// prompt, recovery cleanup) approved quitting.
#[tauri::command]
pub fn storage_exit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

/// Decide what to do with `RunEvent::ExitRequested`: true = let the app exit.
/// Programmatic exits (`app.exit(code)`, after the frontend approved) and exits
/// after the last window closed (the close flow already ran) proceed; an exit
/// request with no code while a window is open is held and routed through the
/// frontend flow. This does NOT cover macOS Dock > Quit, logging off, or Windows
/// shutdown: those terminate the process without an `ExitRequested` the app can
/// hold, so unsaved work there is protected only by crash recovery (<= 30 s).
pub fn allow_exit(code: Option<i32>, open_windows: usize) -> bool {
    code.is_some() || open_windows == 0
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

/// Maximum number of entries in the recent-projects list.
pub const RECENT_LIMIT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentFile {
    pub version: u32,
    pub projects: Vec<RecentEntry>,
}

impl Default for RecentFile {
    fn default() -> Self {
        RecentFile { version: 1, projects: Vec::new() }
    }
}

/// Load the recent list; a missing or damaged file is an empty list.
pub fn load_recent(path: &Path) -> Result<RecentFile> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(RecentFile::default()),
        Err(e) => Err(StorageError::io(path, e)),
    }
}

/// Put `root` first (de-duplicated by canonical folder), capped at RECENT_LIMIT.
pub fn add_recent(list: &mut RecentFile, root: &GrantedRoot, name: String, opened_at: String) {
    list.projects
        .retain(|e| fs::canonicalize(&e.path).map(|c| c != root.canonical).unwrap_or(true) && e.path != root.display);
    list.projects.insert(0, RecentEntry { path: root.display.clone(), name, opened_at });
    list.projects.truncate(RECENT_LIMIT);
    list.version = 1;
}

/// Record the ACTIVE project root in the recent list (the webview supplies
/// only the display name and timestamp, never the path). Returns the new list as JSON.
#[tauri::command]
pub fn storage_remember_recent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ProjectRoot>,
    name: String,
    opened_at: String,
) -> Result<String> {
    let root = state
        .0
        .lock()
        .map_err(lock_err)?
        .active
        .clone()
        .ok_or_else(|| StorageError { kind: "outside_project", message: "No project folder is open".into() })?;
    let p = recent_file(&app)?;
    let mut list = load_recent(&p)?;
    add_recent(&mut list, &root, name, opened_at);
    let json = serde_json::to_string_pretty(&list).map_err(lock_err)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| StorageError::io(dir, e))?;
    }
    write_atomic(&p, json.as_bytes())?;
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("novel-storage-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn s(p: PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    /// Try to create a file symlink; false if the OS refuses (e.g. Windows without privilege).
    fn try_symlink(src: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(src, link).is_ok();
        #[cfg(windows)]
        return std::os::windows::fs::symlink_file(src, link).is_ok();
    }

    #[test]
    fn atomic_write_creates_file_and_leaves_no_temp() {
        let dir = temp_dir("create");
        let target = dir.join("manuscript.json");
        write_atomic(&target, b"{\"type\":\"doc\"}").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"type\":\"doc\"}");
        assert_eq!(entries(&dir), vec!["manuscript.json"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = temp_dir("replace");
        let target = dir.join("project.json");
        fs::write(&target, "old contents that are longer than the new ones").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(entries(&dir), vec!["project.json"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_uses_random_temp_name_not_predictable_tmp() {
        let dir = temp_dir("random");
        let target = dir.join("manuscript.json");
        // A planted file at the old predictable name is neither used nor touched.
        let planted = dir.join("manuscript.json.tmp");
        fs::write(&planted, "planted").unwrap();
        write_atomic(&target, b"fresh").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "fresh");
        assert_eq!(fs::read_to_string(&planted).unwrap(), "planted");
        assert_eq!(entries(&dir), vec!["manuscript.json", "manuscript.json.tmp"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn planted_tmp_symlink_does_not_redirect_write() {
        let dir = temp_dir("tmp-link");
        let victim = dir.join("victim.txt");
        fs::write(&victim, "precious").unwrap();
        if !try_symlink(&victim, &dir.join("manuscript.json.tmp")) {
            eprintln!("skipping: cannot create symlinks here");
            fs::remove_dir_all(dir).unwrap();
            return;
        }
        write_atomic(&dir.join("manuscript.json"), b"doc").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_symlink_target() {
        let dir = temp_dir("target-link");
        let victim = dir.join("victim.txt");
        fs::write(&victim, "precious").unwrap();
        let target = dir.join("manuscript.json");
        if !try_symlink(&victim, &target) {
            eprintln!("skipping: cannot create symlinks here");
            fs::remove_dir_all(dir).unwrap();
            return;
        }
        let err = write_atomic(&target, b"doc").unwrap_err();
        assert_eq!(err.kind, "symlink");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
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
    fn writes_and_reads_are_confined_to_the_project_root() {
        let base = temp_dir("scope");
        fs::create_dir_all(base.join("project").join("sub")).unwrap();
        let root = canonical_root(&s(base.join("project"))).unwrap();

        assert!(resolve_for_write(&root, &s(root.join("manuscript.json"))).is_ok());
        assert!(resolve_for_write(&root, &s(root.join("sub").join("x.json"))).is_ok());
        assert_eq!(
            resolve_for_write(&root, &s(base.join("evil.json"))).unwrap_err().kind,
            "outside_project"
        );
        assert_eq!(
            resolve_for_write(&root, &s(root.join("..").join("evil.json"))).unwrap_err().kind,
            "outside_project"
        );
        assert_eq!(resolve_for_write(&root, "relative.json").unwrap_err().kind, "invalid_path");

        fs::write(base.join("secret.txt"), "s").unwrap();
        fs::write(root.join("manuscript.json"), "{}").unwrap();
        assert!(resolve_for_read(&root, &s(root.join("manuscript.json"))).is_ok());
        assert_eq!(
            resolve_for_read(&root, &s(root.join("..").join("secret.txt"))).unwrap_err().kind,
            "outside_project"
        );
        assert_eq!(resolve_for_read(&root, &s(root.join("missing.json"))).unwrap_err().kind, "not_found");
        assert_eq!(canonical_root("relative").unwrap_err().kind, "invalid_path");
        fs::remove_dir_all(base).unwrap();
    }

    fn recent_with(paths: &[&Path]) -> RecentFile {
        RecentFile {
            version: 1,
            projects: paths
                .iter()
                .map(|p| RecentEntry { path: s(p.to_path_buf()), name: "n".into(), opened_at: "t".into() })
                .collect(),
        }
    }

    #[test]
    fn recent_root_is_granted_only_for_listed_folders() {
        let base = temp_dir("grant");
        let listed = base.join("listed");
        let other = base.join("other");
        fs::create_dir_all(&listed).unwrap();
        fs::create_dir_all(&other).unwrap();
        let recent = recent_with(&[&listed]);
        let mut slots = RootSlots::default();

        assert_eq!(grant_recent(&mut slots, &recent, &s(other.clone())).unwrap_err().kind, "not_recent");
        assert!(slots.active.is_none());
        // `..` spelling of the same folder still matches by canonical path.
        let spelled = other.join("..").join("listed");
        grant_recent(&mut slots, &recent, &s(spelled)).unwrap();
        assert_eq!(slots.active.as_ref().unwrap().canonical, fs::canonicalize(&listed).unwrap());
        assert_eq!(
            grant_recent(&mut slots, &recent, &s(base.join("gone"))).unwrap_err().kind,
            "not_found"
        );
        assert_eq!(grant_recent(&mut slots, &recent, "relative").unwrap_err().kind, "invalid_path");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn recovery_probe_reads_only_listed_folders_and_two_files() {
        let base = temp_dir("probe");
        let listed = base.join("listed");
        let other = base.join("other");
        fs::create_dir_all(listed.join(".recovery")).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(listed.join("project.json"), "P").unwrap();
        let recent = recent_with(&[&listed]);

        let probe = probe_recovery(&recent, &s(listed.clone())).unwrap();
        assert_eq!(probe, RecoveryProbe { project: Some("P".into()), recovery: None });
        fs::write(listed.join(".recovery").join("manuscript.json"), "R").unwrap();
        let probe = probe_recovery(&recent, &s(listed.clone())).unwrap();
        assert_eq!(probe.recovery.as_deref(), Some("R"));
        assert_eq!(probe_recovery(&recent, &s(other)).unwrap_err().kind, "not_recent");
        assert_eq!(probe_recovery(&recent, &s(base.join("gone"))).unwrap_err().kind, "not_found");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn path_exists_is_confined_to_granted_and_recent_folders() {
        let base = temp_dir("exists");
        let project = base.join("project");
        fs::create_dir_all(project.join(".recovery")).unwrap();
        fs::write(project.join("project.json"), "{}").unwrap();
        fs::write(base.join("secret.txt"), "s").unwrap();
        let roots = vec![fs::canonicalize(&project).unwrap()];

        assert!(exists_within(&roots, &s(project.join("project.json"))).unwrap());
        assert!(!exists_within(&roots, &s(project.join(".recovery").join("manuscript.json"))).unwrap());
        assert!(!exists_within(&roots, &s(project.join("nope").join("deeper.json"))).unwrap());
        assert_eq!(exists_within(&roots, &s(base.join("secret.txt"))).unwrap_err().kind, "outside_project");
        assert_eq!(
            exists_within(&roots, &s(base.join("missing").join("x"))).unwrap_err().kind,
            "outside_project"
        );
        // Built as text: PathBuf::join("..") on a verbatim (\\?\) path pops instead of appending.
        let sep = std::path::MAIN_SEPARATOR;
        let dotdot = format!("{}{sep}..{sep}secret.txt", s(project.clone()));
        assert_eq!(exists_within(&roots, &dotdot).unwrap_err().kind, "invalid_path");
        assert_eq!(exists_within(&[], &s(project.join("project.json"))).unwrap_err().kind, "outside_project");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn transient_lock_errors_are_retryable() {
        assert!(is_transient_lock_error(&std::io::Error::from(ErrorKind::PermissionDenied)));
        assert!(!is_transient_lock_error(&std::io::Error::from(ErrorKind::NotFound)));
        #[cfg(windows)]
        {
            assert!(is_transient_lock_error(&std::io::Error::from_raw_os_error(32)));
            assert!(is_transient_lock_error(&std::io::Error::from_raw_os_error(33)));
        }
    }

    /// A target held open without FILE_SHARE_DELETE (like AV / sync clients do)
    /// makes the rename fail until it is released; the write retries and succeeds.
    #[cfg(windows)]
    #[test]
    fn atomic_write_retries_while_target_is_locked() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("locked");
        let target = dir.join("manuscript.json");
        fs::write(&target, "old").unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(120));
            drop(held);
        });
        write_atomic(&target, b"new").unwrap();
        releaser.join().unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(entries(&dir), vec!["manuscript.json"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exit_requests_are_held_unless_approved_or_windowless() {
        assert!(allow_exit(Some(0), 1)); // app.exit(0) after the frontend approved
        assert!(allow_exit(None, 0)); // last window closed through the close flow
        assert!(!allow_exit(None, 1)); // an unapproved exit request with the window open
    }

    #[test]
    fn root_slots_grant_restore_clear() {
        let a = GrantedRoot { display: "a".into(), canonical: PathBuf::from("/a") };
        let b = GrantedRoot { display: "b".into(), canonical: PathBuf::from("/b") };
        let mut slots = RootSlots::default();
        slots.grant(a.clone());
        slots.grant(b);
        slots.restore();
        assert_eq!(slots.active, Some(a));
        slots.clear();
        assert!(slots.active.is_none() && slots.previous.is_none());
    }

    #[test]
    fn add_recent_dedupes_and_caps() {
        let base = temp_dir("recent");
        let mut list = RecentFile::default();
        for i in 0..(RECENT_LIMIT + 3) {
            let dir = base.join(format!("p{i}"));
            fs::create_dir_all(&dir).unwrap();
            add_recent(&mut list, &granted(&s(dir)).unwrap(), format!("p{i}"), "t".into());
        }
        assert_eq!(list.projects.len(), RECENT_LIMIT);
        let again = base.join("p3").join("..").join("p3");
        add_recent(&mut list, &granted(&s(again)).unwrap(), "again".into(), "t2".into());
        assert_eq!(list.projects[0].name, "again");
        assert_eq!(list.projects.iter().filter(|e| e.name.starts_with("p3") || e.name == "again").count(), 1);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn damaged_recent_file_is_empty() {
        let dir = temp_dir("recent-bad");
        let p = dir.join(RECENT_FILE_NAME);
        assert_eq!(load_recent(&p).unwrap(), RecentFile::default());
        fs::write(&p, "{not json").unwrap();
        assert_eq!(load_recent(&p).unwrap(), RecentFile::default());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ensure_dir_creates_confined_subfolder_idempotently() {
        let base = temp_dir("ensure-dir");
        fs::create_dir_all(base.join("project")).unwrap();
        let root = canonical_root(&s(base.join("project"))).unwrap();
        let rec = root.join(".recovery");
        ensure_dir_in(&root, &s(rec.clone())).unwrap();
        assert!(rec.is_dir());
        ensure_dir_in(&root, &s(rec.clone())).unwrap();
        // The recovery file can now be written atomically inside it.
        let target = resolve_for_write(&root, &s(rec.join("manuscript.json"))).unwrap();
        write_atomic(&target, b"{}").unwrap();
        assert_eq!(
            ensure_dir_in(&root, &s(base.join("outside"))).unwrap_err().kind,
            "outside_project"
        );
        assert!(!base.join("outside").exists());
        assert_eq!(ensure_dir_in(&root, &s(root.join("a").join("b"))).unwrap_err().kind, "not_found");
        fs::write(root.join("file"), "x").unwrap();
        assert_eq!(ensure_dir_in(&root, &s(root.join("file"))).unwrap_err().kind, "invalid_path");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn remove_file_is_confined_and_idempotent() {
        let base = temp_dir("remove");
        fs::create_dir_all(base.join("project").join(".recovery")).unwrap();
        let root = canonical_root(&s(base.join("project"))).unwrap();
        let f = root.join(".recovery").join("manuscript.json");
        fs::write(&f, "{}").unwrap();
        assert!(remove_file_in(&root, &s(f.clone())).unwrap());
        assert!(!f.exists());
        assert!(!remove_file_in(&root, &s(f.clone())).unwrap());
        assert!(!remove_file_in(&root, &s(root.join("nodir").join("x.json"))).unwrap());
        fs::write(base.join("secret.txt"), "s").unwrap();
        assert_eq!(
            remove_file_in(&root, &s(root.join("..").join("secret.txt"))).unwrap_err().kind,
            "outside_project"
        );
        assert!(base.join("secret.txt").exists());
        assert_eq!(remove_file_in(&root, &s(root.join(".recovery"))).unwrap_err().kind, "invalid_path");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn list_dir_is_confined_and_lists_files_only() {
        let base = temp_dir("list");
        let rec = base.join("project").join(".recovery");
        fs::create_dir_all(rec.join("sub")).unwrap();
        let root = canonical_root(&s(base.join("project"))).unwrap();
        fs::write(rec.join("unrestored-b.json"), "{}").unwrap();
        fs::write(rec.join("manuscript.json"), "{}").unwrap();
        fs::write(rec.join("unrestored-a.json"), "{}").unwrap();
        assert_eq!(
            list_dir_in(&root, &s(root.join(".recovery"))).unwrap(),
            vec!["manuscript.json", "unrestored-a.json", "unrestored-b.json"]
        );
        assert!(list_dir_in(&root, &s(root.join("missing"))).unwrap().is_empty());
        assert_eq!(list_subdirs_in(&root, &s(root.join(".recovery"))).unwrap(), vec!["sub"]);
        assert_eq!(list_subdirs_in(&root, &s(root.clone())).unwrap(), vec![".recovery"]);
        assert_eq!(list_subdirs_in(&root, &s(base.clone())).unwrap_err().kind, "outside_project");
        assert_eq!(list_dir_in(&root, &s(base.clone())).unwrap_err().kind, "outside_project");
        assert_eq!(
            list_dir_in(&root, &s(root.join("..").join("project").join(".."))).unwrap_err().kind,
            "outside_project"
        );
        assert_eq!(
            list_dir_in(&root, &s(rec.join("manuscript.json"))).unwrap_err().kind,
            "invalid_path"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn remove_file_deletes_a_symlink_not_its_target() {
        let base = temp_dir("remove-link");
        fs::create_dir_all(base.join("project")).unwrap();
        let root = canonical_root(&s(base.join("project"))).unwrap();
        let victim = base.join("victim.txt");
        fs::write(&victim, "precious").unwrap();
        let link = root.join("manuscript.json");
        if !try_symlink(&victim, &link) {
            eprintln!("skipping: cannot create symlinks here");
            fs::remove_dir_all(base).unwrap();
            return;
        }
        assert!(remove_file_in(&root, &s(link.clone())).unwrap());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn io_errors_map_to_friendly_kinds() {
        use std::io::Error;
        assert_eq!(io_error_kind(&Error::from(ErrorKind::NotFound)), "not_found");
        assert_eq!(io_error_kind(&Error::from(ErrorKind::StorageFull)), "disk_full");
        assert_eq!(io_error_kind(&Error::from(ErrorKind::ReadOnlyFilesystem)), "read_only");
        assert_eq!(io_error_kind(&Error::from(ErrorKind::PermissionDenied)), "permission_denied");
        assert_eq!(io_error_kind(&Error::from(ErrorKind::Other)), "io");
        #[cfg(windows)]
        {
            assert_eq!(io_error_kind(&Error::from_raw_os_error(112)), "disk_full");
            assert_eq!(io_error_kind(&Error::from_raw_os_error(5)), "permission_denied");
            assert_eq!(io_error_kind(&Error::from_raw_os_error(19)), "read_only");
        }
        #[cfg(unix)]
        {
            assert_eq!(io_error_kind(&Error::from_raw_os_error(28)), "disk_full");
            assert_eq!(io_error_kind(&Error::from_raw_os_error(30)), "read_only");
            assert_eq!(io_error_kind(&Error::from_raw_os_error(13)), "permission_denied");
        }
    }

    #[test]
    fn reads_through_a_symlink_leaving_the_root_are_refused() {
        let base = temp_dir("read-link");
        fs::create_dir_all(base.join("project")).unwrap();
        let root = canonical_root(&s(base.join("project"))).unwrap();
        fs::write(base.join("secret.txt"), "s").unwrap();
        let link = root.join("manuscript.json");
        if !try_symlink(&base.join("secret.txt"), &link) {
            eprintln!("skipping: cannot create symlinks here");
            fs::remove_dir_all(base).unwrap();
            return;
        }
        assert_eq!(resolve_for_read(&root, &s(link)).unwrap_err().kind, "outside_project");
        fs::remove_dir_all(base).unwrap();
    }
}

