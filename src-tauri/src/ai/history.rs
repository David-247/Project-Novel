//! Tutor chat history: `tutor-history/<project id>/<chat id>.json` in the app data dir. Never in a
//! project folder (the project id is the project's `meta.id`, so history does not travel with a
//! copied or shared project). Messages are stored as sent, attached text included, so a chat can be
//! resumed; they are not encrypted, the same as the project files. Rust treats a message as opaque
//! JSON: the webview owns its shape. Nothing here puts file contents in an error message.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::AiError;

/// Folder name inside the app data dir.
pub const HISTORY_DIR: &str = "tutor-history";
/// A chat file larger than this is refused on save and on load, so a runaway chat cannot fill the disk.
pub const MAX_CHAT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ID_CHARS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub connection_id: String,
    pub model_id: String,
    /// Opaque to Rust (`StoredMessage` in the webview).
    pub messages: Vec<Value>,
    /// Unknown keys, written back unchanged.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// Windows device names: a file called one of these is not a file (also with an extension).
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3",
    "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// `^[A-Za-z0-9-]{1,64}$` and not a Windows reserved device name (any case): a project's `meta.id` is
/// a UUID, a chat id is generated the same way.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !RESERVED_NAMES.iter().any(|r| id.eq_ignore_ascii_case(r))
}

fn check_id(id: &str, what: &str) -> Result<(), AiError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(AiError::bad_request(format!("The {what} id is not valid.")))
    }
}

fn project_dir(root: &Path, project_id: &str) -> Result<PathBuf, AiError> {
    check_id(project_id, "project")?;
    Ok(root.join(project_id))
}

fn chat_file(root: &Path, project_id: &str, chat_id: &str) -> Result<PathBuf, AiError> {
    check_id(chat_id, "chat")?;
    Ok(project_dir(root, project_id)?.join(format!("{chat_id}.json")))
}

fn read_error() -> AiError {
    AiError::bad_request("The chat history could not be read.")
}

fn write_error() -> AiError {
    AiError::bad_request("The chat history could not be saved.")
}

