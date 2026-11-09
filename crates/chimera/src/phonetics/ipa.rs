//! IPA string → segments (stress ˈ ˌ, length ː, tie bars, affricates, diphthongs, word gaps).

use super::Segment;
use super::inventory::{ASPIRATED, BREATHY, UNRELEASED, Voicing, released_voicing, split_release};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::OnceLock;
use unicode_normalization::{UnicodeNormalization, char::decompose_canonical};

/// combining bridge below: t̪ d̪ n̪
const DENTAL: char = '\u{32A}';

fn is_combining(c: char) -> bool {
    ('\u{300}'..='\u{36F}').contains(&c)
}

const VOWEL_CHARS: &str = "iyɨʉɯuɪʏʊeøɘɵɤoəɛœɜɞʌɔæɐaɶɑɒɝɚ";
const MULTI: [&str; 14] = ["tʃ", "dʒ", "ts", "dz", "pf", "tɕ", "dʑ", "aɪ", "aʊ", "ɔɪ", "eɪ", "oʊ", "ai̯", "au̯"];
const ALIASES: [(&str, &str); 10] = [("t͡ɕ", "tɕ"), ("t͡ʃ", "tʃ"), ("d͡ʒ", "dʒ"), ("t͡s", "ts"), ("d͡z", "dz"), ("ɡ", "g"), ("ʧ", "tʃ"), ("ʤ", "dʒ"), ("r̥", "r"), ("ɐ̯", "ɐ")];


fn known() -> &'static HashSet<&'static str> {
    static K: OnceLock<HashSet<&'static str>> = OnceLock::new();
    K.get_or_init(|| {
        let mut k: HashSet<&'static str> = super::inventory::consonant_symbols().iter().copied().collect();
        for (i, c) in VOWEL_CHARS.char_indices() {
            k.insert(&VOWEL_CHARS[i..i + c.len_utf8()]);
        }
        k.extend(MULTI);
        k
    })
}

/// Force the known-symbol set so nothing initialises lazily later.
pub fn init() {
    known();
}

#[derive(Clone, Debug, Serialize)]
pub struct IpaAnalysis {
    pub segments: Vec<Segment>,
    pub unsupported: Vec<String>,
    #[serde(skip)]
    pub chunks: Vec<String>,
}

pub fn tokenize_ipa(input: &str) -> Vec<Segment> {
    analyze_ipa(input).segments
}

