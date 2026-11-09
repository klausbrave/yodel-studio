//! Stops as written in IPA, for the languages English rules get wrong: aspiration only where
//! written ("tʰ", Hindi and Sanskrit; and none at all in French, Spanish, Italian), breathy-voiced
//! releases ("bʱ", Hindi and Sanskrit bh dh gh), and dental t d n ("t̪").
//!
//! Measured on the voice model itself, every millisecond: the release is when the oral
//! constriction opens, voice onset when the folds vibrate again, and a breathy release shows as
//! folds that never close during the first cycles of the vowel.
use chimera::anatomy::human::{BODY_CHILD, BODY_FEMALE, BODY_MALE, HumanBody};
use chimera::phonetics::ipa::tokenize_ipa;
use chimera::phonetics::planner::{Aspiration, PlanOptions, plan_utterance};
use chimera::phonetics::sing::{SongOptions, SungNote, plan_song};
use chimera::phonetics::{Segment, Syllable};
use chimera::voice::human_voice::{HumanVoice, SourcePatch, VoiceTelemetry};

const FS: f64 = 48000.0;
const MS: usize = 48;

struct Trace {
    /// narrowest oral area (cm²), per ms
    min_oral: Vec<f64>,
    /// where along the oral tube it is (0 = back), per ms
    min_at: Vec<f64>,
    voicing: Vec<f64>,
    /// smallest glottal area over the last two cycles (cm²): above 0 when the folds never close
    glottal_min: Vec<f64>,
    /// when the stop's segment starts and ends (s)
    stop: (f64, f64),
}

fn trace(ipa: &str, aspiration: Option<Aspiration>) -> Trace {
    trace_in(ipa, aspiration, BODY_MALE, "male", 110.0)
}

fn trace_in(ipa: &str, aspiration: Option<Aspiration>, body: HumanBody, name: &str, f0: f64) -> Trace {
    let segs = tokenize_ipa(ipa);
    let plan = plan_utterance(&segs, &PlanOptions { body: name.into(), t0: 0.05, f0: Some(f0), aspiration, ..Default::default() });
    trace_plan(plan, body, f0)
}

/// A short sung phrase (stops as written) in the male voice, on the chant's clock (0.22 s a beat):
/// (onset, vowel, coda, beats) per note.
fn trace_sung(notes: &[(&[&str], &str, &[&str], f64)]) -> Trace {
    let seg = |x: &&str| Segment::new(x);
    let mut sung: Vec<SungNote> = notes
        .iter()
        .map(|(on, v, co, beats)| SungNote { midi: 50.0, beats: *beats, syl: Syllable { text: v.to_string(), onset: on.iter().map(seg).collect(), nucleus: Segment::new(v), coda: co.iter().map(seg).collect(), melisma: None, word_end: true, phrase_end: false } })
        .collect();
    sung.last_mut().unwrap().syl.phrase_end = true;
    let plan = plan_song(&sung, &SongOptions { body: "male".into(), bpm: 60.0 / 0.22, t0: 0.3, vibrato: 0.0, aspiration: Some(Aspiration::Marked) });
    trace_plan(plan, BODY_MALE, 146.8)
}

fn trace_plan(plan: chimera::phonetics::Plan, body: HumanBody, f0: f64) -> Trace {
    let stop = plan.segments.iter().find(|s| s.kind == "stop" || s.kind == "nasal").expect("a stop");
    let mut v = HumanVoice::new(FS, body, 2);
    v.set_source(&SourcePatch::f0(f0));
    v.schedule(&plan.gestures);
    let mut tel = VoiceTelemetry::default();
    let mut buf = [0f32; MS];
    let n = ((plan.end + 0.1) * 1000.0) as usize;
    let mut t = Trace { min_oral: vec![], min_at: vec![], voicing: vec![], glottal_min: vec![], stop: (stop.t0, stop.t1) };
    for _ in 0..n {
        v.render(&mut buf);
        v.telemetry(&mut tel);
        let (k, m) = tel.or_areas.iter().enumerate().fold((0, f32::INFINITY), |b, (k, a)| if *a < b.1 { (k, *a) } else { b });
        t.min_oral.push(m as f64);
        t.min_at.push(k as f64 / tel.or_areas.len() as f64);
        t.voicing.push(tel.voicing);
        t.glottal_min.push(tel.glottal_area.iter().fold(f32::INFINITY, |a, b| a.min(*b)) as f64);
    }
    t
}

