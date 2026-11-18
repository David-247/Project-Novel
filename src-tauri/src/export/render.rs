//! Runs the bundled Typst CLI on one template: in a private temp dir, offline, with a timeout and
//! cancellation, and with stderr parsed into structured diagnostics. The temp dir is removed on
//! every path (success, compile error, timeout, cancel).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{templates, ExportError};

/// One Typst diagnostic, from `--diagnostic-format short` lines such as
/// `<path>:3:5: error: unknown variable: foo` (followed by optional `hint: ...` lines).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// "error" | "warning"
    pub severity: &'static str,
    /// "template" (main.typ), "data" (data.json), another file name, or none.
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
    pub hints: Vec<String>,
}

/// What to render, and where Typst may look.
pub struct RenderSpec<'a> {
    /// The Typst CLI (the sidecar).
    pub sidecar: &'a Path,
    /// Folders searched for fonts (the bundled fallbacks).
    pub font_dirs: &'a [PathBuf],
    /// Template source (main.typ).
    pub template: &'a str,
    /// The data file (data.json) the template reads.
    pub data_json: &'a str,
    /// `sys.inputs` key/value pairs.
    pub inputs: &'a [(String, String)],
    /// Search only `font_dirs` (so the output is the same on every machine).
    pub ignore_system_fonts: bool,
    pub timeout: Duration,
    /// Where the private temp dir is created (the OS temp dir in the app).
    pub temp_parent: &'a Path,
    /// Called with the child's process id once Typst is running (tests check it was killed).
    pub on_spawn: Option<&'a (dyn Fn(u32) + Sync)>,
}

#[derive(Debug)]
pub struct Rendered {
    pub pdf: Vec<u8>,
    pub warnings: Vec<Diagnostic>,
}

/// Every request goes through the offline guard first: a template with a package import never runs.
pub fn render(spec: &RenderSpec, cancel: &AtomicBool) -> Result<Rendered, ExportError> {
    templates::check_offline(spec.template)?;
    render_unchecked(spec, cancel)
}

/// Render without the source guard. Only the tests call this directly (to show that the process
/// itself cannot fetch a package even if a template slipped past the guard).
pub(crate) fn render_unchecked(spec: &RenderSpec, cancel: &AtomicBool) -> Result<Rendered, ExportError> {
    if !spec.sidecar.is_file() {
        return Err(ExportError::new(
            "sidecar_missing",
            format!(
                "The PDF engine (Typst) is missing at {}. Run `node scripts/fetch-typst.mjs` (development) or reinstall Novel.",
                spec.sidecar.display()
            ),
        ));
    }
    let tmp = tempfile::Builder::new()
        .prefix("novel-typst-")
        .tempdir_in(spec.temp_parent)
        .map_err(|e| ExportError::io(spec.temp_parent, e))?;
    let dir = tmp.path().to_path_buf();
    let result = run_in(&dir, spec, cancel);
    remove_temp(tmp, &dir);
    result
}

/// Delete the temp dir; retried briefly, because on Windows a scanner (antivirus, indexer) can hold
/// a fresh file for a moment after the child exits.
fn remove_temp(tmp: tempfile::TempDir, dir: &Path) {
    if tmp.close().is_ok() {
        return;
    }
    for ms in [25, 50, 100, 200, 400] {
        std::thread::sleep(Duration::from_millis(ms));
        if fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return;
        }
    }
    eprintln!("export: could not remove the temp folder {}", dir.display());
}

/// An unreachable proxy (discard port on loopback): any download Typst attempted would fail at once.
const DEAD_PROXY: &str = "http://127.0.0.1:9";

