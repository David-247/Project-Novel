//! Export file output: paths the user picked in the native Save dialog (the only paths an export
//! may write), the atomic write (storage's temp-file-then-rename), and the record of files written,
//! which is all "reveal in folder" will show.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ExportError;
use crate::storage;

/// The export file types and their Save dialog filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Pdf,
    Docx,
}

impl FileKind {
    pub fn extension(self) -> &'static str {
        match self {
            FileKind::Pdf => "pdf",
            FileKind::Docx => "docx",
        }
    }
    pub fn filter_name(self) -> &'static str {
        match self {
            FileKind::Pdf => "PDF document",
            FileKind::Docx => "Word document",
        }
    }
}

/// Picked paths kept (oldest forgotten first) and written files remembered for reveal.
const MAX_PICKED: usize = 16;
const MAX_EXPORTED: usize = 32;

/// Save-dialog grants and written exports. Only Rust adds to either list: a grant comes from the
/// native Save dialog, an export from a successful write to a granted path. Tokens are handles,
/// not secrets: every token maps to a path the user chose, so guessing one gains nothing.
#[derive(Default, Debug)]
pub struct Targets {
    next: u64,
    picked: Vec<(String, PathBuf, FileKind)>,
    exported: Vec<PathBuf>,
}

impl Targets {
    /// Record a path the user picked in the Save dialog; returns its token.
    pub fn grant(&mut self, path: PathBuf, kind: FileKind) -> String {
        self.next += 1;
        let token = format!("export-{}", self.next);
        self.picked.push((token.clone(), path, kind));
        if self.picked.len() > MAX_PICKED {
            self.picked.remove(0);
        }
        token
    }

    /// The path behind `token`, if it was granted for this kind of file.
    pub fn target(&self, token: &str, kind: FileKind) -> Result<PathBuf, ExportError> {
        self.picked
            .iter()
            .find(|(t, _, k)| t == token && *k == kind)
            .map(|(_, p, _)| p.clone())
            .ok_or_else(|| {
                ExportError::new("invalid_token", "Choose where to save the file first (the Save dialog was not used).")
            })
    }

    /// The folder of the most recent grant, of any kind: where the next Save dialog starts, so the
    /// PDF dialog of a DOCX + PDF export opens where the DOCX was just saved. Rust's own record; the
    /// webview names no folder.
    pub fn last_folder(&self) -> Option<PathBuf> {
        self.picked.last().and_then(|(_, p, _)| p.parent().map(Path::to_path_buf))
    }

    pub fn mark_exported(&mut self, path: &Path) {
        self.exported.retain(|p| p != path);
        self.exported.push(path.to_path_buf());
        if self.exported.len() > MAX_EXPORTED {
            self.exported.remove(0);
        }
    }

    /// `path` if this app exported it (compared after resolving links and `..`) and it still exists.
    pub fn exported_file(&self, path: &str) -> Result<PathBuf, ExportError> {
        let refuse = || ExportError::new("not_exported", "Novel only shows files it has just exported.");
        let wanted = std::fs::canonicalize(path).map_err(|_| refuse())?;
        self.exported
            .iter()
            .find(|p| std::fs::canonicalize(p).map(|c| c == wanted).unwrap_or(false))
            .cloned()
            .ok_or_else(refuse)
    }
}

/// The Save dialog's path with the kind's extension added when the user typed none.
pub fn with_extension(path: PathBuf, kind: FileKind) -> PathBuf {
    if path.extension().is_some() {
        path
    } else {
        path.with_extension(kind.extension())
    }
}

/// A default file name safe to offer in the dialog (no folders, no characters Windows refuses).
pub fn safe_file_name(name: &str, kind: FileKind) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    let base = if cleaned.is_empty() { "Manuscript".to_string() } else { cleaned };
    let ext = format!(".{}", kind.extension());
    if base.to_lowercase().ends_with(&ext) {
        base
    } else {
        format!("{base}{ext}")
    }
}

/// The Save dialog's starting folder: `dir` when it is an absolute path to an existing folder, else
/// none (the dialog's own default). A hint only: it grants no write.
pub fn start_directory(dir: &Path) -> Option<PathBuf> {
    if dir.as_os_str().is_empty() || !dir.is_absolute() || !dir.is_dir() {
        return None;
    }
    Some(dir.to_path_buf())
}