impl Trace {
    /// ms the oral closure opens (narrowest area back above 0.05 cm² after sealing)
    fn release(&self) -> usize {
        let a = (self.stop.0 * 1000.0) as usize;
        let sealed = (a..).find(|&i| self.min_oral[i] < 1e-3).expect("the stop seals");
        (sealed..).find(|&i| self.min_oral[i] > 0.05).expect("the stop releases")
    }
    /// voice onset time (ms): release to the folds vibrating again
    fn vot(&self) -> f64 {
        let r = self.release();
        (r..self.voicing.len()).find(|&i| self.voicing[i] >= 0.5).expect("voicing resumes") as f64 - r as f64
    }
    /// where the closure is, along the oral tube (0 back, 1 lips)
    fn place(&self) -> f64 {
        self.min_at[self.release() - 10]
    }
}

#[test]
fn english_aspiration_is_unchanged_and_marked_stops_are_short_lag() {
    let english = trace("ˈtɑ", None).vot();
    let plain = trace("ˈtɑ", Some(Aspiration::Marked)).vot();
    println!("VOT: English t {english} ms, marked t {plain} ms");
    // English /t/ before a stressed vowel: long lag (~50–70 ms)
    assert!((45.0..=80.0).contains(&english), "English t VOT {english} ms");
    // French, Spanish, Hindi, Sanskrit plain t: short lag (~10–20 ms)
    assert!(plain <= 20.0, "plain t VOT {plain} ms");
    // after /s/ English stops stay unaspirated
    assert!(trace("sˈtɑ", None).vot() < 30.0);
}

#[test]
fn a_written_aspirate_is_aspirated_in_either_mode() {
    for asp in [None, Some(Aspiration::Marked)] {
        for ipa in ["ˈtʰɑ", "ˈpʰɑ", "ˈkʰɑ"] {
            let vot = trace(ipa, asp).vot();
            println!("VOT {ipa} {asp:?}: {vot} ms");
            // Hindi voiceless aspirates: ~70–90 ms, longer than English's
            assert!((65.0..=100.0).contains(&vot), "{ipa} VOT {vot} ms");
        }
    }
}

#[test]
fn a_breathy_release_stays_voiced_with_the_folds_apart() {
    for (plain, breathy) in [("ˈbɑ", "ˈbʱɑ"), ("ˈdɑ", "ˈdʱɑ"), ("ˈgɑ", "ˈgʱɑ"), ("ˈbɑ", "ˈbʰɑ")] {
        let (p, b) = (trace(plain, None), trace(breathy, None));
        let (rp, rb) = (p.release(), b.release());
        // how far apart the folds stay through each cycle, on average 15–50 ms into the vowel
        let leak = |t: &Trace, r: usize| (r + 15..r + 50).map(|i| t.glottal_min[i]).sum::<f64>() / 35.0;
        // from 15 ms after the release: alveolar and velar closures devoice before it (plain d, g do)
        let voicing = |t: &Trace, r: usize| (r + 15..r + 60).map(|i| t.voicing[i]).fold(f64::INFINITY, f64::min);
        let mean = |t: &Trace, r: usize| (r + 15..r + 60).map(|i| t.voicing[i]).sum::<f64>() / 45.0;
        println!("{breathy}: folds' gap 15–50 ms after release {:.3} cm² (plain {:.3}); voicing 15–60 ms min {:.2} mean {:.2} (plain min {:.2} mean {:.2})", leak(&b, rb), leak(&p, rp), voicing(&b, rb), mean(&b, rb), voicing(&p, rp), mean(&p, rp));
        // the folds don't close in the first cycles of the vowel (murmur)...
        assert!(leak(&b, rb) > 0.05 && leak(&p, rp) < 0.02, "{breathy}: no murmur");
        // ...yet keep vibrating about as well as the plain stop does: breathy voice, not an [h]
        // (voicing near 0). Alveolar and velar closures restart slowly either way.
        assert!(mean(&b, rb) > 0.8 && mean(&b, rb) > mean(&p, rp) - 0.1, "{breathy}: voicing dropped");
        let _ = voicing;
        // and close again within ~120 ms
        assert!(b.glottal_min[rb + 130] < 0.03, "{breathy}: murmur runs on");
    }
}

/// Share of the closure (the narrowest oral area at most 0.05 cm²) during which the folds vibrate.
fn voiced_share(t: &Trace) -> f64 {
    let r = t.release();
    // a velar seal leaves a sliver of area; the release threshold marks it closed
    let sealed = (0..r).rev().take_while(|&i| t.min_oral[i] <= 0.05).count();
    (r - sealed..r).filter(|&i| t.voicing[i] >= 0.5).count() as f64 / sealed as f64
}