/// All of a project's chats, newest first. A damaged or oversized file is left out.
pub fn list(root: &Path, project_id: &str) -> Result<Vec<ChatSummary>, AiError> {
    let dir = project_dir(root, project_id)?;
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(read_error()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
        if !valid_id(stem) {
            continue;
        }
        if let Ok(chat) = read_chat(&entry.path()) {
            if chat.id == stem {
                out.push(ChatSummary { id: chat.id, title: chat.title, updated_at: chat.updated_at });
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

fn read_chat(path: &Path) -> Result<Chat, AiError> {
    let meta = fs::metadata(path).map_err(|_| read_error())?;
    if meta.len() > MAX_CHAT_BYTES as u64 {
        return Err(AiError::bad_request("This chat is too large to open."));
    }
    let text = fs::read_to_string(path).map_err(|_| read_error())?;
    serde_json::from_str(&text).map_err(|_| AiError::bad_request("This chat is damaged and cannot be opened."))
}

pub fn load(root: &Path, project_id: &str, chat_id: &str) -> Result<Chat, AiError> {
    let path = chat_file(root, project_id, chat_id)?;
    let chat = read_chat(&path)?;
    if chat.id != chat_id {
        return Err(AiError::bad_request("This chat is damaged and cannot be opened."));
    }
    Ok(chat)
}

/// Atomically write the chat (creating the project's folder). Over [`MAX_CHAT_BYTES`] is refused.
pub fn save(root: &Path, project_id: &str, chat: &Chat) -> Result<(), AiError> {
    let path = chat_file(root, project_id, &chat.id)?;
    let text = serde_json::to_vec(chat).map_err(|_| write_error())?;
    if text.len() > MAX_CHAT_BYTES {
        return Err(AiError::bad_request("This chat is too large to save. Start a new chat."));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|_| write_error())?;
    }
    crate::storage::write_atomic(&path, &text).map_err(|_| write_error())
}

/// Delete one chat, or (`None`) all of the project's chats. Missing is fine.
pub fn delete(root: &Path, project_id: &str, chat_id: Option<&str>) -> Result<(), AiError> {
    let result = match chat_id {
        Some(id) => fs::remove_file(chat_file(root, project_id, id)?),
        None => fs::remove_dir_all(project_dir(root, project_id)?),
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AiError::bad_request("The chat history could not be deleted.")),
    }
}

/// Delete every project's chats.
pub fn clear_all(root: &Path) -> Result<(), AiError> {
    match fs::remove_dir_all(root) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AiError::bad_request("The chat history could not be deleted.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PROJECT: &str = "0b6f2c1e-8d1a-4c1e-9f55-1f2e3d4c5b6a";

    fn chat(id: &str, updated: &str) -> Chat {
        Chat {
            id: id.into(),
            title: format!("title {id}"),
            created_at: "2026-11-19T10:00:00.000Z".into(),
            updated_at: updated.into(),
            connection_id: "c1".into(),
            model_id: "m1".into(),
            messages: vec![json!({"role": "user", "content": "Hi", "attachments": [{"label": "p1", "text": "As sent"}]})],
            extra: Map::new(),
        }
    }

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = chat("chat-1", "2026-11-19T10:05:00.000Z");
        c.extra.insert("future".into(), json!({"k": 1}));
        save(dir.path(), PROJECT, &c).unwrap();
        assert_eq!(load(dir.path(), PROJECT, "chat-1").unwrap(), c);
        save(dir.path(), PROJECT, &chat("chat-2", "2026-11-19T11:00:00.000Z")).unwrap();
        let listed = list(dir.path(), PROJECT).unwrap();
        assert_eq!(listed.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["chat-2", "chat-1"]);
        assert_eq!(
            listed[1],
            ChatSummary { id: "chat-1".into(), title: "title chat-1".into(), updated_at: "2026-11-19T10:05:00.000Z".into() }
        );
        assert!(list(dir.path(), "other-project").unwrap().is_empty());
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let dir = tempfile::tempdir().unwrap();
        let long = "a".repeat(65);
        for bad in ["", "..", "../x", "a/b", "a\\b", "a.b", "a b", "\u{e9}", long.as_str()] {
            assert_eq!(load(dir.path(), PROJECT, bad).unwrap_err().kind, "bad_request", "chat {bad:?}");
            assert_eq!(load(dir.path(), bad, "chat-1").unwrap_err().kind, "bad_request", "project {bad:?}");
            assert_eq!(list(dir.path(), bad).unwrap_err().kind, "bad_request");
            assert_eq!(delete(dir.path(), bad, None).unwrap_err().kind, "bad_request");
            assert_eq!(delete(dir.path(), PROJECT, Some(bad)).unwrap_err().kind, "bad_request");
            assert_eq!(save(dir.path(), bad, &chat("chat-1", "t")).unwrap_err().kind, "bad_request");
            assert_eq!(save(dir.path(), PROJECT, &chat(bad, "t")).unwrap_err().kind, "bad_request");
        }
        for reserved in ["CON", "con", "Nul", "AUX", "prn", "COM1", "com9", "LPT1", "lpt9"] {
            assert_eq!(load(dir.path(), PROJECT, reserved).unwrap_err().kind, "bad_request", "chat {reserved}");
            assert_eq!(list(dir.path(), reserved).unwrap_err().kind, "bad_request", "project {reserved}");
            assert_eq!(save(dir.path(), PROJECT, &chat(reserved, "t")).unwrap_err().kind, "bad_request");
        }
        assert!(valid_id("com10") && valid_id("con-1") && valid_id("COM0") && valid_id("lpt"));
        assert!(valid_id(&"a".repeat(64)));
        assert!(valid_id(PROJECT));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn delete_project_removes_folder() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), PROJECT, &chat("chat-1", "t1")).unwrap();
        save(dir.path(), PROJECT, &chat("chat-2", "t2")).unwrap();
        save(dir.path(), "keep", &chat("chat-1", "t1")).unwrap();
        delete(dir.path(), PROJECT, Some("chat-1")).unwrap();
        assert_eq!(list(dir.path(), PROJECT).unwrap().len(), 1);
        delete(dir.path(), PROJECT, None).unwrap();
        assert!(!dir.path().join(PROJECT).exists());
        assert_eq!(list(dir.path(), "keep").unwrap().len(), 1);
        delete(dir.path(), PROJECT, None).unwrap();
        clear_all(dir.path()).unwrap();
        assert!(!dir.path().join("keep").exists());
        clear_all(dir.path()).unwrap();
    }

    #[test]
    fn history_dir_is_outside_project() {
        let app_data = PathBuf::from("app-data");
        let root = app_data.join(HISTORY_DIR);
        let file = chat_file(&root, PROJECT, "chat-1").unwrap();
        assert!(file.starts_with(&app_data));
        assert_eq!(file, app_data.join("tutor-history").join(PROJECT).join("chat-1.json"));
    }

    #[test]
    fn refuses_oversized_chats_without_echoing_content() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = chat("chat-1", "t");
        c.messages = vec![json!({"role": "user", "content": "SECRET".repeat(MAX_CHAT_BYTES / 6 + 1)})];
        let err = save(dir.path(), PROJECT, &c).unwrap_err();
        assert_eq!(err.kind, "bad_request");
        assert!(!err.message.contains("SECRET"));
        assert!(!dir.path().join(PROJECT).join("chat-1.json").exists());
        // An oversized file already on disk is refused on load.
        fs::create_dir_all(dir.path().join(PROJECT)).unwrap();
        fs::write(dir.path().join(PROJECT).join("big.json"), vec![b' '; MAX_CHAT_BYTES + 1]).unwrap();
        assert_eq!(load(dir.path(), PROJECT, "big").unwrap_err().kind, "bad_request");
    }

    #[test]
    fn damaged_files_do_not_break_list_and_errors_hide_contents() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), PROJECT, &chat("chat-1", "t1")).unwrap();
        fs::write(dir.path().join(PROJECT).join("bad.json"), "{ SECRET not json").unwrap();
        fs::write(dir.path().join(PROJECT).join("notes.txt"), "x").unwrap();
        assert_eq!(list(dir.path(), PROJECT).unwrap().len(), 1);
        let err = load(dir.path(), PROJECT, "bad").unwrap_err();
        assert!(!err.message.contains("SECRET"));
    }
}
