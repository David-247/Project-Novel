//! Export tests that run the real Typst sidecar (fetched by `node scripts/fetch-typst.mjs`, which
//! the build needs anyway): hello world with a bundled font, offline guarantees, timeout, cancel
//! and temp-dir cleanup on every path.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::render::{render, render_unchecked, RenderSpec};
use super::*;

fn sidecar() -> PathBuf {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("typst-{}{}", env!("NOVEL_TARGET_TRIPLE"), std::env::consts::EXE_SUFFIX));
    assert!(p.is_file(), "{} is missing: run `node scripts/fetch-typst.mjs`", p.display());
    p
}

fn fonts_dir() -> PathBuf {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("fonts");
    assert!(p.join("LiberationSerif-Regular.ttf").is_file(), "bundled fonts missing: run `node scripts/fetch-typst.mjs`");
    p
}

/// A fresh, empty folder to create the render's temp dir in, so a test can see it was removed.
fn temp_parent(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("novel-export-test-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn assert_empty(dir: &Path) {
    let left: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert!(left.is_empty(), "temp dir not cleaned up: {left:?}");
    fs::remove_dir_all(dir).unwrap();
}

const DATA: &str = r#"{"title":"Hello","body":"Hello, world."}"#;

/// About a minute of work for Typst (400 million loop iterations): only ever stopped early.
const SLOW: &str = "#let s = 0\n#for i in range(20000) { for j in range(20000) { s += 1 } }\n#s\n";

fn inputs(family: &str, fallback: &str) -> Vec<(String, String)> {
    vec![("font".into(), family.into()), ("font-fallback".into(), fallback.into())]
}

fn spec<'a>(
    sidecar: &'a Path,
    fonts: &'a [PathBuf],
    template: &'a str,
    inputs: &'a [(String, String)],
    parent: &'a Path,
) -> RenderSpec<'a> {
    RenderSpec {
        sidecar,
        font_dirs: fonts,
        template,
        data_json: DATA,
        inputs,
        ignore_system_fonts: true,
        timeout: Duration::from_secs(60),
        temp_parent: parent,
        on_spawn: None,
    }
}

fn job(font: FontRole, parent: &Path) -> RenderJob {
    RenderJob {
        sidecar: sidecar(),
        fonts: fonts_dir(),
        template: templates::get("hello").unwrap().source,
        data: DATA.into(),
        font,
        chosen: choose_font(font, false, &[]),
        timeout: Duration::from_secs(60),
        temp_parent: parent.to_path_buf(),
    }
}

/// CI smoke (macOS and Windows): hello world to PDF with the bundled fallback font, offline.
#[test]
fn renders_hello_world_with_the_bundled_serif_font() {
    let parent = temp_parent("hello");
    let (rendered, font) = run_job(&job(FontRole::Serif, &parent), &AtomicBool::new(false)).unwrap();
    assert!(rendered.pdf.starts_with(b"%PDF-"), "not a PDF");
    assert_eq!(font.requested, "Times New Roman");
    assert_eq!(font.family, "Liberation Serif");
    assert_eq!(font.source, FontSource::Bundled);
    assert!(font.embedded.iter().any(|f| f == "LiberationSerif"), "{:?}", font.embedded);
    assert!(font.embedded.iter().any(|f| f == "LiberationSerif-Italic"), "{:?}", font.embedded);
    assert!(font.embedded.iter().all(|f| f.starts_with("LiberationSerif")), "{:?}", font.embedded);
    assert!(rendered.warnings.is_empty(), "{:?}", rendered.warnings);
    assert_empty(&parent);
}

#[test]
fn renders_with_the_bundled_mono_font() {
    let parent = temp_parent("mono");
    let (_, font) = run_job(&job(FontRole::Mono, &parent), &AtomicBool::new(false)).unwrap();
    assert_eq!((font.requested, font.family), ("Courier New", "Liberation Mono"));
    assert!(font.embedded.iter().all(|f| f.starts_with("LiberationMono")), "{:?}", font.embedded);
    assert_empty(&parent);
}