/// Heard by ear in the Gayatri Mantra (2026-11-08): bhūr sang as "phūr". The folds stopped
/// vibrating ~35 ms into the closure, so the release came out of silence, heard as voiceless.
/// Where aspiration is marked (and for every breathy stop) the pharynx now widens through the
/// closure, and sung closures are kept short enough for that to carry the voice to the release.
#[test]
fn marked_voiced_stops_stay_voiced_through_the_closure() {
    // sung, as in the chant: voiced to (nearly) the release
    let cases: [(&str, &[(&[&str], &str, &[&str], f64)]); 5] = [
        ("ɐ bʱuːɾ", &[(&[], "ɐ", &[], 1.5), (&["bʱ"], "u", &["ɾ"], 3.0)]),
        ("ɐ buːɾ", &[(&[], "ɐ", &[], 1.5), (&["b"], "u", &["ɾ"], 3.0)]),
        // after a hum, the velum closing late
        ("oː.m̩ bʱuːɾ", &[(&[], "o", &[], 2.5), (&[], "m", &[], 2.5), (&["bʱ"], "u", &["ɾ"], 3.0)]),
        ("ɐ d̪ʱiː", &[(&[], "ɐ", &[], 1.5), (&["d̪ʱ"], "i", &[], 2.5)]),
        ("ɐ goː", &[(&[], "ɐ", &[], 1.5), (&["g"], "o", &[], 2.5)]),
    ];
    for (text, notes) in cases {
        let share = voiced_share(&trace_sung(notes));
        println!("sung {text}: voiced through {:.0}% of the closure", share * 100.0);
        assert!(share >= 0.75, "sung {text}: voiced for only {:.0}% of its closure", share * 100.0);
    }
    // spoken, closures are longer than the widening can carry, but they keep the voice longer
    for ipa in ["ˈɑbɑ", "ˈɑdɑ", "ˈɑgɑ"] {
        let english = voiced_share(&trace(ipa, None));
        let marked = voiced_share(&trace(ipa, Some(Aspiration::Marked)));
        println!("spoken {ipa}: voiced through {:.0}% of the closure (English rule, unchanged: {:.0}%)", marked * 100.0, english * 100.0);
        assert!(marked >= english + 0.15, "spoken {ipa}: {marked} vs English {english}");
    }
}

#[test]
fn dental_stops_close_at_the_teeth() {
    // release() also checks that each one seals, in every body
    for (body, name, f0) in [(BODY_MALE, "male", 110.0), (BODY_FEMALE, "female", 200.0), (BODY_CHILD, "child", 250.0)] {
        for (dental, alveolar) in [("ˈt̪ɑ", "ˈtɑ"), ("ˈd̪ɑ", "ˈdɑ"), ("ˈn̪ɑ", "ˈnɑ")] {
            let m = Some(Aspiration::Marked);
            let (d, a) = (trace_in(dental, m, body, name, f0), trace_in(alveolar, m, body, name, f0));
            println!("{name} {dental} closes at {:.2} along the mouth, {alveolar} at {:.2}", d.place(), a.place());
            assert!(d.place() > a.place() + 0.05, "{name}: {dental} is not in front of {alveolar}");
        }
    }
}

#[test]
fn the_tokenizer_keeps_release_and_dental_marks() {
    let ipa = |s: &str| tokenize_ipa(s).into_iter().map(|x| x.ipa).collect::<Vec<_>>().join(" ");
    assert_eq!(ipa("tʰa"), "tʰ a");
    assert_eq!(ipa("bʱuːr"), "bʱ u r");
    // bʰ is a common spelling of the breathy bʱ
    assert_eq!(ipa("bʰa dʰa"), "bʱ a dʱ a");
    assert_eq!(ipa("tʃʰa t̪ʰa d̪ʱa n̪a"), "tʃʰ a t̪ʰ a d̪ʱ a n̪ a");
    // marks on segments that can't take them are skipped, as before
    assert_eq!(ipa("sʰa mʰa z̪a"), "s a m a z a");
    // the dental sibilant of Hindi and Sanskrit
    assert_eq!(ipa("s̪ɐ"), "s̪ ɐ");
    // no audible release, and the unrounded Hindi/Sanskrit c
    assert_eq!(ipa("jaːt̪̚ tɕoː t͡ɕa"), "j a t̪̚ tɕ o tɕ a");
    assert_eq!(ipa("sɑ̚"), "s ɑ");
}

