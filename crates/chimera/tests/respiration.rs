use chimera::anatomy::human::{ArticPatch, BODY_MALE};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};
use chimera::voice::respiration::Respiration;

fn render(voice: &mut HumanVoice, seconds: f64) -> f64 {
    let mut samples = [0.0; 128];
    let mut peak = 0.0_f32;
    for _ in 0..(seconds * 48000.0 / 128.0) as usize {
        voice.render(&mut samples);
        for sample in samples {
            assert!(sample.is_finite());
            peak = peak.max(sample.abs());
        }
    }
    peak as f64
}

#[test]
fn respiratory_volume_integrates_signed_airflow() {
    let mut respiratory = Respiration::new(1.0);
    let initial = respiratory.state.volume;
    respiratory.advance_flow(200.0, 2.0);
    assert!((respiratory.state.volume - (initial - 0.4)).abs() < 1e-10);
    respiratory.advance_flow(-300.0, 1.0);
    assert!((respiratory.state.volume - (initial - 0.1)).abs() < 1e-10);
}

#[test]
fn explicit_inspiration_can_refill_an_empty_reservoir() {
    let mut respiratory = Respiration::new(1.0);
    respiratory.state.volume = 0.0;
    for _ in 0..1000 { respiratory.control(0.001, -2.0, 1.0); }
    assert!(respiratory.inhaling());
    assert!((respiratory.state.pressure + 2.0).abs() < 0.01);
    respiratory.state.volume = respiratory.state.capacity;
    for _ in 0..1000 { respiratory.control(0.001, -2.0, 1.0); }
    assert!(respiratory.state.pressure.abs() < 0.01);
}

#[test]
fn high_volume_soft_phonation_uses_inspiratory_braking() {
    let mut respiratory = Respiration::new(1.0);
    for _ in 0..1000 {
        respiratory.control(0.001, 2.5, 1.0);
    }
    assert!((respiratory.state.pressure - 2.5).abs() < 0.01);
    assert!(respiratory.state.diaphragm > 0.05);
    assert!(respiratory.state.abdomen < 0.01);
}

#[test]
fn actual_phonation_spends_air_and_rest_refills_the_lungs() {
    let mut voice = HumanVoice::new(48000.0, BODY_MALE, 2);
    voice.set_source(&SourcePatch { respiration: Some(true), pressure: Some(8.0), ..Default::default() });
    let initial = voice.respiration.state.volume;
    assert!(render(&mut voice, 0.15) < 1e-6, "enabling respiration should not start an uncommanded note");
    voice.set_gate(1.0);
    assert!(render(&mut voice, 2.0) > 0.005);
    let spent = voice.respiration.state.volume;
    assert!(spent < initial - 0.03, "actual flow must reduce volume: {initial} -> {spent}");
    assert!((voice.respiration.state.pressure - 8.0).abs() < 1.5);
    voice.set_gate(0.0);
    render(&mut voice, 3.0);
    assert!(voice.respiration.state.volume > spent + 0.02);
    assert!(voice.glottis.voicing < 0.05);
}

#[test]
fn finite_air_and_expiratory_effort_bound_a_long_note() {
    let mut voice = HumanVoice::new(48000.0, BODY_MALE, 2);
    voice.set_source(&SourcePatch { respiration: Some(true), pressure: Some(12.0), breathiness: Some(0.4), ..Default::default() });
    voice.respiration.state.volume = 0.12;
    voice.set_gate(1.0);
    render(&mut voice, 2.0);
    assert!(voice.respiration.state.volume >= 0.0);
    assert!(voice.respiration.state.pressure < 4.0);
    assert!(voice.respiration.state.abdomen <= 1.0);
}

#[test]
fn posterior_gap_preserves_fold_vibration() {
    let mut voice = HumanVoice::new(48000.0, BODY_MALE, 2);
    voice.set_source(&SourcePatch { posterior_gap: Some(0.035), pressure: Some(9.0), ..Default::default() });
    voice.set_articulation(&ArticPatch::default(), None);
    voice.set_gate(1.0);
    render(&mut voice, 0.8);
    assert!(voice.glottis.voicing > 0.8);
    assert!(voice.glottis.params.chink > 0.04);
    assert!(voice.glottis.params.abduction < 0.01);
}

#[test]
fn respiratory_phonation_is_independent_of_host_block_size() {
    let mut whole = HumanVoice::new(48000.0, BODY_MALE, 2);
    whole.set_source(&SourcePatch { respiration: Some(true), ..Default::default() });
    whole.set_gate(1.0);
    let mut chunked = whole.clone();
    let mut a = vec![0.0; 12000];
    let mut b = vec![0.0; 12000];
    whole.render(&mut a);
    for chunk in b.chunks_mut(71) { chunked.render(chunk); }
    assert_eq!(a, b);
    assert_eq!(whole.respiration.state.volume, chunked.respiration.state.volume);
}

#[test]
fn earlier_source_json_receives_compatible_defaults() {
    let mut json = serde_json::to_value(chimera::voice::human_voice::DEFAULT_SOURCE).unwrap();
    json.as_object_mut().unwrap().remove("respiration");
    json.as_object_mut().unwrap().remove("posteriorGap");
    json.as_object_mut().unwrap().remove("selfOscillating");
    let source: chimera::voice::human_voice::VoiceSource = serde_json::from_value(json).unwrap();
    assert!(!source.respiration);
    assert_eq!(source.posterior_gap, 0.0);
    assert!(!source.self_oscillating);
}