#[test]
fn prefers_an_installed_times_new_roman_when_allowed() {
    let installed = vec!["Arial".to_string(), "times new roman".to_string()];
    assert_eq!(choose_font(FontRole::Serif, true, &installed), ("Times New Roman", FontSource::System));
    assert_eq!(choose_font(FontRole::Serif, false, &installed), ("Liberation Serif", FontSource::Bundled));
    assert_eq!(choose_font(FontRole::Mono, true, &installed), ("Liberation Mono", FontSource::Bundled));
}

#[test]
fn reports_the_bundled_font_when_typst_could_not_find_the_installed_one() {
    let warn = |m: &str| Diagnostic {
        severity: "warning",
        file: Some("template".into()),
        line: Some(1),
        column: Some(1),
        message: m.into(),
        hints: vec![],
    };
    let pdf = b"/BaseFont/AAAAAA+LiberationSerif";
    let chosen = ("Times New Roman", FontSource::System);
    let r = font_report(FontRole::Serif, chosen, &[warn("unknown font family: times new roman")], pdf);
    assert_eq!((r.family, r.source), ("Liberation Serif", FontSource::Bundled));
    assert_eq!(r.embedded, vec!["LiberationSerif"]);
    let r = font_report(FontRole::Serif, chosen, &[warn("something else")], pdf);
    assert_eq!((r.family, r.source), ("Times New Roman", FontSource::System));
}

#[test]
fn the_real_system_font_path_renders_too() {
    // With system fonts allowed: Times New Roman where installed (macOS, Windows), else the fallback.
    let parent = temp_parent("system");
    let installed = crate::fonts::cached_system_families();
    let mut j = job(FontRole::Serif, &parent);
    j.chosen = choose_font(FontRole::Serif, true, &installed);
    let (rendered, font) = run_job(&j, &AtomicBool::new(false)).unwrap();
    assert!(rendered.pdf.starts_with(b"%PDF-"));
    assert!(!font.embedded.is_empty());
    if font.source == FontSource::System {
        assert!(font.embedded.iter().any(|f| f.to_lowercase().contains("times")), "{:?}", font.embedded);
    }
    assert_empty(&parent);
}

#[test]
fn a_template_with_a_package_import_is_rejected_before_typst_runs() {
    let parent = temp_parent("import");
    let (side, fonts) = (sidecar(), [fonts_dir()]);
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let src = "#import \"@preview/example:0.1.0\": add\n#add(1, 2)\n";
    let err = render(&spec(&side, &fonts, src, &ins, &parent), &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.kind, "package_import");
    assert_empty(&parent);
}

/// The second and third layers: even a template that slipped past the guard cannot fetch a package.
/// The package folders are empty and every proxy points at a dead port, so the download fails at
/// once (the network is unreachable for the child) and nothing lands in the package cache.
#[test]
fn typst_itself_cannot_fetch_a_package_with_the_network_blocked() {
    let parent = temp_parent("offline");
    let (side, fonts) = (sidecar(), [fonts_dir()]);
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let src = "#import \"@preview/example:0.1.0\": add\n#add(1, 2)\n";
    let started = Instant::now();
    let err = render_unchecked(&spec(&side, &fonts, src, &ins, &parent), &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.kind, "package_import", "{err:?}");
    assert!(err.diagnostics.iter().any(|d| d.message.contains("download package")), "{:?}", err.diagnostics);
    assert!(started.elapsed() < Duration::from_secs(30));
    assert_empty(&parent);
}

#[test]
fn a_compile_error_returns_structured_diagnostics_and_cleans_up() {
    let parent = temp_parent("compile");
    let (side, fonts) = (sidecar(), [fonts_dir()]);
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let err = render(&spec(&side, &fonts, "#let x = 1\n#foo\n", &ins, &parent), &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.kind, "compile");
    assert_eq!(err.message, "unknown variable: foo");
    let d = &err.diagnostics[0];
    assert_eq!((d.severity, d.file.as_deref(), d.line, d.column), ("error", Some("template"), Some(2), Some(1)));
    assert_empty(&parent);
}

#[test]
fn bad_data_is_reported_against_the_data_file() {
    let parent = temp_parent("data");
    let (side, fonts) = (sidecar(), [fonts_dir()]);
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let mut s = spec(&side, &fonts, "#let d = json(\"data.json\")\n#d.title\n", &ins, &parent);
    s.data_json = "{not json";
    let err = render(&s, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.kind, "compile");
    assert!(err.diagnostics.iter().any(|d| d.file.as_deref() == Some("data") || d.message.contains("JSON")), "{err:?}");
    assert_empty(&parent);
}

