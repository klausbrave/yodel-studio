//! Segment sequence → gestural score. Timing and phonation are articulatory: aspiration is a
//! glottal opening gesture peaking at the release (VOT emerges), nasality is velum lowering with
//! anticipation, coarticulation comes from overlapping vowel gestures beneath consonant gestures.
//!
//! The planners allocate and run off the audio thread. [`oral_gestures_into`] (used by the beat
//! sequencer) builds into a caller's `Vec` and allocates nothing once it has capacity.

use super::durations::{SegInfo, klatt_durations};
use super::inventory::{Glottal, Manner, PhonemeDef, Release, Voicing, phoneme, split_release};
use super::{Intonation, Plan, PlannedSegment, Segment};
use crate::anatomy::human::{ArticKey, ArticPatch, BodyMix, BodyName};
use crate::control::score::{ControlKey, Gesture, GestureScore, Targets};
use crate::math::{js_max, js_min, js_round};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// label of the end-of-breath-group abduction (a live note can drop it when the next one starts)
pub const EXHALE_LABEL: &str = "exhale";

/// when a sung phrase's breath reaches full drive, after the plan start (its first segment starts at 0.06)
const BREATH_SUNG_AT: f64 = 0.06;

const VOWEL_KEYS: [ArticKey; 9] = [ArticKey::TbX, ArticKey::TbY, ArticKey::Jaw, ArticKey::LipAp, ArticKey::LipProt, ArticKey::LipWidth, ArticKey::Root, ArticKey::Larynx, ArticKey::TtCurl];

/// One calibrated vowel of `vowelTargets.generated.json`.
#[derive(Clone, Debug, Deserialize)]
pub struct VowelTarget {
    pub artic: ArticPatch,
    #[serde(default)]
    pub formants: Vec<f64>,
}

/// body name → IPA → calibrated vowel
pub type VowelTable = BTreeMap<String, BTreeMap<String, VowelTarget>>;

/// The calibrated vowel table (parsed once).
pub fn vowel_table() -> &'static VowelTable {
    static T: OnceLock<VowelTable> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("vowelTargets.generated.json")).expect("vowelTargets.generated.json"))
}

/// Diphthongs and r-coloured vowels expand to vowel sequences. American /eɪ oʊ/ glide toward
/// [i u] (Hillenbrand et al. 1995: /e/ F2 rises ~150 Hz, /o/ F1 falls with F2 steady); with
/// [ɪ ʊ] as targets they barely moved (/e/ and /ɪ/ share F2) and sounded like the steady
/// [eː oː] of Indian English. The other offglides undershoot toward [ɪ ʊ].
pub fn expand(ipa: &str) -> Option<&'static [&'static str]> {
    Some(match ipa {
        "ai̯" => &["a", "i"],
        "au̯" => &["a", "u"],
        "aɪ" => &["a", "ɪ"],
        "aʊ" => &["a", "ʊ"],
        "ɔɪ" => &["ɔ", "ɪ"],
        "eɪ" => &["e", "i"],
        "oʊ" => &["o", "u"],
        "ɚ" => &["ɝ"],
        _ => return None,
    })
}

/// The two vowel targets of a diphthong ("aɪ" → ("a", "ɪ")), or None.
pub fn diphthong_parts(ipa: &str) -> Option<(&'static str, &'static str)> {
    match expand(ipa) {
        Some(p) if p.len() == 2 => Some((p[0], p[1])),
        _ => None,
    }
}

pub fn is_vowel(ipa: &str, body: BodyMix) -> bool {
    let t = vowel_table();
    body.weights().iter().any(|(b, w)| *w > 0.0 && t.get(b.as_str()).is_some_and(|t| t.contains_key(ipa))) || expand(ipa).is_some()
}

/// The calibrated articulation of a vowel for a body: between presets, the presets' calibrated
/// articulations blended by the body's weights.
pub fn vowel_artic(ipa: &str, body: BodyMix) -> Option<ArticPatch> {
    if let Some(b) = body.preset() {
        return preset_vowel_artic(ipa, b);
    }
    let w = body.weights();
    let mut parts = [(0.0, ArticPatch::default()); 3];
    for (i, (b, wi)) in w.iter().enumerate() {
        if *wi > 0.0 {
            parts[i] = (*wi, preset_vowel_artic(ipa, *b)?);
        }
    }
    Some(ArticPatch::blend(&parts))
}

fn preset_vowel_artic(ipa: &str, body: BodyName) -> Option<ArticPatch> {
    let t = vowel_table();
    let v = t.get(body.as_str()).and_then(|b| b.get(ipa)).or_else(|| t.get("male").and_then(|m| m.get(ipa)))?;
    let mut out = ArticPatch::default();
    for k in VOWEL_KEYS {
        if let Some(x) = v.artic.get(k) {
            out.set(k, x);
        }
    }
    // a rhotic's tip is raised and curled back, not resting behind the teeth: without its
    // calibrated position the tip stayed down and /ɝ/'s F3 sat ~15–20 % high (weakly rhotic)
    if v.artic.get(ArticKey::TtCurl).unwrap_or(0.0) > 0.05 {
        if let Some(x) = v.artic.get(ArticKey::TtX) {
            out.set(ArticKey::TtX, x);
        }
        if let Some(x) = v.artic.get(ArticKey::TtY) {
            out.set(ArticKey::TtY, x);
        }
    }
    Some(out)
}

