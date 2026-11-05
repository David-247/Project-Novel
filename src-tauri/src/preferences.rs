//! App preferences: one per-user JSON file (`preferences.json`) in the app config dir, next to the
//! recent-projects file. Never in a project folder, and never any credential (AI keys belong to the
//! OS keychain). The frontend (src/features/settings, src/shared/store/preferences-slice.ts) owns the
//! shape: versioned, unknown keys kept, a damaged file read as defaults. Rust only provides safe
//! primitives: read the raw text, replace it atomically, and name the OS user.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::storage::{io_error_kind, write_atomic, StorageError};

/// File name of the preferences file inside the app config dir.
pub const PREFERENCES_FILE_NAME: &str = "preferences.json";

/// Largest preferences file accepted; the real file is a few hundred bytes.
pub const MAX_PREFERENCES_BYTES: usize = 256 * 1024;

type Result<T> = std::result::Result<T, StorageError>;

fn io(path: &Path, err: std::io::Error) -> StorageError {
    StorageError { kind: io_error_kind(&err), message: format!("{}: {err}", path.display()) }
}

fn preferences_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| StorageError { kind: "io", message: e.to_string() })?;
    Ok(dir.join(PREFERENCES_FILE_NAME))
}

/// Raw contents of the preferences file, or `None` if it does not exist yet.
#[tauri::command]
pub fn preferences_read<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>> {
    let p = preferences_file(&app)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        // Not UTF-8 (damaged): the frontend treats absent and damaged alike (defaults), and the
        // next write repairs the file.
        Err(e) if e.kind() == ErrorKind::InvalidData => Ok(None),
        Err(e) => Err(io(&p, e)),
    }
}

/// Atomically replace the preferences file (creating the config dir on first write).
#[tauri::command]
pub fn preferences_write<R: Runtime>(app: AppHandle<R>, contents: String) -> Result<()> {
    check_size(&contents)?;
    let p = preferences_file(&app)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| io(dir, e))?;
    }
    write_atomic(&p, contents.as_bytes())
}

pub fn check_size(contents: &str) -> Result<()> {
    if contents.len() > MAX_PREFERENCES_BYTES {
        return Err(StorageError {
            kind: "invalid_path",
            message: format!("Preferences are larger than {MAX_PREFERENCES_BYTES} bytes"),
        });
    }
    Ok(())
}

/// The name to attribute tracked changes and comments to by default: the OS user's full name, else
/// the account name, else empty (the app then asks once). Read offline from the OS.
pub fn default_author_name() -> String {
    let clean = |s: String| s.trim().to_string();
    if let Ok(name) = whoami::realname() {
        let name = clean(name);
        if !name.is_empty() {
            return name;
        }
    }
    if let Ok(name) = whoami::username() {
        let name = clean(name);
        if !name.is_empty() {
            return name;
        }
    }
    ["USERNAME", "USER"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(clean)
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}

#[tauri::command]
pub fn preferences_default_author() -> String {
    default_author_name()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_preferences_are_refused() {
        assert!(check_size("{}").is_ok());
        let big = "x".repeat(MAX_PREFERENCES_BYTES + 1);
        assert_eq!(check_size(&big).unwrap_err().kind, "invalid_path");
    }

    #[test]
    fn default_author_is_trimmed() {
        let name = default_author_name();
        assert_eq!(name, name.trim());
    }

    #[test]
    fn atomic_write_replaces_a_damaged_preferences_file() {
        let dir = std::env::temp_dir().join(format!("novel-prefs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(PREFERENCES_FILE_NAME);
        fs::write(&file, b"{ not json").unwrap();
        write_atomic(&file, b"{\"version\":1}").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"version\":1}");
        let _ = fs::remove_dir_all(&dir);
    }
}
