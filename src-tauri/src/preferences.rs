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
    read_preferences_at(&preferences_file(&app)?)
}

/// Raw contents of the preferences file at `p`; `None` when it is missing or damaged (not UTF-8,
/// or larger than [`MAX_PREFERENCES_BYTES`]: never read whole into memory). The frontend treats absent
/// and damaged alike (defaults), and the next write repairs the file. Other I/O errors (a locked file)
/// are errors: the real file may be fine.
pub fn read_preferences_at(p: &Path) -> Result<Option<String>> {
    match fs::metadata(p) {
        Ok(m) if m.len() > MAX_PREFERENCES_BYTES as u64 => return Ok(None),
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(p, e)),
    }
    match fs::read_to_string(p) {
        Ok(s) if s.len() > MAX_PREFERENCES_BYTES => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == ErrorKind::InvalidData => Ok(None),
        Err(e) => Err(io(p, e)),
    }
}

/// Atomically replace the preferences file (creating the config dir on first write).
#[tauri::command]
pub fn preferences_write<R: Runtime>(app: AppHandle<R>, contents: String) -> Result<()> {
    write_preferences_at(&preferences_file(&app)?, &contents)
}

/// Atomically replace the preferences file at `p` (creating its folder), refusing oversized contents.
pub fn write_preferences_at(p: &Path, contents: &str) -> Result<()> {
    check_size(contents)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| io(dir, e))?;
    }
    write_atomic(p, contents.as_bytes())
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
    // Asked in order, each only when the ones before gave nothing.
    let sources: [fn() -> Option<String>; 4] = [
        || whoami::realname().ok(),
        || whoami::username().ok(),
        || std::env::var("USERNAME").ok(),
        || std::env::var("USER").ok(),
    ];
    first_author_name(sources.iter().map(|f| f()))
}

/// The first candidate that is not blank, trimmed; empty when there is none.
pub fn first_author_name(candidates: impl IntoIterator<Item = Option<String>>) -> String {
    candidates
        .into_iter()
        .flatten()
        .map(|s| s.trim().to_string())
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
    fn author_name_is_the_first_non_blank_candidate_trimmed() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(first_author_name([s("  Ada Lovelace \n"), s("ada")]), "Ada Lovelace");
        assert_eq!(first_author_name([s("   "), None, s(" ada ")]), "ada");
        assert_eq!(first_author_name([None, s("\t"), s("")]), "");
        assert_eq!(first_author_name(Vec::<Option<String>>::new()), "");
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("novel-prefs-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn preferences_write_creates_the_folder_and_replaces_a_damaged_file() {
        let dir = temp_dir("write");
        let file = dir.join("config").join(PREFERENCES_FILE_NAME);
        assert_eq!(read_preferences_at(&file).unwrap(), None);
        write_preferences_at(&file, "{ not json").unwrap();
        write_preferences_at(&file, "{\"version\":1}").unwrap();
        assert_eq!(read_preferences_at(&file).unwrap().as_deref(), Some("{\"version\":1}"));
        let big = "x".repeat(MAX_PREFERENCES_BYTES + 1);
        assert_eq!(write_preferences_at(&file, &big).unwrap_err().kind, "invalid_path");
        assert_eq!(read_preferences_at(&file).unwrap().as_deref(), Some("{\"version\":1}"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preferences_read_treats_an_oversized_or_non_utf8_file_as_damaged() {
        let dir = temp_dir("read");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(PREFERENCES_FILE_NAME);
        fs::write(&file, vec![b' '; MAX_PREFERENCES_BYTES + 1]).unwrap();
        assert_eq!(read_preferences_at(&file).unwrap(), None);
        fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_preferences_at(&file).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