/// Parse the vowel and consonant tables now (so nothing initialises lazily on the audio thread).
pub fn init() {
    vowel_table();
    super::inventory::init();
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOptions {
    pub body: BodyMix,
    /// voice-clock start time (s)
    pub t0: f64,
    /// speaking-rate multiplier (>1 = faster)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    /// baseline pitch (Hz)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f0: Option<f64>,
    /// "statement" (final fall) or "question" (final rise)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intonation: Option<Intonation>,
    /// pitch excursion for stressed syllables (fraction)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<f64>,
    /// the last segment is held open-ended (a sung note): no end-of-breath release
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_end: Option<bool>,
    /// a sung phrase (`plan_song`): consonants given a pitch hold it, and pitch ramps shrink to
    /// fit short notes. Speech and live notes leave it unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sung: Option<bool>,
    /// which voiceless stops are aspirated (unset: English)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspiration: Option<Aspiration>,
}

/// Which voiceless stops are aspirated. A release mark ("tʰ", "bʱ") is always honoured.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Aspiration {
    /// English: syllable-initial before a vowel, not after /s/ ("top" but "stop")
    #[default]
    English,
    /// only where written ("tʰ"); a plain p t k is unaspirated. For languages where aspiration
    /// tells words apart (Hindi, Sanskrit, Mandarin, Thai), and for the many where p t k never
    /// aspirate (French, Spanish, Italian, Russian).
    Marked,
}

/// Voice-onset lag of a written aspirate (s): Hindi voiceless aspirates run ~70–90 ms against
/// English's ~50–60 (Lisker & Abramson 1964; Davis 1994).
const MARKED_VOT: f64 = 0.08;
/// how far apart the folds are held through a breathy release (ɦ holds 0.1), and how long the
/// murmur carries into the vowel (s): Hindi bʱ dʱ run ~50–100 ms (Dutta 2007)
const BREATHY_ABDUCTION: f64 = 0.045;
const BREATHY_POSTERIOR_GAP: f64 = 0.025;
const BREATHY_LAG: f64 = 0.05;
/// when the folds start to part, after the closure segment ends (s): at the release, not before
/// it, or the voice dies in the closure and the release comes out of silence (bʱ heard as pʰ)
const BREATHY_START: f64 = 0.005;
/// a plain voiceless stop where aspiration is marked: how long before the release the folds
/// start to close (s), and how far apart they are held in the closure
const PLAIN_LEAD: f64 = 0.02;
const PLAIN_ABDUCTION: f64 = 0.18;
/// how long an unreleased final stop stays closed after its segment ends (s): past the breath, and
/// past the end of a render, since the release itself still ticks (~−34 dBFS) as the tongue snaps
/// off the teeth even with no pressure behind it
const UNRELEASED_HOLD: f64 = 0.5;
/// how far a prevoiced stop lowers the larynx and advances the tongue root through its closure (cm)
const PREVOICE_LARYNX: f64 = -1.0;
const PREVOICE_ROOT: f64 = 1.2;
/// articulator speed while it does (at its own pace the larynx barely moves in a closure)
const PREVOICE_SPEED: f64 = 1.3;

/// JS truthiness of an optional number (`if (s.f0)`: 0 and NaN are false).
#[inline]
pub(crate) fn truthy(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v != 0.0 && !v.is_nan())
}

/// `Partial<HumanArtic>` as gesture targets
#[inline]
pub(crate) fn artic_targets(p: &ArticPatch) -> Targets {
    let mut t = Targets::default();
    for (k, x) in p.iter() {
        t.set(k, x);
    }
    t
}

#[inline]
fn one(k: impl Into<ControlKey>, x: f64) -> Targets {
    Targets::default().with(k, x)
}

/// A planner segment: the input segment plus what the planner attaches to it.
struct Seg<'a> {
    ipa: &'a str,
    dur: Option<f64>,
    stress: Option<u8>,
    f0: Option<f64>,
    def: Option<PhonemeDef>,
    vowel: Option<ArticPatch>,
    glide_from: bool,
    nasalized: bool,
    syllabic_r: bool,
}

#[derive(Clone, Copy)]
struct Span {
    t0: f64,
    t1: f64,
}

pub fn plan_utterance(input: &[Segment], o: &PlanOptions) -> Plan {
    checked_plan_utterance(input, o).unwrap_or_default()
}

