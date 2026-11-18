//! Export platform commands (Phase 4): the Typst PDF sidecar, the native Save dialog, atomic export
//! writes and "reveal in folder". The DOCX and PDF generators (frontend, export slice) build on these.
//!
//! Offline: Typst runs with empty package folders, an unreachable proxy and templates that passed
//! the package-import guard (templates.rs). Least privilege: the webview never passes Typst source,
//! command-line arguments or a file path to write; it picks a bundled template by id, and writes go
//! only to a path the user chose in the Save dialog (shown by Rust, identified by a token).

mod files;
mod render;
mod templates;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

pub use files::FileKind;
pub use render::Diagnostic;

use crate::storage::StorageError;

/// Error returned to the frontend: a machine-readable kind, a message, and Typst's diagnostics.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportError {
    /// "package_import" | "unknown_template" | "sidecar_missing" | "spawn" | "compile" | "timeout" |
    /// "cancelled" | "busy" | "invalid_request" | "invalid_token" | "not_exported", or a storage
    /// kind for writes ("not_found" | "invalid_path" | "symlink" | "disk_full" | "read_only" |
    /// "permission_denied" | "io").
    pub kind: &'static str,
    pub message: String,
    pub diagnostics: Vec<Diagnostic>,
}

impl ExportError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        ExportError { kind, message: message.into(), diagnostics: Vec::new() }
    }
    fn io(path: &Path, err: std::io::Error) -> Self {
        Self::new(crate::storage::io_error_kind(&err), format!("{}: {}", path.display(), err))
    }
    fn cancelled() -> Self {
        Self::new("cancelled", "The export was cancelled.")
    }
    fn internal<E: std::fmt::Display>(e: E) -> Self {
        Self::new("io", e.to_string())
    }
}

impl From<StorageError> for ExportError {
    fn from(e: StorageError) -> Self {
        ExportError::new(e.kind, e.message)
    }
}

type Result<T> = std::result::Result<T, ExportError>;

/// Body font role. Manuscripts use Times New Roman (Standard) or Courier New (Classic); each has an
/// OFL metric-compatible fallback bundled with the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontRole {
    Serif,
    Mono,
}

impl FontRole {
    pub fn preferred(self) -> &'static str {
        match self {
            FontRole::Serif => "Times New Roman",
            FontRole::Mono => "Courier New",
        }
    }
    pub fn bundled(self) -> &'static str {
        match self {
            FontRole::Serif => "Liberation Serif",
            FontRole::Mono => "Liberation Mono",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FontSource {
    System,
    Bundled,
}

/// The installed preferred family when allowed and present; otherwise the bundled one (and then
/// only bundled fonts are searched, so the output is the same on every machine).
pub fn choose_font(role: FontRole, prefer_installed: bool, installed: &[String]) -> (&'static str, FontSource) {
    let want = role.preferred();
    if prefer_installed && installed.iter().any(|f| f.eq_ignore_ascii_case(want)) {
        (want, FontSource::System)
    } else {
        (role.bundled(), FontSource::Bundled)
    }
}

/// Which font the PDF actually used, for the wizard to report.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontReport {
    /// The family manuscripts expect (Times New Roman / Courier New).
    pub requested: &'static str,
    /// The family the PDF was set in.
    pub family: &'static str,
    pub source: FontSource,
    /// Font names embedded in the PDF (e.g. "TimesNewRomanPSMT", "LiberationSerif-Italic").
    pub embedded: Vec<String>,
}

