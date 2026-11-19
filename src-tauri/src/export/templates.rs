//! Bundled Typst templates (compiled into the app, so the webview can only pick one by id, never
//! send Typst source) and the offline guard every template passes before Typst runs.

use super::ExportError;

/// A bundled template. Its source is `main.typ` in the render's temp dir; it reads `data.json`.
pub struct Template {
    pub id: &'static str,
    pub source: &'static str,
}

/// Every template the export command can render: the sidecar smoke test and the PDF manuscript
/// (data.json from src/features/export/pdf/data.ts, `buildPdfData`).
pub const TEMPLATES: &[Template] = &[
    Template { id: "hello", source: include_str!("../../templates/hello.typ") },
    Template { id: "manuscript", source: include_str!("../../templates/manuscript.typ") },
];

pub fn get(id: &str) -> Result<&'static Template, ExportError> {
    TEMPLATES
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| ExportError::new("unknown_template", format!("No export template named {id:?}")))
}

/// Fail closed on anything that could make Typst fetch a package: a string starting with `@`
/// (`#import "@preview/..."`, `#include "@..."`, or a package spec built from pieces), the package
/// namespaces themselves, and `eval` (which could run an import hidden in manuscript text).
/// The render also runs with empty package folders and an unreachable proxy, so this is the first
/// of three layers, not the only one.
pub fn check_offline(source: &str) -> Result<(), ExportError> {
    const FORBIDDEN: [(&str, &str); 4] = [
        ("\"@", "a package import (a string starting with @)"),
        ("@preview/", "the @preview package namespace"),
        ("@local/", "the @local package namespace"),
        ("eval(", "eval, which could run a package import"),
    ];
    for (needle, what) in FORBIDDEN {
        if let Some(at) = source.find(needle) {
            let line = source[..at].matches('\n').count() + 1;
            return Err(ExportError::new(
                "package_import",
                format!("Export templates must work offline, but line {line} uses {what}."),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_template_passes_the_offline_guard() {
        for t in TEMPLATES {
            check_offline(t.source).unwrap_or_else(|e| panic!("template {}: {}", t.id, e.message));
        }
        assert!(get("hello").is_ok());
        assert!(get("manuscript").is_ok());
        assert_eq!(get("nope").err().unwrap().kind, "unknown_template");
    }

    #[test]
    fn package_imports_and_eval_are_rejected() {
        for src in [
            "#import \"@preview/example:0.1.0\": add",
            "#import   \"@local/mine:1.0.0\"",
            "#include \"@preview/x:0.1.0/lib.typ\"",
            "#{ import \"@preview/x:1.0.0\" }",
            "#let spec = \"@\" + \"preview/x:1.0.0\"",
            "#let p = \"preview\"\n#import (\"@\" + p + \"/x:1.0.0\")",
            "#eval(data.text)",
        ] {
            let err = check_offline(src).unwrap_err();
            assert_eq!(err.kind, "package_import", "{src}");
        }
        assert!(check_offline("#let d = json(\"data.json\")\nmail: a@b.com, see @fig").is_ok());
        let err = check_offline("ok\nok\n#import \"@preview/x:1.0.0\"").unwrap_err();
        assert!(err.message.contains("line 3"), "{}", err.message);
    }
}