/// Report a sustained trill whose individual contacts cannot fit in one gesture score.
pub fn checked_plan_utterance(input: &[Segment], o: &PlanOptions) -> Result<Plan, &'static str> {
    let rate = o.rate.unwrap_or(1.0);
    let aspiration = o.aspiration.unwrap_or_default();
    let body = o.body;
    // durations by the Klatt rules, on whole segments (diphthongs before they are split)
    let durs = klatt_durations(input, |s| {
        if is_vowel(&s.ipa, body) {
            return SegInfo { vowel: true, ..Default::default() };
        }
        let d = phoneme(&s.ipa, body);
        SegInfo { vowel: false, manner: d.map(|d| d.manner), voiced: Some(d.is_some_and(|d| d.voicing == Voicing::Voiced)), dur: d.map(|d| d.dur) }
    });
    // expand diphthongs into two vowel targets sharing the duration
    let mut segs: Vec<Seg> = Vec::with_capacity(input.len() + 4);
    let mut continuous_glides = Vec::new();
    for (si, s) in input.iter().enumerate() {
        if let Some(parts) = expand(&s.ipa) {
            if let Some((from, to)) = continuous_diphthong(&s.ipa) {
                continuous_glides.push((segs.len(), from, to));
            }
            let base = durs[si];
            for (i, p) in parts.iter().enumerate() {
                let dur = if parts.len() > 1 { base * (if i == 0 { 0.55 } else { 0.45 }) } else { base };
                segs.push(Seg { ipa: p, dur: Some(dur), stress: s.stress, f0: s.f0, def: None, vowel: None, glide_from: i > 0, nasalized: s.nasalized == Some(true), syllabic_r: false });
            }
        } else {
            segs.push(Seg { ipa: &s.ipa, dur: Some(durs[si]), stress: s.stress, f0: s.f0, def: None, vowel: None, glide_from: false, nasalized: s.nasalized == Some(true), syllabic_r: s.syllabic == Some(true) && s.ipa == "ɾ" });
        }
    }
    for s in segs.iter_mut() {
        let v = vowel_artic(s.ipa, body);
        if v.is_some() {
            s.vowel = v;
        } else {
            s.def = phoneme(s.ipa, body);
        }
    }
    let mut gestures: Vec<Gesture> = Vec::new();
    let mut planned: Vec<PlannedSegment> = Vec::with_capacity(segs.len());
    let mut t = o.t0 + 0.06; // breath onset lead
    let mut times: Vec<Span> = Vec::with_capacity(segs.len());
    for s in &segs {
        let mut d = if let Some(d) = s.dur {
            d
        } else if s.vowel.is_some() {
            if s.stress == Some(1) {
                0.17
            } else if s.stress == Some(2) {
                0.13
            } else {
                0.095
            }
        } else {
            s.def.map_or(0.08, |d| d.dur)
        };
        // final lengthening on the last syllable rhyme
        d /= rate;
        times.push(Span { t0: t, t1: t + d });
        t += d;
    }
    let end = t;
    for (index, (segment, span)) in segs.iter().zip(&times).enumerate() {
        if segment.nasalized {
            let follows_oral_stop = index.checked_sub(1).and_then(|previous| segs[previous].def)
                .is_some_and(|definition| matches!(definition.manner, Manner::Stop | Manner::Affricate));
            // t0 is full activation: its ramp begins 45 ms earlier. An oral stop
            // needs the nasal route sealed until release to retain its closure.
            let ramp_in = if follows_oral_stop { (span.t1 - span.t0).min(0.045) } else { 0.045 };
            let full_open = if follows_oral_stop { span.t0 + ramp_in } else { span.t0 - 0.025 };
            gestures.push(Gesture::new(full_open, span.t1, ramp_in, 0.04, 5.0, one(ArticKey::Velum, 0.35)).label("nasalization"));
        }
    }
    // ---- vowel gestures: overlap neighbours so the tongue travels vowel-to-vowel
    let v_idx: Vec<usize> = segs.iter().enumerate().filter(|(_, s)| s.vowel.is_some()).map(|(i, _)| i).collect();
    for (n, &i) in v_idx.iter().enumerate() {
        let prev = if n > 0 { times[v_idx[n - 1]].t1 } else { times[i].t0 - 0.08 };
        let next = if n < v_idx.len() - 1 { times[v_idx[n + 1]].t0 } else { times[i].t1 + 0.08 };
        // vowel-to-vowel through the consonant (Öhman): the previous vowel lets go early in the gap
        // and the next one's target ramps in over most of it, so the tongue body is already near
        // the next vowel at the release and the transitions carry the consonant's place
        let r_in = js_max(0.03, 0.75 * (times[i].t0 - prev)) + 0.01;
        let r_out = js_max(0.03, 0.4 * (next - times[i].t1)) + 0.01;
        gestures.push(Gesture::new(times[i].t0, times[i].t1, r_in, r_out, 1.0, artic_targets(segs[i].vowel.as_ref().unwrap())).label(segs[i].ipa));
    }
    // utterance-initial/final consonants: lend them the nearest vowel's body posture
    // ---- consonant gestures
    for (i, s) in segs.iter().enumerate() {
        let Span { t0, t1 } = times[i];
        let dur = t1 - t0;
        planned.push(PlannedSegment {
            ipa: if s.syllabic_r { "ɾ̩" } else { s.ipa }.to_string(),
            t0,
            t1,
            stress: if s.vowel.is_some() { Some(s.stress.unwrap_or(0)) } else { None },
            kind: if s.vowel.is_some() || s.syllabic_r { "vowel".to_string() } else { s.def.map_or("?", |d| d.manner.as_str()).to_string() },
        });
        let Some(def) = s.def.as_ref() else { continue };
        let next_vowel = i < segs.len() - 1 && segs[i + 1].vowel.is_some();
        let release = split_release(s.ipa).1;
        // a final stop marked unreleased (t̚) stays closed until the breath has gone, so it ends
        // the utterance without a burst
        let held = release == Release::Unreleased && i == segs.len() - 1;
        let prev_seg = if i > 0 { Some(&segs[i - 1]) } else { None };
        let next_def = segs.get(i + 1).and_then(|seg| seg.def);
        let oral_start = gestures.len();
        let mut add_oral = |tg: &ArticPatch, a: f64, b: f64, speed: f64, label: &str| oral_gestures_into(def, tg, a, b, speed, label, &mut gestures);
        match def.manner {
            // a stop that closes behind another stop's closure, its articulator already placed by
            // the segment before that (the tip raised for /ɹ/ in "sharp tree"), reaches contact
            // sooner than from a vowel: with the usual lead it sealed ~20 ms before the front
            // closure opened, and the tongue then pumped the air shut between the two closures
            // The delay leaves the closure 30 ms before its release (its 10 ms minimum hold and
            // its ~20 ms early release), so a short sung stop isn't pushed past its own end.
            Manner::Stop if pre_placed_behind_closure(&segs, i) => add_oral(&def.targets, t0 + js_min(PLACED_CLOSURE_DELAY, js_max(0.0, dur - 0.03)), t1, 1.55, def.ipa),
            Manner::Stop if held => add_oral(&def.targets, t0, t1 + UNRELEASED_HOLD, 0.35, def.ipa),
            Manner::Stop | Manner::Nasal => add_oral(&def.targets, t0, t1, 1.55, def.ipa),
            Manner::Tap if s.syllabic_r => {
                // The course's ṛ stays voiced on a spread, raised tongue posture.
                // A brief apical contact releases into that posture on the same note.
                let mut carrier = vowel_artic("ɪ", body).unwrap();
                carrier.set(ArticKey::LipProt, 0.0);
                carrier.set(ArticKey::LipWidth, 1.0);
                carrier.set(ArticKey::TtX, 6.25);
                carrier.set(ArticKey::TtY, 7.6);
                carrier.set(ArticKey::TtCurl, 0.0);
                gestures.push(Gesture::new(t0, t1, 0.035, 0.035, 3.0, artic_targets(&carrier)).label("ɾ̩"));
                let at = t0 + js_min(0.035, 0.22 * dur);
                let contact = Targets::default().with(ArticKey::TtX, 6.25).with(ArticKey::TtY, 10.05);
                gestures.push(Gesture::new(at, at + js_min(0.014, 0.18 * dur), 0.013, 0.008, 60.0, contact)
                    .speed(3.4).label("apical contact"));
            }
            Manner::Tap => add_oral(&def.targets, t0, t1, 2.8, def.ipa),
            Manner::Trill => {
                // driven trill: rapid alternation of near-closure and release at ~26 Hz
                let n = js_max(2.0, js_round(dur * 26.0));
                // Every contact requires at least one gesture. Check the count before
                // expanding it: even a finite note duration can overflow this multiplication.
                if !n.is_finite() || n > GestureScore::CAPACITY.saturating_sub(oral_start) as f64 {
                    return Err("trill contacts exceed the remaining gesture score capacity");
                }
                let mut k = 0.0;
                while k < n {
                    let a = t0 + (k / n) * dur;
                    add_oral(&def.targets, a, a + 0.35 / 26.0, 3.2, def.ipa);
                    k += 1.0;
                }
            }
            Manner::Affricate => {
                let split = t0 + dur * 0.55;
                add_oral(&def.targets, t0, split, 2.0, def.ipa);
                let rel = def.release.and_then(|r| phoneme(r, body));
                if let Some(rel) = rel {
                    add_oral(&rel.targets, split + 0.008, t1, 1.4, def.ipa);
                }
            }
            Manner::Fricative | Manner::Approximant | Manner::Lateral => add_oral(&def.targets, t0, t1, 1.3, def.ipa),
            Manner::Glottal | Manner::Vowel => {}
        }
        if def.ipa == "ɾ" && !s.syllabic_r && dur <= 0.035 {
            let dental_stop = |d: &PhonemeDef| d.manner == Manner::Stop && d.place == "dental";
            let preceding = prev_seg.and_then(|seg| seg.def).filter(dental_stop);
            if let Some(neighbor) = preceding.or(next_def.filter(dental_stop)) {
                let previous_stop_duration = preceding.map(|_| t0 - times[i - 1].t0);
                coordinate_dental_tap(&mut gestures, oral_start, times[i], &neighbor, previous_stop_duration);
            }
        }
        // nasality: the velum lowers in anticipation (into the preceding vowel, as in English) and
        // seals again by the end of the nasal; 0.45 cm² is ample for the murmur
        if def.nasal == Some(true) {
            let mut opening = Gesture::new(t0 - 0.02, t1 - 0.02, 0.05, 0.03, 4.0, one(ArticKey::Velum, 0.45)).label("velum");
            // Before an oral stop the velum has to complete its upward travel
            // while the tongue or lips still occlude the oral route. Starting
            // its release at the stop boundary vents the whole short stop.
            if aspiration == Aspiration::Marked && next_def.is_some_and(|next| next.manner == Manner::Stop) {
                opening.t1 = t1 - (0.5 * dur).min(0.055);
                opening.ramp_out = 0.015;
                opening = opening.speed(1.8).release_hold(0.055);
            }
            gestures.push(opening);
        }
        // phonation
        let k2 = 1.0; // abduction is body-scaled in the voice
        if def.glottal == Some(Glottal::Open) {
            gestures.push(Gesture::new(t0 - 0.01, t1, 0.03, 0.035, 5.0, one(ControlKey::ABDUCTION, 0.33 * k2)).label("h"));
        } else if def.glottal == Some(Glottal::Breathy) {
            gestures.push(Gesture::new(t0, t1, 0.03, 0.03, 5.0, one(ControlKey::ABDUCTION, 0.1 * k2)).label("ɦ"));
        } else if def.glottal == Some(Glottal::Stop) {
            gestures.push(Gesture::new(t0, t1, 0.012, 0.015, 8.0, one(ControlKey::CLOSURE, 1.0)).label("ʔ"));
        } else if def.voicing == Voicing::Voiceless {
            if def.manner == Manner::Stop || def.manner == Manner::Affricate {
                // English: aspirated when syllable-initial before a vowel and not after /s/;
                // marked: only where written
                let by_rule = aspiration == Aspiration::English && next_vowel && !prev_seg.is_some_and(|p| p.ipa == "s");
                let aspirated = release == Release::Aspirated || by_rule;
                let vot = if release == Release::Aspirated { MARKED_VOT / rate } else if aspirated { 0.05 / rate } else { 0.012 };
                let ramp_out = if release == Release::Aspirated { 0.06 } else if aspirated { 0.045 } else { 0.02 };
                // a plain stop where aspiration is marked is short-lag (French, Hindi t: ~10–20 ms):
                // the folds come together before the release, not after it
                let (end, open) = if !aspirated && aspiration == Aspiration::Marked { (t1 - PLAIN_LEAD, PLAIN_ABDUCTION) } else { (t1 + vot * 0.4, if aspirated { 0.36 } else { 0.22 }) };
                gestures.push(Gesture::new(t0 + 0.25 * dur, end, 0.035, ramp_out, 6.0, one(ControlKey::ABDUCTION, open)).label("aspiration"));
                if held {
                    // the folds stay apart through the hold, so the air behind the closure stays at
                    // the lungs' pressure (none, once the breath has gone) and the late release is silent
                    gestures.push(Gesture::new(t1, t1 + UNRELEASED_HOLD + 0.05, 0.03, 0.05, 6.0, one(ControlKey::ABDUCTION, 0.3)).label("held release"));
                }
            } else {
                gestures.push(Gesture::new(t0 - 0.015, t1 + 0.005, 0.03, 0.03, 6.0, one(ControlKey::ABDUCTION, 0.3)).label("voiceless"));
            }
        } else if def.manner == Manner::Fricative {
            gestures.push(Gesture::new(t0, t1, 0.03, 0.03, 3.0, one(ControlKey::ABDUCTION, 0.035)).label("voiced frication"));
        } else if matches!(def.manner, Manner::Stop | Manner::Affricate) && matches!(release, Release::Breathy | Release::Aspirated) {
            // breathy release: voiced through the closure, then the folds part a little at the
            // release and keep vibrating, so the vowel starts murmured ("bʱ")
            gestures.push(Gesture::new(t1 + BREATHY_START, t1 + BREATHY_LAG, 0.02, 0.04, 5.0, one(ControlKey::ABDUCTION, BREATHY_ABDUCTION)).label("breathy release"));
            gestures.push(Gesture::new(t1 + BREATHY_START, t1 + BREATHY_LAG, 0.02, 0.04, 5.0, one(ControlKey::POSTERIOR_GAP, BREATHY_POSTERIOR_GAP)).label("posterior murmur"));
        }
        // a voiced stop where aspiration is marked is voiced through its closure (Hindi, Sanskrit,
        // French b d g are prevoiced): the pharynx widens as the closure holds (larynx down, tongue
        // root forward), so the air behind it keeps flowing and the folds keep vibrating. Without
        // it the pressure behind the closure catches up in ~35 ms and the release comes out of
        // silence: heard as p (and bʱ as pʰ).
        // A breathy stop (bʱ) is prevoiced in any mode: it only exists in languages that voice it.
        let voiced_stop = def.voicing == Voicing::Voiced && matches!(def.manner, Manner::Stop | Manner::Affricate);
        if voiced_stop && (aspiration == Aspiration::Marked || matches!(release, Release::Breathy | Release::Aspirated)) {
            let tg = one(ArticKey::Larynx, PREVOICE_LARYNX).with(ArticKey::Root, PREVOICE_ROOT);
            // from the closure on, at a pace that spends the larynx's travel over the whole closure:
            // the widening must still be under way at the release (sooner, it stops halfway and the
            // voice dies with it)
            gestures.push(Gesture::new(t0, t1, 0.03, 0.08, 4.0, tg).speed(PREVOICE_SPEED).label("prevoicing"));
        }
    }
    let open_end = o.open_end == Some(true);
    let sung = o.sung == Some(true);
    // ---- breath: on through the utterance. A sung phrase's onset is planned (its first vowel
    // lands on the beat), so a singer times the breath to it: the pressure reaches full drive as
    // the first segment starts, and builds into adducted folds or behind the first constriction
    // rather than voicing ahead of the note. Speech and live notes keep their 20 ms lead.
    let breath_at = if sung { BREATH_SUNG_AT } else { 0.04 };
    gestures.push(Gesture::new(o.t0 + breath_at, end, 0.04, if open_end { 0.07 } else { 0.05 }, 1.0, one(ControlKey::BREATH, 1.0)).label("breath"));
    // ---- end of the breath group: the folds part as the breath stops, so a final obstruent is
    // released into silence instead of into an added vowel ("cat-uh"). After a vowel or sonorant
    // they part once the pressure has fallen, so the voice fades out instead of ending in an [h].
    if !open_end {
        let last = segs.last();
        let sonorant = last.is_some_and(|l| l.vowel.is_some()) || last.and_then(|l| l.def).is_some_and(|d| matches!(d.manner, Manner::Nasal | Manner::Approximant | Manner::Lateral | Manner::Tap | Manner::Trill));
        let at = end + if sonorant { 0.045 } else { 0.015 };
        gestures.push(Gesture::new(at, end + 0.1, 0.03, 0.06, 6.0, one(ControlKey::ABDUCTION, 0.22)).label(EXHALE_LABEL));
    }
    // ---- intonation: pitch targets on vowels
    let f0 = o.f0.unwrap_or(110.0);
    let accent = o.accent.unwrap_or(0.14);
    let total = js_max(0.2, end - o.t0);
    // the nuclear accent: the phrase's last primary-stressed vowel, a bigger excursion that falls
    // (statements) into the final low; earlier accents are smaller (a "hat" pattern)
    let mut nuclear: isize = -1;
    for &i in &v_idx {
        if segs[i].stress == Some(1) && !segs[i].glide_from {
            nuclear = i as isize;
        }
    }
    for (n, &i) in v_idx.iter().enumerate() {
        let s = &segs[i];
        let Span { t0, t1 } = times[i];
        // pitch holds through the consonants up to the next vowel (instead of sagging to the base)
        let hold = if n < v_idx.len() - 1 { js_max(t1, times[v_idx[n + 1]].t0 - 0.03) } else { t1 };
        let mut target: f64;
        let has_f0 = truthy(s.f0);
        if has_f0 {
            target = s.f0.unwrap();
        } else {
            let prog = (t0 - o.t0) / total;
            let decl = 1.0 - 0.1 * prog;
            let is_nuclear = i as isize == nuclear;
            let acc = if s.stress == Some(1) {
                1.0 + (if is_nuclear { accent * 1.8 } else { accent })
            } else if s.stress == Some(2) {
                1.0 + accent * 0.5
            } else {
                1.0
            };
            target = f0 * decl * acc;
            let last = n == v_idx.len() - 1;
            if last && o.intonation == Some(Intonation::Question) {
                target = f0 * 1.35;
            }
            if last && o.intonation.unwrap_or(Intonation::Statement) == Intonation::Statement {
                if is_nuclear && t1 - t0 > 0.08 {
                    // accent peak early in the vowel, then the fall within it
                    gestures.push(Gesture::new(t0, t0 + 0.35 * (t1 - t0), 0.05, 0.05, 1.0, one(ControlKey::F0, target)).label("pitch"));
                    gestures.push(Gesture::new(t0 + 0.55 * (t1 - t0), t1, 0.06, 0.06, 1.0, one(ControlKey::F0, f0 * 0.82)).label("pitch"));
                    continue;
                }
                target = f0 * 0.82;
            }
        }
        let r = if has_f0 && sung { pitch_ramp(t1 - t0) } else { 0.06 };
        gestures.push(Gesture::new(t0, if has_f0 { t1 } else { hold }, r, r, if has_f0 { 6.0 } else { 1.0 }, one(ControlKey::F0, target)).label("pitch"));
    }
    // sung: a consonant given its note's pitch holds it, so the pitch moves during an onset
    // consonant and has arrived when the vowel starts
    for (i, s) in segs.iter().enumerate() {
        if sung && s.vowel.is_none() && truthy(s.f0) {
            let Span { t0, t1 } = times[i];
            let r = pitch_ramp(t1 - t0);
            gestures.push(Gesture::new(t0, t1, r, r, 6.0, one(ControlKey::F0, s.f0.unwrap())).label("pitch"));
        }
    }
    for (index, from, to) in continuous_glides {
        shape_oral_glide(&mut gestures, from, to, times[index].t0, times[index + 1].t1);
    }
    Ok(Plan { gestures, segments: planned, end })
}

