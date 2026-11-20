//! Offline spell and grammar checking (Phase 5, T4): Harper's curated dictionary and linters, behind
//! one command. The engine (dictionary plus linter set) is built once per dialect, lazily, and shared;
//! checking runs on the blocking pool so the dictionary load and the linters never stall the UI.
//!
//! Harper reports spans as indices of Unicode scalar values (`char`s). The editor (ProseMirror, JS)
//! counts UTF-16 code units, which differ after any character outside the BMP (an emoji is one `char`
//! but two code units). `Utf16Map` converts, so the offsets a finding carries slice the JS string.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use harper_core::linting::{LintGroup, LintKind, Suggestion};
use harper_core::parsers::PlainEnglish;
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use serde::{Deserialize, Serialize};

/// Most suggestions a finding carries.
pub const MAX_SUGGESTIONS: usize = 5;

#[derive(Debug, Clone, Deserialize)]
pub struct Block {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FindingKind {
    Spelling,
    Grammar,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    /// UTF-16 code units, end exclusive.
    pub start: u32,
    pub end: u32,
    pub kind: FindingKind,
    pub rule: String,
    pub message: String,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockFindings {
    pub id: String,
    pub findings: Vec<Finding>,
}

/// US English unless the OS locale is British (`en-GB`, `en_GB.UTF-8`, `en-gb`).
pub fn dialect_for_locale(locale: Option<&str>) -> Dialect {
    let Some(locale) = locale else { return Dialect::American };
    let norm = locale.split('.').next().unwrap_or("").replace('_', "-").to_ascii_lowercase();
    if norm == "en-gb" || norm.starts_with("en-gb-") {
        Dialect::British
    } else {
        Dialect::American
    }
}

struct Engine {
    dict: Arc<FstDictionary>,
    lints: Mutex<LintGroup>,
}

impl Engine {
    fn new(dialect: Dialect) -> Self {
        let dict = FstDictionary::curated();
        let lints = LintGroup::new_curated(dict.clone(), dialect);
        Engine { dict, lints: Mutex::new(lints) }
    }
}

fn engine(dialect: Dialect) -> &'static Engine {
    static US: OnceLock<Engine> = OnceLock::new();
    static UK: OnceLock<Engine> = OnceLock::new();
    match dialect {
        Dialect::British => UK.get_or_init(|| Engine::new(Dialect::British)),
        _ => US.get_or_init(|| Engine::new(Dialect::American)),
    }
}

/// Char index -> UTF-16 code-unit offset, for one text.
struct Utf16Map(Vec<u32>);

impl Utf16Map {
    fn new(chars: &[char]) -> Self {
        let mut at = Vec::with_capacity(chars.len() + 1);
        let mut n = 0u32;
        for c in chars {
            at.push(n);
            n += c.len_utf16() as u32;
        }
        at.push(n);
        Utf16Map(at)
    }
    fn at(&self, char_index: usize) -> u32 {
        self.0[char_index.min(self.0.len() - 1)]
    }
}

/// `word` without a trailing possessive ('s or a curly one), lowercased: how a custom word is compared.
fn word_key(word: &str) -> String {
    let lower = word.trim().to_lowercase();
    for suffix in ["'s", "\u{2019}s"] {
        if let Some(stem) = lower.strip_suffix(suffix) {
            if !stem.is_empty() {
                return stem.to_string();
            }
        }
    }
    lower
}

/// Findings that are style advice, not mistakes: left out (a novelist's voice is not an error).
fn is_advice(kind: LintKind) -> bool {
    matches!(kind, LintKind::Enhancement | LintKind::Readability | LintKind::Style)
}

fn suggestion_text(s: &Suggestion, original: &str) -> String {
    match s {
        Suggestion::ReplaceWith(chars) => chars.iter().collect(),
        Suggestion::Remove => String::new(),
        Suggestion::InsertAfter(chars) => format!("{original}{}", chars.iter().collect::<String>()),
    }
}

fn check_text(engine: &Engine, text: &str, custom: &HashSet<String>) -> Vec<Finding> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let doc = Document::new(text, &PlainEnglish, engine.dict.as_ref());
    let by_rule = {
        let mut group = engine.lints.lock().unwrap_or_else(|e| e.into_inner());
        group.organized_lints(&doc)
    };
    let map = Utf16Map::new(&chars);
    let mut out = Vec::new();
    for (rule, lints) in by_rule {
        for lint in lints {
            if is_advice(lint.lint_kind) || lint.span.end > chars.len() || lint.span.start >= lint.span.end {
                continue;
            }
            let original: String = chars[lint.span.start..lint.span.end].iter().collect();
            let spelling = matches!(lint.lint_kind, LintKind::Spelling);
            if spelling && custom.contains(&word_key(&original)) {
                continue;
            }
            let mut suggestions: Vec<String> = Vec::new();
            for s in &lint.suggestions {
                let t = suggestion_text(s, &original);
                if !suggestions.contains(&t) {
                    suggestions.push(t);
                }
                if suggestions.len() == MAX_SUGGESTIONS {
                    break;
                }
            }
            out.push(Finding {
                start: map.at(lint.span.start),
                end: map.at(lint.span.end),
                kind: if spelling { FindingKind::Spelling } else { FindingKind::Grammar },
                rule: rule.clone(),
                message: lint.message,
                suggestions,
            });
        }
    }
    out.sort_by_key(|f| (f.start, f.end));
    out
}