/// True while a process with this id is running.
fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
    }
}

#[test]
fn a_timeout_kills_typst_returns_an_error_and_cleans_up() {
    let parent = temp_parent("timeout");
    let (side, fonts) = (sidecar(), [fonts_dir()]);
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let pid = AtomicU32::new(0);
    let record = |p: u32| pid.store(p, Ordering::SeqCst);
    let mut s = spec(&side, &fonts, SLOW, &ins, &parent);
    s.timeout = Duration::from_millis(500);
    s.on_spawn = Some(&record);
    let started = Instant::now();
    let err = render(&s, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.kind, "timeout");
    assert!(started.elapsed() < Duration::from_secs(15), "took {:?}", started.elapsed());
    let pid = pid.load(Ordering::SeqCst);
    assert!(pid != 0 && !alive(pid), "typst ({pid}) still running");
    assert_empty(&parent);
}

#[test]
fn cancel_kills_typst_and_cleans_up() {
    let parent = temp_parent("cancel");
    let (side, fonts) = (sidecar(), [fonts_dir()]);
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let pid = AtomicU32::new(0);
    let record = |p: u32| pid.store(p, Ordering::SeqCst);
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        flag.store(true, Ordering::SeqCst);
    });
    let mut s = spec(&side, &fonts, SLOW, &ins, &parent);
    s.on_spawn = Some(&record);
    let started = Instant::now();
    let err = render(&s, &cancel).unwrap_err();
    canceller.join().unwrap();
    assert_eq!(err.kind, "cancelled");
    assert!(started.elapsed() < Duration::from_secs(15), "took {:?}", started.elapsed());
    let pid = pid.load(Ordering::SeqCst);
    assert!(pid != 0 && !alive(pid), "typst ({pid}) still running");
    assert_empty(&parent);
}

#[test]
fn a_render_cancelled_before_it_starts_never_spawns() {
    let parent = temp_parent("precancel");
    let (side, fonts) = (sidecar(), [fonts_dir()]);
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let spawned = AtomicBool::new(false);
    let record = |_: u32| spawned.store(true, Ordering::SeqCst);
    let mut s = spec(&side, &fonts, SLOW, &ins, &parent);
    s.on_spawn = Some(&record);
    assert_eq!(render(&s, &AtomicBool::new(true)).unwrap_err().kind, "cancelled");
    assert!(!spawned.load(Ordering::SeqCst));
    assert_empty(&parent);
}

#[test]
fn a_missing_sidecar_is_a_clear_error() {
    let parent = temp_parent("missing");
    let fonts = [fonts_dir()];
    let ins = inputs("Liberation Serif", "Liberation Serif");
    let gone = parent.join("no-typst.exe");
    let err = render(&spec(&gone, &fonts, "Hi", &ins, &parent), &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.kind, "sidecar_missing");
    assert!(err.message.contains("fetch-typst"));
    assert_empty(&parent);
}

#[test]
fn timeouts_are_clamped() {
    assert_eq!(timeout(None), Duration::from_millis(DEFAULT_TIMEOUT_MS));
    assert_eq!(timeout(Some(5)), Duration::from_millis(MIN_TIMEOUT_MS));
    assert_eq!(timeout(Some(u64::MAX)), Duration::from_millis(MAX_TIMEOUT_MS));
}

/// The write path the commands use: only a Save-dialog grant can be written, the write is atomic,
/// and only the written file can then be revealed.
#[test]
fn grant_write_then_reveal_check() {
    let dir = temp_parent("grant");
    let target = dir.join("Book.pdf");
    let mut t = files::Targets::default();
    let token = t.grant(target.clone(), FileKind::Pdf);
    let path = t.target(&token, FileKind::Pdf).unwrap();
    files::write_export(&path, b"%PDF-1.7 test").unwrap();
    assert_eq!(t.exported_file(&target.to_string_lossy()).unwrap_err().kind, "not_exported");
    t.mark_exported(&path);
    assert!(t.exported_file(&target.to_string_lossy()).is_ok());
    fs::remove_dir_all(dir).unwrap();
}