/// An explicitly non-syllabic endpoint gives one moving vowel, including over tied notes.
pub(super) fn continuous_diphthong(ipa: &str) -> Option<(&'static str, &'static str)> {
    match ipa { "ai̯" => Some(("a", "i")), "au̯" => Some(("a", "u")), _ => None }
}

/// Crossfade the two calibrated postures. Consonants, nasality, the note's pitch
/// and its breath retain their own independently timed gestures.
pub(super) fn shape_oral_glide(gestures: &mut Vec<Gesture>, from: &str, to: &str, start: f64, end: f64) {
    let span = end - start;
    let begin = start + 0.18 * span;
    let finish = start + 0.86 * span;
    gestures.retain_mut(|g| {
        if g.t0 < start - 1e-7 || g.t1 > end + 1e-7 { return true; }
        if g.label_str() == from {
            if (g.t0 - start).abs() > 1e-7 { return false; }
            g.t1 = begin;
            g.ramp_out = finish - begin;
        } else if g.label_str() == to {
            if (g.t1 - end).abs() > 1e-7 { return false; }
            g.t0 = finish;
            g.ramp_in = finish - begin;
        }
        true
    });
}

/// Front-to-back order of the oral places of articulation.
fn place_rank(place: &str) -> Option<u8> {
    Some(match place {
        "bilabial" => 0,
        "labiodental" => 1,
        "dental" => 2,
        "alveolar" => 3,
        "postalveolar" => 4,
        "retroflex" => 5,
        "palatal" => 6,
        "velar" => 7,
        "uvular" => 8,
        _ => return None,
    })
}

