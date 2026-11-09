//! Lyrics in IPA, between slashes: words no English dictionary has (other languages, chants,
//! mantras), sung syllable by syllable as written.
use chimera::phonetics::Syllable;
use chimera::phonetics::planner::Aspiration;
use chimera::phonetics::sing::{SongOptions, SungNote, plan_song};
use chimera::phonetics::syllables::{ipa_syllables, is_ipa_lyrics, lyrics_to_syllables};

fn no_dictionary(_: &str, _: bool) -> Vec<chimera::phonetics::Segment> {
    panic!("IPA lyrics must not look words up")
}

fn syls(text: &str) -> Vec<Syllable> {
    lyrics_to_syllables(text, &no_dictionary)
}

fn show(s: &Syllable) -> String {
    let ipa = |v: &[chimera::phonetics::Segment]| v.iter().map(|x| x.ipa.as_str()).collect::<Vec<_>>().join(" ");
    format!("{}[{}|{}|{}]{}{}", s.text, ipa(&s.onset), s.nucleus.ipa, ipa(&s.coda), if s.word_end { " #" } else { "" }, if s.phrase_end { " |" } else { "" })
}

#[test]
fn syllables_words_and_phrases_are_as_written() {
    let got: Vec<String> = syls("/oː.m̩ bʱuːɾ.bʱu.ʋɐs | sʋɐh/").iter().map(show).collect();
    assert_eq!(
        got,
        [
            "oː[|o|]",
            // a hum is a syllable: the nasal carries the note
            "m̩[|m|] #",
            "bʱuːɾ[bʱ|u|ɾ]",
            "bʱu[bʱ|u|]",
            "ʋɐs[ʋ|ɐ|s] # |",
            "sʋɐh[s ʋ|ɐ|h] #",
        ]
    );
}

#[test]
fn undotted_words_split_by_maximal_onset_and_marks_stay_out_of_the_text() {
    let got: Vec<String> = syls("/ˈhɛloʊ ˈstɹɔŋgɚ/").iter().map(show).collect();
    assert_eq!(got, ["hɛ[h|ɛ|]", "loʊ[l|oʊ|] #", "stɹɔŋ[s t ɹ|ɔ|ŋ]", "gɚ[g|ɚ|] #"]);
    // a tone letter is kept in what was written (a chant reads it), not in the shown text
    let t = ipa_syllables("/t̪ɐ˧.t̪ɐ˨/");
    assert_eq!(t.iter().map(|s| s.written.as_str()).collect::<Vec<_>>(), ["t̪ɐ˧", "t̪ɐ˨"]);
    assert_eq!(t.iter().map(|s| s.syl.text.as_str()).collect::<Vec<_>>(), ["t̪ɐ", "t̪ɐ"]);
}

#[test]
fn a_lone_dash_holds_the_vowel() {
    let s = syls("/lɑ - ~ ˈlu/");
    assert_eq!(s.iter().map(|x| (x.text.as_str(), x.nucleus.ipa.as_str(), x.melisma == Some(true))).collect::<Vec<_>>(), [("lɑ", "ɑ", false), ("~", "ɑ", true), ("~", "ɑ", true), ("lu", "u", false)]);
}

#[test]
fn only_slashed_lyrics_are_ipa() {
    assert!(is_ipa_lyrics(" /lɑ/"));
    assert!(!is_ipa_lyrics("la la"));
}

#[test]
fn an_ipa_song_plans_its_sounds_as_written() {
    let s = syls("/oː.m̩ bʱuːɾ/");
    let notes: Vec<SungNote> = s.iter().zip([50.0, 50.0, 52.0]).map(|(syl, midi)| SungNote { midi, beats: 1.0, syl: syl.clone() }).collect();
    let plan = plan_song(&notes, &SongOptions { body: "male".into(), bpm: 120.0, t0: 0.3, vibrato: 0.0, aspiration: Some(Aspiration::Marked) });
    let segs: Vec<(&str, f64)> = plan.segments.iter().map(|p| (p.ipa.as_str(), p.t1 - p.t0)).collect();
    assert_eq!(segs.iter().map(|s| s.0).collect::<Vec<_>>(), ["o", "m", "bʱ", "u", "ɾ"]);
    // the hum holds most of its half-second note
    assert!(segs[1].1 > 0.35, "m̩ lasts {} s", segs[1].1);
    assert!(plan.gestures.iter().any(|g| g.label.is_some_and(|l| l.as_str() == "breathy release")));
}

#[test]
fn a_long_consonant_is_held() {
    // "ː" on a consonant (a geminate, as in Sanskrit or Italian) keeps its length in a song
    let s_len = |text: &str| {
        let s = syls(text);
        let notes: Vec<SungNote> = s.iter().map(|syl| SungNote { midi: 50.0, beats: 1.0, syl: syl.clone() }).collect();
        let plan = plan_song(&notes, &SongOptions { body: "male".into(), bpm: 90.0, t0: 0.3, vibrato: 0.0, aspiration: Some(Aspiration::Marked) });
        plan.segments.iter().find(|p| p.ipa == "s").map(|p| p.t1 - p.t0).unwrap()
    };
    let (single, double) = (s_len("/ɐs.ɐ/"), s_len("/ɐsː.ɐ/"));
    println!("s {single:.3} s, sː {double:.3} s");
    assert!(double > 1.4 * single);
}