/// Environment for the child: every proxy points at DEAD_PROXY, and no inherited Typst setting
/// (package paths, font paths, root, features) can override the command line.
fn offline_env(cmd: &mut Command) {
    for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
        cmd.env(k, DEAD_PROXY);
    }
    for k in [
        "NO_PROXY",
        "no_proxy",
        "TYPST_ROOT",
        "TYPST_FONT_PATHS",
        "TYPST_IGNORE_SYSTEM_FONTS",
        "TYPST_IGNORE_EMBEDDED_FONTS",
        "TYPST_PACKAGE_PATH",
        "TYPST_PACKAGE_CACHE_PATH",
        "TYPST_FEATURES",
        "TYPST_CERT",
        "SOURCE_DATE_EPOCH",
    ] {
        cmd.env_remove(k);
    }
}

/// The typst command line. Fixed flags only: the webview never supplies arguments.
fn command(dir: &Path, spec: &RenderSpec) -> Result<Command, ExportError> {
    let mut cmd = Command::new(spec.sidecar);
    cmd.arg("compile")
        .arg("--root")
        .arg(dir)
        // Empty package folders: nothing can resolve from a local or cached package.
        .arg("--package-path")
        .arg(dir.join("packages"))
        .arg("--package-cache-path")
        .arg(dir.join("package-cache"))
        // Only the fonts we choose (Typst's own embedded fonts would hide a missing family).
        .arg("--ignore-embedded-fonts")
        .arg("--diagnostic-format")
        .arg("short");
    if !spec.font_dirs.is_empty() {
        let joined = std::env::join_paths(spec.font_dirs)
            .map_err(|e| ExportError::new("io", format!("Invalid font folder: {e}")))?;
        cmd.arg("--font-path").arg(joined);
    }
    if spec.ignore_system_fonts {
        cmd.arg("--ignore-system-fonts");
    }
    for (k, v) in spec.inputs {
        cmd.arg("--input").arg(format!("{k}={v}"));
    }
    cmd.arg(dir.join("main.typ")).arg(dir.join("out.pdf"));
    cmd.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null());
    offline_env(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // no console window flashing up from a GUI app
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Kill the child and reap it (so its file handles are closed before the temp dir is removed).
fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

const POLL: Duration = Duration::from_millis(15);

/// Typst processes started and not yet reaped (app exit waits for this to reach zero).
static LIVE_CHILDREN: AtomicUsize = AtomicUsize::new(0);

struct LiveChild;

impl LiveChild {
    fn new() -> Self {
        LIVE_CHILDREN.fetch_add(1, Ordering::SeqCst);
        LiveChild
    }
}

impl Drop for LiveChild {
    fn drop(&mut self) {
        LIVE_CHILDREN.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Wait until no Typst process is running (after the cancel flags were set), up to `max`.
/// True when none is left.
pub fn wait_for_children(max: Duration) -> bool {
    let started = Instant::now();
    while LIVE_CHILDREN.load(Ordering::SeqCst) > 0 {
        if started.elapsed() >= max {
            return false;
        }
        std::thread::sleep(POLL);
    }
    true
}

/// stderr read back at most this much (a runaway template cannot make us load a huge file).
const MAX_STDERR_BYTES: u64 = 1024 * 1024;

fn read_stderr(path: &Path) -> String {
    use std::io::Read;
    let mut buf = Vec::new();
    if let Ok(f) = fs::File::open(path) {
        let _ = f.take(MAX_STDERR_BYTES).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn run_in(dir: &Path, spec: &RenderSpec, cancel: &AtomicBool) -> Result<Rendered, ExportError> {
    let write = |name: &str, contents: &str| {
        let p = dir.join(name);
        fs::write(&p, contents).map_err(|e| ExportError::io(&p, e))
    };
    write("main.typ", spec.template)?;
    write("data.json", spec.data_json)?;
    for sub in ["packages", "package-cache"] {
        let p = dir.join(sub);
        fs::create_dir(&p).map_err(|e| ExportError::io(&p, e))?;
    }
    // stderr goes to a file (no pipe to drain, so a chatty child can never block on a full pipe).
    let stderr_path = dir.join("stderr.txt");
    let stderr = fs::File::create(&stderr_path).map_err(|e| ExportError::io(&stderr_path, e))?;

    let mut cmd = command(dir, spec)?;
    cmd.stderr(stderr);
    if cancel.load(Ordering::SeqCst) {
        return Err(ExportError::cancelled());
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| ExportError::new("spawn", format!("Could not start the PDF engine: {e}")))?;
    // Counted until reaped (every path below either sees the exit or kills and waits).
    let _live = LiveChild::new();
    if let Some(f) = spec.on_spawn {
        f(child.id());
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                kill(&mut child);
                return Err(ExportError::new("spawn", format!("Lost track of the PDF engine: {e}")));
            }
        }
        if cancel.load(Ordering::SeqCst) {
            kill(&mut child);
            return Err(ExportError::cancelled());
        }
        if started.elapsed() >= spec.timeout {
            kill(&mut child);
            return Err(ExportError::new(
                "timeout",
                format!("The PDF took longer than {} seconds to create, so it was stopped.", spec.timeout.as_secs_f32()),
            ));
        }
        std::thread::sleep(POLL);
    };

    let diagnostics = parse_diagnostics(&read_stderr(&stderr_path));
    let out = dir.join("out.pdf");
    if status.success() && out.is_file() {
        let pdf = fs::read(&out).map_err(|e| ExportError::io(&out, e))?;
        return Ok(Rendered { pdf, warnings: diagnostics });
    }
    let package = diagnostics
        .iter()
        .any(|d| d.message.contains("download package") || d.message.contains("package not found"));
    let first = diagnostics.iter().find(|d| d.severity == "error").map(|d| d.message.clone());
    let mut err = ExportError::new(
        if package { "package_import" } else { "compile" },
        first.unwrap_or_else(|| format!("The PDF engine failed ({status}).")),
    );
    err.diagnostics = diagnostics;
    Err(err)
}

/// Label for a diagnostic's file, never the temp path itself.
fn file_label(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name {
        "main.typ" => "template".into(),
        "data.json" => "data".into(),
        other => other.into(),
    }
}

/// Parse `--diagnostic-format short` stderr. Lines that match no diagnostic are kept as hints of
/// the one before (or, first of all, as an error of their own), so nothing Typst said is lost.
pub fn parse_diagnostics(stderr: &str) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    for raw in stderr.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(hint) = line.trim_start().strip_prefix("hint: ") {
            match out.last_mut() {
                Some(d) => d.hints.push(hint.to_string()),
                None => out.push(plain("error", hint)),
            }
            continue;
        }
        match split_diagnostic(line) {
            Some(d) => out.push(d),
            None => match out.last_mut() {
                Some(d) => d.hints.push(line.trim().to_string()),
                None => out.push(plain("error", line.trim())),
            },
        }
    }
    out
}

fn plain(severity: &'static str, message: &str) -> Diagnostic {
    Diagnostic { severity, file: None, line: None, column: None, message: message.to_string(), hints: Vec::new() }
}

fn split_diagnostic(line: &str) -> Option<Diagnostic> {
    for severity in ["error", "warning"] {
        let bare = format!("{severity}: ");
        if let Some(message) = line.strip_prefix(&bare) {
            return Some(plain(severity, message));
        }
    }
    // The earliest ": error: " / ": warning: " (a message may itself contain the words).
    let (at, severity) = ["error", "warning"]
        .iter()
        .filter_map(|s| line.find(&format!(": {s}: ")).map(|i| (i, *s)))
        .min_by_key(|(i, _)| *i)?;
    let location = &line[..at];
    let message = &line[at + severity.len() + 4..];
    let mut d = plain(severity, message);
    let mut parts = location.rsplitn(3, ':');
    let col = parts.next().and_then(|c| c.parse::<u32>().ok());
    let row = parts.next().and_then(|r| r.parse::<u32>().ok());
    match (row, col, parts.next()) {
        (Some(row), Some(col), Some(path)) => {
            d.file = Some(file_label(path));
            d.line = Some(row);
            d.column = Some(col);
        }
        _ => d.file = Some(file_label(location)),
    }
    Some(d)
}

/// The font names embedded in a PDF (from `/BaseFont` entries): subset tags (`ABCDEF+`) and CID
/// suffixes (`-Identity-H`) removed, `#xx` escapes decoded, sorted, de-duplicated. This is what the
/// wizard reports as the font actually used.
pub fn pdf_font_names(pdf: &[u8]) -> Vec<String> {
    const KEY: &[u8] = b"/BaseFont";
    let mut names = std::collections::BTreeSet::new();
    let mut i = 0;
    while let Some(off) = find(&pdf[i..], KEY) {
        let mut j = i + off + KEY.len();
        while j < pdf.len() && pdf[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < pdf.len() && pdf[j] == b'/' {
            j += 1;
            let start = j;
            while j < pdf.len() && !b" \t\r\n\x0c/[]<>()%{}".contains(&pdf[j]) {
                j += 1;
            }
            let name = decode_name(&pdf[start..j]);
            let name = match name.split_once('+') {
                Some((tag, rest)) if tag.len() == 6 && tag.bytes().all(|b| b.is_ascii_uppercase()) => rest.to_string(),
                _ => name,
            };
            let name = name.strip_suffix("-Identity-H").map(str::to_string).unwrap_or(name);
            if !name.is_empty() {
                names.insert(name);
            }
        }
        i = j.max(i + off + KEY.len());
    }
    names.into_iter().collect()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn decode_name(raw: &[u8]) -> String {
    let mut out = Vec::with_capacity(raw.len());
    let mut k = 0;
    while k < raw.len() {
        if raw[k] == b'#' && k + 2 < raw.len() {
            if let Ok(b) = u8::from_str_radix(&String::from_utf8_lossy(&raw[k + 1..k + 3]), 16) {
                out.push(b);
                k += 3;
                continue;
            }
        }
        out.push(raw[k]);
        k += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_short_diagnostics_without_leaking_the_temp_path() {
        let stderr = "\\\\?\\C:\\Temp\\novel-typst-ab12\\main.typ:2:16: warning: unknown font family: times new roman\n\
                      /tmp/novel-typst-x/main.typ:7:1: error: unknown variable: foo\n  hint: if you meant to display multiple letters, add spaces\n\
                      /tmp/novel-typst-x/data.json:1:2: error: failed to parse JSON (expected value)\n\
                      error: input file not found (searched at main.typ)\n\
                      something odd\n";
        let d = parse_diagnostics(stderr);
        assert_eq!(d.len(), 4);
        assert_eq!(
            d[0],
            Diagnostic {
                severity: "warning",
                file: Some("template".into()),
                line: Some(2),
                column: Some(16),
                message: "unknown font family: times new roman".into(),
                hints: vec![],
            }
        );
        assert_eq!(d[1].severity, "error");
        assert_eq!((d[1].line, d[1].column), (Some(7), Some(1)));
        assert_eq!(d[1].hints, vec!["if you meant to display multiple letters, add spaces".to_string()]);
        assert_eq!(d[2].file.as_deref(), Some("data"));
        assert_eq!(d[3].file, None);
        assert_eq!(d[3].message, "input file not found (searched at main.typ)");
        assert_eq!(d[3].hints, vec!["something odd".to_string()]);
        assert!(d.iter().all(|x| !x.message.contains("novel-typst")));
    }

    #[test]
    fn reads_font_names_from_a_pdf() {
        let pdf = b"<< /Type /Font /BaseFont/DLTGTX+LiberationSerif-Bold >> << /BaseFont /DWCRDD+LiberationSerif \
                    /FontName/DWCRDD+LiberationSerif >> << /BaseFont/HNXCLH+Times#20New#20Roman-Identity-H >> /BaseFont/DLTGTX+LiberationSerif-Bold";
        assert_eq!(pdf_font_names(pdf), vec!["LiberationSerif", "LiberationSerif-Bold", "Times New Roman"]);
        assert!(pdf_font_names(b"no fonts here").is_empty());
    }
}