/// How much later a pre-placed closure behind another stop's closure is aimed (s): the time its
/// shorter travel saves, so it seals as the front closure opens.
const PLACED_CLOSURE_DELAY: f64 = 0.025;

/// Whether stop `i` closes behind the closure of the stop before it, with its own articulators
/// already set by the consonant before that one (/t/ in /ɹpt/: the tip is up for the /ɹ/ and
/// stays free during the lip closure; a rhotic vowel raises it too). After any other vowel ("apt",
/// "napkin") the timing is unchanged.
fn pre_placed_behind_closure(segs: &[Seg], i: usize) -> bool {
    let (Some(def), Some(prev)) = (segs[i].def.as_ref(), i.checked_sub(1).and_then(|j| segs[j].def.as_ref())) else { return false };
    if def.manner != Manner::Stop || prev.manner != Manner::Stop || !closes_in_front(prev.place, def.place) || i < 2 {
        return false;
    }
    let before = &segs[i - 2];
    let rhotic = before.vowel.as_ref().filter(|v| v.get(ArticKey::TtCurl).unwrap_or(0.0) > 0.05);
    let Some(tg) = before.def.as_ref().map(|d| &d.targets).or(rhotic) else { return false };
    def.dominant.iter().all(|k| tg.get(*k).is_some())
}