/// Rust's record of the last export folder per project (app data dir), so the first Save dialog after
/// a restart opens where the last export went. Written only by Rust, after a successful export write;
/// the webview never names a folder. Keyed by the project's canonical root ("" with no project open).
pub const EXPORT_FOLDERS_FILE: &str = "export-folders.json";
/// Projects remembered (oldest forgotten first).
const MAX_REMEMBERED: usize = 32;

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RememberedFolders {
    #[serde(default)]
    pub folders: Vec<RememberedFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RememberedFolder {
    pub project: String,
    pub folder: String,
}

impl RememberedFolders {
    /// Parse the file; a missing or damaged one is empty.
    pub fn parse(text: Option<&str>) -> Self {
        text.and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default()
    }
    pub fn folder_for(&self, project: &str) -> Option<PathBuf> {
        self.folders.iter().find(|f| f.project == project).map(|f| PathBuf::from(&f.folder))
    }
    /// Remember `folder` for `project` (most recent last, at most MAX_REMEMBERED).
    pub fn remember(&mut self, project: &str, folder: &Path) {
        self.folders.retain(|f| f.project != project);
        self.folders.push(RememberedFolder { project: project.to_string(), folder: folder.to_string_lossy().into_owned() });
        let extra = self.folders.len().saturating_sub(MAX_REMEMBERED);
        self.folders.drain(..extra);
    }
}

/// Write export bytes atomically (storage's temp file + fsync + rename, symlink refused): a failure
/// leaves the previous file, or nothing, never a partial file.
pub fn write_export(target: &Path, bytes: &[u8]) -> Result<(), ExportError> {
    storage::write_atomic(target, bytes).map_err(ExportError::from)
}

/// A Windows path as Explorer accepts it: verbatim prefixes dropped, `\\?\UNC\server\share\x`
/// mapped back to `\\server\share\x` (stripping only `\\?\` would leave `UNC\server\...`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn explorer_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

/// Explorer's argument to show `path` selected: `/select,"<path>"` as one raw argument (the path in
/// quotes, so commas and spaces in it are kept). Paths cannot contain `"` on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn explorer_select_arg(path: &str) -> String {
    format!("/select,\"{}\"", explorer_path(path))
}

/// Explorer's argument to open `path` with its program: the path in quotes (commas and spaces kept).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn explorer_open_arg(path: &str) -> String {
    format!("\"{}\"", explorer_path(path))
}

/// Show `path` selected in Explorer / Finder. Callers check it was exported first.
pub fn reveal(path: &Path) -> Result<(), ExportError> {
    let spawn_err = |e: std::io::Error| ExportError::new("io", format!("Could not open the folder: {e}"));
    // Full paths: never whatever `explorer` / `open` the PATH or working folder would find.
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        // explorer wants `/select,"<path>"` as one raw argument (Rust's quoting would wrap all of it).
        // Paths cannot contain `"` on Windows.
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let mut cmd = std::process::Command::new(Path::new(&root).join("explorer.exe"));
        cmd.raw_arg(explorer_select_arg(&path.to_string_lossy()));
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("/usr/bin/open");
        cmd.arg("-R").arg(path);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("/usr/bin/xdg-open");
        cmd.arg(path.parent().unwrap_or(path));
        cmd
    };
    let mut child = cmd.spawn().map_err(spawn_err)?;
    // Reap it off-thread (explorer's exit code means nothing; this only avoids a zombie on Unix).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Open an exported file with its default app. Callers check it was exported first; only .docx and