/// Decide the reported font from the choice, Typst's warnings and the PDF's embedded fonts: if Typst
/// could not find the chosen installed family it fell back to the bundled one.
fn font_report(role: FontRole, chosen: (&'static str, FontSource), warnings: &[Diagnostic], pdf: &[u8]) -> FontReport {
    let (family, source) = chosen;
    let missing = format!("unknown font family: {}", family.to_lowercase());
    let fell_back = source == FontSource::System && warnings.iter().any(|w| w.message.to_lowercase() == missing);
    FontReport {
        requested: role.preferred(),
        family: if fell_back { role.bundled() } else { family },
        source: if fell_back { FontSource::Bundled } else { source },
        embedded: render::pdf_font_names(pdf),
    }
}

/// App state: Save-dialog grants, written exports, and the renders in progress (by job id).
#[derive(Default)]
pub struct ExportState {
    targets: Mutex<files::Targets>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// The sidecar sits next to the app executable (Tauri strips the target triple when bundling, and
/// tauri-build copies it to target/<profile>/ in development).
fn sidecar_path() -> Result<PathBuf> {
    let exe = std::env::current_exe().map_err(ExportError::internal)?;
    let dir = exe.parent().ok_or_else(|| ExportError::internal("The app executable has no folder"))?;
    Ok(dir.join(format!("typst{}", std::env::consts::EXE_SUFFIX)))
}

fn bundled_fonts_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().resource_dir().map_err(ExportError::internal)?.join("fonts"))
}

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
/// data.json cap (a 100k-word manuscript is a few MB of JSON).
const MAX_DATA_BYTES: usize = 64 * 1024 * 1024;

fn timeout(ms: Option<u64>) -> Duration {
    Duration::from_millis(ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS))
}

/// A path the user picked in the Save dialog: `token` is what writes and renders name it by.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedPath {
    pub token: String,
    pub path: String,
}

/// Show the native Save dialog for a PDF or DOCX (Rust side, with that file type's filter). The
/// picked path becomes writable by exports through the returned token. `None` if cancelled.
#[tauri::command]
pub async fn export_pick_save_path<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ExportState>,
    kind: FileKind,
    default_name: String,
    title: Option<String>,
) -> Result<Option<PickedPath>> {
    use tauri_plugin_dialog::DialogExt;
    let dialog_app = app.clone();
    let name = files::safe_file_name(&default_name, kind);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = dialog_app
            .dialog()
            .file()
            .add_filter(kind.filter_name(), &[kind.extension()])
            .set_file_name(name);
        if let Some(title) = title {
            builder = builder.set_title(title);
        }
        if let Some(window) = dialog_app.get_webview_window("main") {
            builder = builder.set_parent(&window);
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(ExportError::internal)?;
    let Some(picked) = picked else { return Ok(None) };
    let path = files::with_extension(picked.into_path().map_err(ExportError::internal)?, kind);
    let token = state.targets.lock().map_err(ExportError::internal)?.grant(path.clone(), kind);
    Ok(Some(PickedPath { token, path: path.to_string_lossy().into_owned() }))
}

/// A file an export wrote.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenFile {
    pub path: String,
    pub bytes: usize,
}

/// Header naming the Save-dialog token on a raw-body `export_write_file` call.
pub const TOKEN_HEADER: &str = "x-export-token";
/// Header naming the file kind ("pdf" | "docx") on a raw-body `export_write_file` call.
pub const KIND_HEADER: &str = "x-export-kind";

/// Atomically write export bytes (the raw request body, e.g. a DOCX from the frontend) to the path
/// behind the `x-export-token` header. The file I/O runs off the main thread.
#[tauri::command]
pub async fn export_write_file(state: State<'_, ExportState>, request: tauri::ipc::Request<'_>) -> Result<WrittenFile> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(ExportError::new("invalid_request", "Expected the file bytes as the raw request body."));
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let token = header(TOKEN_HEADER).ok_or_else(|| ExportError::new("invalid_token", "No save target was given."))?;
    let kind = match header(KIND_HEADER).as_deref() {
        Some("pdf") => FileKind::Pdf,
        Some("docx") => FileKind::Docx,
        _ => return Err(ExportError::new("invalid_request", "Unknown export file type.")),
    };
    let target = state.targets.lock().map_err(ExportError::internal)?.target(&token, kind)?;
    let (bytes, written, len) = (bytes.clone(), target.clone(), bytes.len());
    tauri::async_runtime::spawn_blocking(move || files::write_export(&written, &bytes))
        .await
        .map_err(ExportError::internal)??;
    state.targets.lock().map_err(ExportError::internal)?.mark_exported(&target);
    Ok(WrittenFile { path: target.to_string_lossy().into_owned(), bytes: len })
}