/// Whether a closure at `front` lies in front of one at `back`.
fn closes_in_front(front: &str, back: &str) -> bool {
    matches!((place_rank(front), place_rank(back)), (Some(f), Some(b)) if f < b)
}

/// Ramps of a given pitch (a sung note's) on a segment `dur` long: 60 ms, but at most half the
/// segment. A ramp-in starts before the segment, so in a fast run a full 60 ms would pull the
/// previous vowel off its note for most of its length.
fn pitch_ramp(dur: f64) -> f64 {
    js_min(0.06, js_max(0.008, 0.5 * dur))
}

/// A short tap next to a dental stop shares its tongue-tip posture. Distinguish
/// the two contacts with a brief withdrawal. Otherwise the default overlapping
/// closures pin the tip against the palate through both phones.
fn coordinate_dental_tap(out: &mut Vec<Gesture>, oral_start: usize, span: Span, dental: &PhonemeDef, previous_stop_duration: Option<f64>) {
    let tap = &mut out[oral_start]; // the dominant gesture emitted by oral_gestures_into
    let dur = span.t1 - span.t0;
    let dental_y = dental.targets.get(ArticKey::TtY).unwrap();
    for (key, weight) in [(ArticKey::TtX, 0.75), (ArticKey::TtY, 0.85)] {
        let alveolar = tap.targets.get(key).unwrap();
        let adjacent = dental.targets.get(key).unwrap();
        tap.targets.set(key, alveolar + weight * (adjacent - alveolar));
    }
    let a = span.t0;
    let after_stop = previous_stop_duration.is_some();
    tap.t0 = a - if after_stop { 0.004 } else { 0.018 };
    tap.t1 = a + if after_stop { (0.45 * dur).min(0.009) } else { 0.001 };
    tap.ramp_in = if after_stop { 0.004 } else { 0.008 };
    tap.ramp_out = 0.004;
    tap.strength = 65.0;
    tap.speed = Some(3.5);
    // Withdraw before the tap in /t̪ɾ/, and between tip contacts in /ɾd̪/.
    // The score clock and the adjacent stop's own closure remain unchanged.
    let (start, end) = match previous_stop_duration {
        Some(stop_dur) => (a - (0.35 * stop_dur).min(0.021), a - (stop_dur / 6.0).min(0.010)),
        None => (a + 0.15 * dur, a + 0.45 * dur),
    };
    out.push(Gesture::new(start, end, 0.004, 0.004, 60.0, one(ArticKey::TtY, dental_y - 1.3)).speed(3.5).label("tip release"));
}