/// Check each block. `words` are the writer's dictionary (user plus project): a spelling finding on
/// one of them (case-insensitive, possessive ignored) is dropped.
pub fn check_blocks(blocks: &[Block], words: &[String], locale: Option<&str>) -> Vec<BlockFindings> {
    let engine = engine(dialect_for_locale(locale));
    let custom: HashSet<String> = words.iter().map(|w| word_key(w)).filter(|w| !w.is_empty()).collect();
    // Identical text is checked once per call (a repeated line of dialogue).
    let mut seen: HashMap<&str, Vec<Finding>> = HashMap::new();
    blocks
        .iter()
        .map(|b| {
            let findings = seen.entry(b.text.as_str()).or_insert_with(|| check_text(engine, &b.text, &custom)).clone();
            BlockFindings { id: b.id.clone(), findings }
        })
        .collect()
}

#[tauri::command]
pub async fn spell_check(blocks: Vec<Block>, words: Vec<String>, locale: Option<String>) -> Result<Vec<BlockFindings>, String> {
    tauri::async_runtime::spawn_blocking(move || check_blocks(&blocks, &words, locale.as_deref()))
        .await
        .map_err(|_| "The spell check stopped unexpectedly.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(text: &str, words: &[&str], locale: Option<&str>) -> Vec<Finding> {
        let words: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        check_blocks(&[Block { id: "b".into(), text: text.into() }], &words, locale).remove(0).findings
    }

    /// The text a finding covers, in JS terms: UTF-16 code units.
    fn js_slice(text: &str, f: &Finding) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16(&units[f.start as usize..f.end as usize]).unwrap()
    }

    #[test]
    fn finds_misspelling_with_suggestion() {
        let found = one("I saw teh dog.", &[], None);
        let f = found.iter().find(|f| f.kind == FindingKind::Spelling).expect("a spelling finding");
        assert_eq!(js_slice("I saw teh dog.", f), "teh");
        assert!(f.suggestions.iter().any(|s| s == "the"), "{:?}", f.suggestions);
        assert!(f.suggestions.len() <= MAX_SUGGESTIONS);
    }

    #[test]
    fn grammar_finding_kind() {
        let found = one("She ate a apple.", &[], None);
        let f = found.iter().find(|f| f.kind == FindingKind::Grammar).expect("a grammar finding");
        assert_eq!(js_slice("She ate a apple.", f), "a");
        assert!(f.suggestions.iter().any(|s| s == "an"), "{:?}", f.suggestions);
        assert!(!f.rule.is_empty() && !f.message.is_empty());
    }

    #[test]
    fn utf16_offsets_after_emoji_and_em_dash() {
        let text = "Zoë—said 😀 teh";
        let found = one(text, &[], None);
        let f = found.iter().find(|f| f.kind == FindingKind::Spelling).expect("a spelling finding");
        assert_eq!(js_slice(text, f), "teh");
        // The emoji is one char but two UTF-16 units, so a char index would be off by one.
        assert_eq!(f.start, 12);
        assert_eq!(f.end, 15);
    }

    #[test]
    fn utf16_map_counts_astral_chars_as_two() {
        let chars: Vec<char> = "a😀b".chars().collect();
        let m = Utf16Map::new(&chars);
        assert_eq!((m.at(0), m.at(1), m.at(2), m.at(3)), (0, 1, 3, 4));
    }

    #[test]
    fn custom_word_suppresses() {
        let text = "Aelinor rode north. Aelinor's horse was tired.";
        assert!(one(text, &[], None).iter().any(|f| js_slice(text, f).starts_with("Aelinor")));
        assert!(one(text, &["Aelinor"], None).iter().all(|f| !js_slice(text, f).starts_with("Aelinor")));
        assert!(one(text, &["aelinor"], None).is_empty());
    }

    #[test]
    fn british_dialect_accepts_colour() {
        let text = "The colour of the sea.";
        assert!(one(text, &[], Some("en-GB")).is_empty(), "{:?}", one(text, &[], Some("en-GB")));
        assert!(one(text, &[], Some("en-US")).iter().any(|f| f.kind == FindingKind::Spelling));
    }

    #[test]
    fn dialect_from_locale() {
        assert_eq!(dialect_for_locale(Some("en-GB")), Dialect::British);
        assert_eq!(dialect_for_locale(Some("en_GB.UTF-8")), Dialect::British);
        assert_eq!(dialect_for_locale(Some("en-AU")), Dialect::American);
        assert_eq!(dialect_for_locale(Some("fr-FR")), Dialect::American);
        assert_eq!(dialect_for_locale(None), Dialect::American);
    }

    #[test]
    fn empty_and_blank_blocks_have_no_findings() {
        assert!(one("", &[], None).is_empty());
        assert!(one("   ", &[], None).is_empty());
    }

    /// Run by hand: `cargo test --release timing_200_paragraphs -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn timing_200_paragraphs() {
        let para = "The old keeper walked slowly up the hill, wondering whether the storm would reach the harbour before dusk. She had seen teh signs before, and a apple sky never lied. \"Come inside,\" he said, but Zoe did not move.";
        let blocks: Vec<Block> = (0..200).map(|i| Block { id: i.to_string(), text: format!("{para} ({i})") }).collect();
        let t = std::time::Instant::now();
        let first = check_blocks(&blocks[..1], &[], None);
        println!("cold (engine build + 1 paragraph): {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let all = check_blocks(&blocks, &[], None);
        println!("warm (200 paragraphs): {:?}", t.elapsed());
        assert!(!first[0].findings.is_empty() && all.len() == 200);
    }
}