/// Options of a PDF render.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    /// Caller-chosen id, for `export_cancel_render`.
    pub job_id: String,
    /// A bundled template id (templates.rs).
    pub template: String,
    /// The JSON the template reads as data.json.
    pub data: String,
    pub font: FontRole,
    /// Use an installed Times New Roman / Courier New when present (default true).
    pub prefer_installed_font: Option<bool>,
    /// Save-dialog token: write the PDF there. Without one the PDF comes back as base64.
    pub output_token: Option<String>,
    /// Default 120 s, clamped to 1 s .. 10 min.
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub font: FontReport,
    pub warnings: Vec<Diagnostic>,
    /// Set when the PDF was written to the Save-dialog path.
    pub path: Option<String>,
    /// Set when no output token was given.
    pub pdf_base64: Option<String>,
    pub bytes: usize,
}

/// Everything a render needs that does not borrow app state (so it can run on the blocking pool).
struct RenderJob {
    sidecar: PathBuf,
    fonts: PathBuf,
    template: &'static str,
    data: String,
    font: FontRole,
    chosen: (&'static str, FontSource),
    timeout: Duration,
    temp_parent: PathBuf,
}

fn run_job(job: &RenderJob, cancel: &AtomicBool) -> Result<(render::Rendered, FontReport)> {
    let inputs = vec![
        ("font".to_string(), job.chosen.0.to_string()),
        ("font-fallback".to_string(), job.font.bundled().to_string()),
    ];
    let font_dirs = [job.fonts.clone()];
    let spec = render::RenderSpec {
        sidecar: &job.sidecar,
        font_dirs: &font_dirs,
        template: job.template,
        data_json: &job.data,
        inputs: &inputs,
        ignore_system_fonts: job.chosen.1 == FontSource::Bundled,
        timeout: job.timeout,
        temp_parent: &job.temp_parent,
        on_spawn: None,
    };
    let rendered = render::render(&spec, cancel)?;
    let report = font_report(job.font, job.chosen, &rendered.warnings, &rendered.pdf);
    Ok((rendered, report))
}

/// Removes a render's job entry on every exit path (success, error, cancel, panic).
struct JobGuard<'a> {
    jobs: &'a Mutex<HashMap<String, Arc<AtomicBool>>>,
    id: String,
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&self.id);
        }
    }
}

impl ExportState {
    /// Register a render under `id` (refusing a duplicate) and return its cancel flag and guard.
    fn register(&self, id: &str) -> Result<(Arc<AtomicBool>, JobGuard<'_>)> {
        let mut jobs = self.jobs.lock().map_err(ExportError::internal)?;
        if jobs.contains_key(id) {
            return Err(ExportError::new("busy", format!("Export {id} is already running.")));
        }
        let flag = Arc::new(AtomicBool::new(false));
        jobs.insert(id.to_string(), flag.clone());
        Ok((flag, JobGuard { jobs: &self.jobs, id: id.to_string() }))
    }