/// Oral gestures for one consonant constriction held acoustically from `a` to `b` (closure to
/// release): a dominant gesture on the consonant's own articulators and a weak one on the rest.
/// Movement latencies are compensated so the acoustic closure and release land on a and b.
pub fn oral_gestures(def: &PhonemeDef, tg: &ArticPatch, a: f64, b: f64, speed: f64, label: &str) -> Vec<Gesture> {
    let mut out = Vec::with_capacity(4);
    oral_gestures_into(def, tg, a, b, speed, label, &mut out);
    out
}

/// [`oral_gestures`], appended to `out` (at most four gestures; no allocation when `out` has
/// room for them).
pub fn oral_gestures_into(def: &PhonemeDef, tg: &ArticPatch, a: f64, b: f64, speed: f64, label: &str, out: &mut Vec<Gesture>) {
    let mut dom = ArticPatch::default();
    let mut sec = ArticPatch::default();
    for (k, v) in tg.iter() {
        if def.dominant.contains(&k) {
            dom.set(k, v);
        } else {
            sec.set(k, v);
        }
    }
    let is = |k: &ArticKey, a: ArticKey, b: ArticKey, c: ArticKey| *k == a || *k == b || *k == c;
    // the dorsum is heavy: its releases are slower than tip and lip releases
    let body_only = def.dominant.iter().all(|k| is(k, ArticKey::TbX, ArticKey::TbY, ArticKey::Root));
    let sp = if body_only { 1.0 + (speed - 1.0) * 0.35 } else { speed };
    // articulators need ~10–15 ms to climb out of the overshoot (contact) target, so the
    // gesture releases early and the acoustic release lands on the planned boundary:
    // measured movement latencies (closure lag / release lag) per articulator class
    let closing = matches!(def.manner, Manner::Stop | Manner::Nasal | Manner::Affricate);
    let lips_only = def.dominant.iter().all(|k| *k == ArticKey::LipAp || *k == ArticKey::Labiodental);
    let lead = if closing { if body_only { 0.034 } else if lips_only { 0.019 } else { 0.02 } } else { 0.0 };
    // a consonant must own its constriction articulators (Task-Dynamics style): at strength 40
    // the overlapping vowel contributes ~2 %, so closures seal instead of being diluted
    let early = if closing { if body_only { 0.024 } else if lips_only { 0.022 } else { 0.031 } } else { 0.008 };
    if !dom.is_empty() {
        out.push(Gesture::new(a - early, js_max(a + 0.01, b - lead), 0.03, if body_only { 0.03 } else { 0.018 }, 40.0, artic_targets(&dom)).speed(sp).release_hold(0.045).label(label));
    }
    // alveolars front the tongue body during the closure (the alveolar F2 locus, ~1.8 kHz)
    let alveolar = def.place == "alveolar" && tg.get(ArticKey::TbX).is_none() && matches!(def.manner, Manner::Stop | Manner::Nasal | Manner::Fricative | Manner::Affricate | Manner::Tap);
    if alveolar {
        out.push(Gesture::new(a, b, 0.05, 0.05, 1.2, Targets::default().with(ArticKey::TbX, 3.2).with(ArticKey::TbY, 7.4)).label(label));
    }
    if !sec.is_empty() {
        // a velar's front–back place follows the vowel (fronted /k/ in "key", backed in "caw"):
        // its own tbX only weakly, so the F2 locus moves with the vowel as in natural speech
        let place = if body_only { sec.get(ArticKey::TbX) } else { None };
        if place.is_some() {
            sec.values[ArticKey::TbX.index()] = None;
        }
        if !sec.is_empty() {
            out.push(Gesture::new(a, b, 0.05, 0.05, 2.2, artic_targets(&sec)).label(label));
        }
        if let Some(x) = place {
            out.push(Gesture::new(a, b, 0.05, 0.05, 0.25, one(ArticKey::TbX, x)).label(label));
        }
    }
}

/// One phrase of [`plan_phrases`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseInput {
    pub segments: Vec<Segment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intonation: Option<Intonation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<f64>,
}

/// Plan consecutive phrases (each with its own breath group and intonation) from t0.
/// `o.intonation` is ignored (each phrase brings its own).
pub fn plan_phrases(phrases: &[PhraseInput], o: &PlanOptions) -> Plan {
    let mut all = Plan { gestures: Vec::new(), segments: Vec::new(), end: o.t0 };
    let mut t = o.t0;
    for p in phrases {
        let plan = plan_utterance(&p.segments, &PlanOptions { t0: t, intonation: Some(p.intonation.unwrap_or(Intonation::Statement)), ..o.clone() });
        all.gestures.extend_from_slice(&plan.gestures);
        all.segments.extend(plan.segments);
        t = plan.end + p.pause.unwrap_or(0.25);
        all.end = plan.end;
    }
    all
}