/// The Gayatri ends on pracodayāt with its t held, not released (abhinidhāna): after the closure
/// the render stays silent, where a plain final t bursts as the breath stops.
#[test]
fn an_unreleased_final_stop_ends_in_silence() {
    let render = |ipa: &str| {
        let segs = tokenize_ipa(ipa);
        let plan = plan_utterance(&segs, &PlanOptions { body: "male".into(), t0: 0.05, f0: Some(110.0), aspiration: Some(Aspiration::Marked), ..Default::default() });
        let stop = plan.segments.last().unwrap().clone();
        let mut v = HumanVoice::new(FS, BODY_MALE, 2);
        v.set_source(&SourcePatch::f0(110.0));
        v.schedule(&plan.gestures);
        let mut out = vec![0f32; ((stop.t1 + 0.45) * FS) as usize];
        for chunk in out.chunks_mut(128) {
            v.render(chunk);
        }
        // loudest sample from 20 ms after the closure's end, against the vowel's
        let after = out[((stop.t1 + 0.02) * FS) as usize..].iter().fold(0f32, |m, x| m.max(x.abs()));
        let vowel = out[..(stop.t0 * FS) as usize].iter().fold(0f32, |m, x| m.max(x.abs()));
        20.0 * ((after / vowel) as f64).log10()
    };
    let held = render("ˈjaːt̪̚");
    let released = render("ˈjaːt̪");
    println!("after the closure: held {held:.0} dB, released {released:.0} dB (re the vowel)");
    assert!(held < -50.0 && released > held + 15.0);
}

#[test]
#[ignore]
fn print_traces() {
    for (ipa, asp) in [("ˈtɑ", None), ("ˈtɑ", Some(Aspiration::Marked)), ("ˈtʰɑ", None), ("ˈbʱɑ", None), ("ˈdʱɑ", None), ("ˈt̪ɑ", None)] {
        let t = trace(ipa, asp);
        println!("{ipa} {asp:?} stop {:.3}-{:.3}", t.stop.0, t.stop.1);
        let a = (t.stop.0 * 1000.0) as usize;
        for i in (a..(a + 160).min(t.min_oral.len())).step_by(4) {
            println!("  {:4} ms  oral {:7.4} at {:.2}  voicing {:.2}  glottal min {:.4}", i, t.min_oral[i], t.min_at[i], t.voicing[i], t.glottal_min[i]);
        }
    }
}

/// The engine's s (at the ridge) hisses around 3.7 kHz, low enough to be heard as ś; the dental s̪
/// of Hindi and Sanskrit has a shorter channel in front and hisses at 5 kHz and up, as recorded
/// Vedic recitation does (~6.4 kHz).
#[test]
fn the_dental_s_hisses_higher() {
    let peak = |ipa: &str| {
        let segs = tokenize_ipa(ipa);
        let plan = plan_utterance(&segs, &PlanOptions { body: "male".into(), t0: 0.05, f0: Some(110.0), aspiration: Some(Aspiration::Marked), ..Default::default() });
        let s = plan.segments.iter().find(|p| p.ipa.starts_with('s')).unwrap().clone();
        let mut v = HumanVoice::new(FS, BODY_MALE, 2);
        v.set_source(&SourcePatch::f0(110.0));
        v.schedule(&plan.gestures);
        let mut out = vec![0f32; ((plan.end + 0.1) * FS) as usize];
        for chunk in out.chunks_mut(128) {
            v.render(chunk);
        }
        let (a, b) = (((s.t0 + 0.25 * (s.t1 - s.t0)) * FS) as usize, ((s.t0 + 0.75 * (s.t1 - s.t0)) * FS) as usize);
        let x: Vec<f64> = out[a..b].iter().map(|v| *v as f64).collect();
        // energy above vs below 4.5 kHz, by a direct DFT on the middle of the hiss
        let band = |lo: f64, hi: f64| {
            let n = x.len();
            let mut e = 0.0;
            let mut f = lo;
            while f < hi {
                let (mut re, mut im) = (0.0, 0.0);
                for (k, v) in x.iter().enumerate() {
                    let w = 0.5 - 0.5 * (std::f64::consts::TAU * k as f64 / n as f64).cos();
                    let ph = std::f64::consts::TAU * f * k as f64 / FS;
                    re += v * w * ph.cos();
                    im += v * w * ph.sin();
                }
                e += re * re + im * im;
                f += 100.0;
            }
            e
        };
        band(4500.0, 8000.0) / band(2000.0, 4500.0)
    };
    let (ridge, dental) = (peak("ˈɐsɐ"), peak("ˈɐs̪ɐ"));
    println!("energy 4.5–8 kHz over 2–4.5 kHz: s {ridge:.2}, s̪ {dental:.2}");
    assert!(dental > 2.0 * ridge && dental > 1.0);
}