    /// Set the cancel flag of the render `id`; false when no such render is running.
    pub fn cancel(&self, id: &str) -> bool {
        match self.jobs.lock() {
            Ok(jobs) => match jobs.get(id) {
                Some(flag) => {
                    flag.store(true, Ordering::SeqCst);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    /// App exit: cancel every render and wait (bounded) until their Typst processes are killed and
    /// reaped, so no child outlives the app.
    pub fn shutdown(&self, wait: Duration) {
        if let Ok(jobs) = self.jobs.lock() {
            for flag in jobs.values() {
                flag.store(true, Ordering::SeqCst);
            }
        }
        if !render::wait_for_children(wait) {
            eprintln!("export: a PDF engine process was still running at exit");
        }
    }
}

/// Where the sidecar, the bundled fonts and the temp dirs are (resolved per render).
pub(crate) struct RenderEnv {
    pub sidecar: PathBuf,
    pub fonts: PathBuf,
    pub temp_parent: PathBuf,
}

/// The render command's body, with its environment and the installed-font scan injected (tests).
/// The job is registered FIRST, so a cancel that arrives during the (possibly slow, first-call)
/// font scan or the token lookup is never lost; the flag is checked again before Typst starts.
pub(crate) async fn render_pdf_with<E, S, F>(
    state: &ExportState,
    request: RenderRequest,
    env: E,
    scan_fonts: S,
) -> Result<RenderResult>
where
    E: FnOnce() -> Result<RenderEnv>,
    S: FnOnce() -> F,
    F: std::future::Future<Output = Vec<String>>,
{
    let (cancel, _guard) = state.register(&request.job_id)?;
    let template = templates::get(&request.template)?.source;
    if request.data.len() > MAX_DATA_BYTES {
        return Err(ExportError::new("invalid_request", "The manuscript data is too large to export."));
    }
    let target = match &request.output_token {
        Some(token) => Some(state.targets.lock().map_err(ExportError::internal)?.target(token, FileKind::Pdf)?),
        None => None,
    };
    let prefer = request.prefer_installed_font.unwrap_or(true);
    let installed = if prefer { scan_fonts().await } else { Vec::new() };
    if cancel.load(Ordering::SeqCst) {
        return Err(ExportError::cancelled());
    }
    let env = env()?;
    let job = RenderJob {
        sidecar: env.sidecar,
        fonts: env.fonts,
        template,
        data: request.data,
        font: request.font,
        chosen: choose_font(request.font, prefer, &installed),
        timeout: timeout(request.timeout_ms),
        temp_parent: env.temp_parent,
    };
    let flag = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<RenderResult> {
        // run_job -> render checks the flag again right before spawning Typst.
        let (rendered, font) = run_job(&job, &flag)?;
        let bytes = rendered.pdf.len();
        let (path, pdf_base64) = match &target {
            Some(t) => {
                if flag.load(Ordering::SeqCst) {
                    return Err(ExportError::cancelled());
                }
                files::write_export(t, &rendered.pdf)?;
                (Some(t.to_string_lossy().into_owned()), None)
            }
            None => (None, Some(base64::engine::general_purpose::STANDARD.encode(&rendered.pdf))),
        };
        Ok(RenderResult { font, warnings: rendered.warnings, path, pdf_base64, bytes })
    })
    .await
    .map_err(ExportError::internal)??;
    if let Some(path) = &result.path {
        state.targets.lock().map_err(ExportError::internal)?.mark_exported(Path::new(path));
    }
    Ok(result)
}

/// Render a bundled template to PDF with the Typst sidecar, offline, in a private temp dir. Writes
/// the PDF atomically to the Save-dialog path when `outputToken` is given. Cancel with
/// `export_cancel_render(jobId)`, which works from the moment this command is invoked.
#[tauri::command]
pub async fn export_render_pdf<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ExportState>,
    request: RenderRequest,
) -> Result<RenderResult> {
    render_pdf_with(
        state.inner(),
        request,
        || {
            Ok(RenderEnv {
                sidecar: sidecar_path()?,
                fonts: bundled_fonts_dir(&app)?,
                temp_parent: std::env::temp_dir(),
            })
        },
        || async {
            tauri::async_runtime::spawn_blocking(crate::fonts::cached_system_families)
                .await
                .unwrap_or_default()
        },
    )
    .await
}

/// Cancel a running render (its Typst process is killed and its temp dir removed). Returns false
/// when no render with that id is running.
#[tauri::command]
pub fn export_cancel_render(state: State<'_, ExportState>, job_id: String) -> Result<bool> {
    Ok(state.cancel(&job_id))
}

/// Show an exported file in Explorer / Finder. Refused for any path this app did not just export.
#[tauri::command]
pub fn export_reveal_in_folder(state: State<'_, ExportState>, path: String) -> Result<()> {
    let file = state.targets.lock().map_err(ExportError::internal)?.exported_file(&path)?;
    files::reveal(&file)
}

#[cfg(test)]
mod tests;