/// Keep phonetic features and report unsupported symbols for editors and language frontends.
pub fn analyze_ipa(input: &str) -> IpaAnalysis {
    let mut s = nfc(input);
    for (a, b) in ALIASES {
        s = s.replace(a, b);
    }
    s = s.replace(['\u{35C}', '\u{361}'], ""); // tie bars
    // Recover nasal vowels after NFC. Other composed IPA symbols, notably ç, stay intact.
    let mut chars = Vec::with_capacity(s.len());
    for c in s.chars() {
        let mut decomposed = Vec::new();
        decompose_canonical(c, |part| decomposed.push(part));
        if decomposed.len() == 2 && VOWEL_CHARS.contains(decomposed[0]) && decomposed[1] == '\u{303}' {
            chars.extend(decomposed);
        } else {
            chars.push(c);
        }
    }
    // NFC may leave the tilde on a precomposed ĩ/ũ before the non-syllabic
    // mark. Match the whole glide first so nasalization spans one nucleus.
    for i in 1..chars.len().saturating_sub(1) {
        if chars[i] == '\u{303}' && chars[i + 1] == '\u{32f}' && matches!(chars[i - 1], 'i' | 'u') {
            chars.swap(i, i + 1);
        }
    }
    let s = chars;
    let mut out: Vec<Segment> = Vec::new();
    let mut chunks: Vec<String> = Vec::new();
    let mut unsupported = Vec::new();
    let mut stress = 0u8;
    let mut i = 0;
    let known = known();
    while i < s.len() {
        let ch = s[i];
        if ch == 'ˈ' || ch == '\'' {
            stress = 1;
            i += 1;
            continue;
        }
        if ch == 'ˌ' {
            stress = 2;
            i += 1;
            continue;
        }
        if ch == ' ' || ch == '.' || ch == '|' || ch == ',' {
            if let Some(last) = out.last_mut() {
                last.word_end = Some(true);
            }
            if ch == ',' || ch == '|' {
                out.push(Segment { ipa: "_".into(), dur: Some(0.16), ..Default::default() });
                chunks.push(ch.to_string());
            }
            i += 1;
            continue;
        }
        if ch == 'ː' || ch == ':' {
            if let Some(last) = out.last_mut() {
                let first = last.ipa.chars().next();
                last.dur = Some(last.dur.unwrap_or(if first.is_some_and(|c| VOWEL_CHARS.contains(c)) { 0.15 } else { 0.09 }) * 1.7);
            }
            if let Some(last) = chunks.last_mut() { last.push(ch); }
            i += 1;
            continue;
        }
        if matches!(ch, '\u{2e5}'..='\u{2e9}' | 'ˑ' | '\u{306}') {
            if let Some(last) = chunks.last_mut() { last.push(ch); }
            i += 1;
            continue;
        }
        if ch.is_whitespace() || matches!(ch, '/' | '[' | ']' | '‖' | ';' | '-' | '~') {
            i += 1;
            continue;
        }
        let token_start = i;
        let mut tok = String::new();
        for m in MULTI {
            if starts_with_at(&s, i, m) {
                tok = m.to_string();
            }
        }
        if tok.is_empty() {
            tok = ch.to_string();
        }
        i += tok.chars().count();
        let mut nasalized = None;
        let mut syllabic = None;
        // Features belong to the segment even when Unicode supplies a precomposed vowel.
        while i < s.len() && is_combining(s[i]) {
            if s[i] == DENTAL {
                let dental = format!("{tok}{DENTAL}");
                if known.contains(dental.as_str()) {
                    tok = dental;
                } else {
                    unsupported.push(dental);
                }
            } else if s[i] == UNRELEASED && released_voicing(&tok).is_some() {
                tok.push(UNRELEASED);
            } else if s[i] == '\u{303}' {
                nasalized = Some(true);
            } else if s[i] == '\u{329}' {
                syllabic = Some(true);
            } else if !matches!(s[i], '\u{306}' | '\u{32f}') {
                unsupported.push(format!("{tok}{}", s[i]));
            }
            i += 1;
        }
        // a release mark on a stop or affricate: ʰ aspirates a voiceless one; on a voiced one either
        // mark is a breathy release (bʰ is a common spelling of bʱ). Anywhere else it is skipped.
        if i < s.len() && (s[i] == ASPIRATED || s[i] == BREATHY) && split_release(&tok).1 == super::inventory::Release::Plain {
            if let Some(v) = released_voicing(&tok) {
                tok.push(if v == Voicing::Voiceless { ASPIRATED } else { BREATHY });
                i += 1;
                while i < s.len() && is_combining(s[i]) {
                    i += 1;
                }
            }
        }
        if !known.contains(split_release(&tok).0) {
            unsupported.push(tok);
            continue;
        }
        let is_v = tok.chars().next().is_some_and(|c| VOWEL_CHARS.contains(c)) && !super::inventory::consonant_symbols().contains(&tok.as_str());
        out.push(Segment { ipa: tok, stress: Some(if is_v { stress } else { 0 }), nasalized, syllabic, ..Default::default() });
        chunks.push(s[token_start..i].iter().collect());
        if is_v {
            stress = 0;
        }
    }
    IpaAnalysis { segments: out, unsupported, chunks }
}

fn starts_with_at(s: &[char], i: usize, m: &str) -> bool {
    m.chars().enumerate().all(|(k, c)| s.get(i + k) == Some(&c))
}

/// Canonical normalization shared by IPA and Sanskrit, including stacked IAST diacritics.
pub(crate) fn nfc(input: &str) -> String {
    input.nfc().collect()
}