/// .pdf files are opened (an exported file is always one of them), so nothing else can be launched.
pub fn open_exported(path: &Path) -> Result<(), ExportError> {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("docx") | Some("pdf")) {
        return Err(ExportError::new("not_exported", "Novel only opens the DOCX and PDF files it exported."));
    }
    let spawn_err = |e: std::io::Error| ExportError::new("io", format!("Could not open the file: {e}"));
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        // explorer.exe <file> opens it with the program associated with its type.
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let mut cmd = std::process::Command::new(Path::new(&root).join("explorer.exe"));
        // Quoted by hand: Rust quotes only arguments with spaces, and Explorer splits an unquoted
        // argument at a comma ("C:\\Smith,Ann\\x.pdf").
        cmd.raw_arg(explorer_open_arg(&path.to_string_lossy()));
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("/usr/bin/open");
        cmd.arg(path);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("/usr/bin/xdg-open");
        cmd.arg(path);
        cmd
    };
    let mut child = cmd.spawn().map_err(spawn_err)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("novel-export-files-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn tokens_map_only_to_granted_paths_of_their_kind() {
        let mut t = Targets::default();
        let tok = t.grant(PathBuf::from("/x/book.pdf"), FileKind::Pdf);
        assert_eq!(t.target(&tok, FileKind::Pdf).unwrap(), PathBuf::from("/x/book.pdf"));
        assert_eq!(t.target(&tok, FileKind::Docx).unwrap_err().kind, "invalid_token");
        assert_eq!(t.target("export-999", FileKind::Pdf).unwrap_err().kind, "invalid_token");
        for i in 0..MAX_PICKED {
            t.grant(PathBuf::from(format!("/x/{i}.pdf")), FileKind::Pdf);
        }
        assert_eq!(t.target(&tok, FileKind::Pdf).unwrap_err().kind, "invalid_token", "oldest grant forgotten");
    }

    #[test]
    fn reveal_refuses_paths_it_did_not_export() {
        let dir = temp_dir("reveal");
        let exported = dir.join("book.pdf");
        let other = dir.join("other.pdf");
        fs::write(&exported, "pdf").unwrap();
        fs::write(&other, "pdf").unwrap();
        let mut t = Targets::default();
        assert_eq!(t.exported_file(&exported.to_string_lossy()).unwrap_err().kind, "not_exported");
        t.mark_exported(&exported);
        assert_eq!(t.exported_file(&exported.to_string_lossy()).unwrap(), exported);
        // Another spelling of the same file still matches; any other file, or a missing one, does not.
        let spelled = dir.join(".").join("book.pdf");
        assert!(t.exported_file(&spelled.to_string_lossy()).is_ok());
        assert_eq!(t.exported_file(&other.to_string_lossy()).unwrap_err().kind, "not_exported");
        assert_eq!(t.exported_file(&dir.to_string_lossy()).unwrap_err().kind, "not_exported");
        assert_eq!(t.exported_file("relative.pdf").unwrap_err().kind, "not_exported");
        fs::remove_file(&exported).unwrap();
        assert_eq!(t.exported_file(&exported.to_string_lossy()).unwrap_err().kind, "not_exported");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_export_write_replaces_and_leaves_no_temp() {
        let dir = temp_dir("write");
        let target = dir.join("book.docx");
        fs::write(&target, "old, longer contents").unwrap();
        write_export(&target, b"new").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(entries(&dir), vec!["book.docx"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_export_write_leaves_no_partial_file() {
        let dir = temp_dir("write-fail");
        // The rename fails: the target is a folder. The previous contents stay; no temp file is left.
        let target = dir.join("book.pdf");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), "keep").unwrap();
        assert!(write_export(&target, b"%PDF-new").is_err());
        assert_eq!(entries(&dir), vec!["book.pdf"]);
        assert_eq!(entries(&target), vec!["keep.txt"]);
        // A missing folder: nothing is created.
        let missing = dir.join("gone").join("book.pdf");
        assert_eq!(write_export(&missing, b"x").unwrap_err().kind, "not_found");
        assert!(!dir.join("gone").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn explorer_paths_drop_verbatim_prefixes_and_keep_unc_shares() {
        assert_eq!(explorer_path(r"\\?\C:\Books\Novel.pdf"), r"C:\Books\Novel.pdf");
        assert_eq!(explorer_path(r"\\?\UNC\server\share\Novel.pdf"), r"\\server\share\Novel.pdf");
        assert_eq!(explorer_path(r"C:\Books\Novel.pdf"), r"C:\Books\Novel.pdf");
        assert_eq!(explorer_path(r"\\server\share\Novel.pdf"), r"\\server\share\Novel.pdf");
    }

    #[test]
    fn start_directory_only_for_an_existing_absolute_folder() {
        let dir = temp_dir("start");
        assert_eq!(start_directory(&dir), Some(dir.clone()));
        assert_eq!(start_directory(Path::new("relative/folder")), None);
        assert_eq!(start_directory(Path::new("")), None);
        assert_eq!(start_directory(&dir.join("missing")), None);
        fs::write(dir.join("file.txt"), b"x").unwrap();
        assert_eq!(start_directory(&dir.join("file.txt")), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_next_dialog_starts_in_the_folder_of_the_most_recent_grant_of_any_kind() {
        let mut t = Targets::default();
        assert_eq!(t.last_folder(), None);
        // A DOCX + PDF export: the PDF dialog opens where the DOCX was just saved.
        t.grant(PathBuf::from("/a/book.docx"), FileKind::Docx);
        assert_eq!(t.last_folder(), Some(PathBuf::from("/a")));
        t.grant(PathBuf::from("/b/book.pdf"), FileKind::Pdf);
        // The next export: its DOCX dialog opens where the last file (the PDF) went, not the last DOCX.
        assert_eq!(t.last_folder(), Some(PathBuf::from("/b")));
        t.grant(PathBuf::from("/c/other.docx"), FileKind::Docx);
        assert_eq!(t.last_folder(), Some(PathBuf::from("/c")));
    }

    #[test]
    fn remembered_folders_per_project_most_recent_last_and_capped() {
        let mut r = RememberedFolders::parse(None);
        r.remember("/p/one", Path::new("/out/one"));
        r.remember("/p/two", Path::new("/out/two"));
        r.remember("/p/one", Path::new("/out/one-b"));
        let text = serde_json::to_string(&r).unwrap();
        let back = RememberedFolders::parse(Some(&text));
        assert_eq!(back.folder_for("/p/one"), Some(PathBuf::from("/out/one-b")));
        assert_eq!(back.folder_for("/p/two"), Some(PathBuf::from("/out/two")));
        assert_eq!(back.folders.last().unwrap().project, "/p/one");
        assert_eq!(RememberedFolders::parse(Some("not json")), RememberedFolders::default());
        for i in 0..40 {
            r.remember(&format!("/p/{i}"), Path::new("/x"));
        }
        assert_eq!(r.folders.len(), MAX_REMEMBERED);
        assert_eq!(r.folder_for("/p/one"), None);
    }

    #[test]
    fn explorer_arguments_quote_paths_with_commas_and_spaces() {
        assert_eq!(explorer_select_arg(r"C:\Smith, Ann\Book.pdf"), r#"/select,"C:\Smith, Ann\Book.pdf""#);
        assert_eq!(explorer_open_arg(r"C:\Smith,Ann\Book.docx"), r#""C:\Smith,Ann\Book.docx""#);
        assert_eq!(explorer_open_arg(r"\\?\C:\Smith,Ann\Book.docx"), r#""C:\Smith,Ann\Book.docx""#);
    }

    #[test]
    fn open_exported_refuses_other_file_types() {
        assert_eq!(open_exported(Path::new("/x/run.exe")).unwrap_err().kind, "not_exported");
        assert_eq!(open_exported(Path::new("/x/notes")).unwrap_err().kind, "not_exported");
    }

    #[test]
    fn file_names_and_extensions() {
        assert_eq!(safe_file_name("My Novel", FileKind::Pdf), "My Novel.pdf");
        assert_eq!(safe_file_name("a/b\\c:d?", FileKind::Docx), "a_b_c_d_.docx");
        assert_eq!(safe_file_name("  ..  ", FileKind::Pdf), "Manuscript.pdf");
        assert_eq!(safe_file_name("Book.PDF", FileKind::Pdf), "Book.PDF");
        assert_eq!(with_extension(PathBuf::from("/x/book"), FileKind::Docx), PathBuf::from("/x/book.docx"));
        assert_eq!(with_extension(PathBuf::from("/x/book.pdf"), FileKind::Pdf), PathBuf::from("/x/book.pdf"));
    }
}
