use chimera::anatomy::human::{ArticKey, ArticPatch, BODY_MALE};
use chimera::sources::two_mass::TwoMassGlottis;
use chimera::voice::human_voice::{HumanVoice, SourcePatch};

#[test]
fn tissue_motion_requires_pressure_and_is_self_sustaining() {
    let mut folds = TwoMassGlottis::default();
    let mut low = f64::INFINITY;
    let mut high = 0.0_f64;
    for i in 0..96000 {
        let area = folds.next(96000.0, 8.0 * 980.665, 134.0, 0.0, 0.0, true);
        assert!(area.is_finite() && area >= 0.0);
        if i > 48000 {
            low = low.min(area);
            high = high.max(area);
        }
    }
    println!(
        "standalone area {low:.4}..{high:.4}; f0 {:.2}; voicing {:.3}",
        folds.f0, folds.voicing
    );
    assert!(high - low > 0.05);
    assert!(folds.voicing > 0.9);
    for _ in 0..48000 {
        folds.next(96000.0, 0.0, 134.0, 0.0, 0.0, true);
    }
    assert!(folds.voicing < 0.01);
}

#[test]
fn tissue_model_couples_to_airway_and_finite_breath() {
    for pitch in [116.54, 134.16, 220.0] {
        let mut voice = HumanVoice::new(48000.0, BODY_MALE, 2);
        voice.set_source(&SourcePatch {
            self_oscillating: Some(true),
            respiration: Some(true),
            pressure: Some(8.0),
            f0: Some(pitch),
            breathiness: Some(0.08),
            roughness: Some(0.0),
            drift: Some(0.0),
            ..Default::default()
        });
        let mut articulation = ArticPatch::default();
        articulation.set(ArticKey::LipAp, 0.4);
        voice.set_articulation(&articulation, None);
        voice.set_gate(1.0);
        let mut block = [0.0_f32; 128];
        let mut energy = 0.0;
        let mut peak = 0.0_f32;
        for i in 0..750 {
            voice.render(&mut block);
            assert!(block.iter().all(|v| v.is_finite()));
            peak = block.iter().fold(peak, |p, v| p.max(v.abs()));
            if i > 375 {
                energy += block.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
            }
        }
        println!(
            "coupled requested {pitch:.2}, measured {:.2}, voicing {:.3}, RMS {:.4}, peak {peak:.4}, volume {:.3}",
            voice.glottis.f0_now,
            voice.glottis.voicing,
            (energy / (374.0 * 128.0)).sqrt(),
            voice.respiration.state.volume
        );
        assert!(energy > 0.01);
        assert!((voice.glottis.f0_now / pitch - 1.0).abs() < 0.01);
        assert!(peak < 0.99);
        assert!(voice.respiration.state.volume < 3.05);
    }
}

#[test]
fn tissue_source_is_block_independent_and_whisper_stops_vibration() {
    let mut voice = HumanVoice::new(48000.0, BODY_MALE, 2);
    voice.set_source(&SourcePatch {
        self_oscillating: Some(true),
        respiration: Some(true),
        pressure: Some(8.0),
        f0: Some(134.0),
        ..Default::default()
    });
    voice.set_gate(1.0);
    let mut other = voice.clone();
    let mut whole = vec![0.0; 48000];
    let mut chunks = vec![0.0; 48000];
    voice.render(&mut whole);
    for block in chunks.chunks_mut(71) {
        other.render(block);
    }
    assert_eq!(whole, chunks);
    voice.set_source(&SourcePatch {
        voiced: Some(false),
        ..Default::default()
    });
    voice.render(&mut whole);
    assert!(voice.glottis.voicing < 0.01);
    voice.set_gate(0.0);
    voice.render(&mut whole);
    assert!(whole[24000..].iter().all(|sample| sample.is_finite()));
}

#[test]
fn human_voices_remain_finite_across_registers_and_body_sizes() {
    use chimera::anatomy::human::{BODY_CHILD, BODY_FEMALE};
    for body in [BODY_MALE, BODY_FEMALE, BODY_CHILD] {
        for physical in [false, true] {
            for pitch in [55.0, 440.0, 880.0] {
                let mut voice = HumanVoice::new(48000.0, body, 1);
                voice.set_source(&SourcePatch {
                    self_oscillating: Some(physical),
                    pressure: Some(12.0),
                    f0: Some(pitch),
                    ..Default::default()
                });
                voice.set_gate(1.0);
                let mut out = [0.0; 128];
                for _ in 0..150 {
                    voice.render(&mut out);
                    assert!(
                        out.iter()
                            .all(|sample| sample.is_finite() && sample.abs() < 0.99),
                        "body {} pitch {pitch} physical={physical}, range {:?}",
                        body.scale,
                        out.iter().copied().fold(
                            (f32::INFINITY, f32::NEG_INFINITY),
                            |(low, high), x| (low.min(x), high.max(x))
                        )
                    );
                }
            }
        }
    }
}

#[test]
fn airway_resolution_respects_small_bodies_and_lower_sample_rates() {
    use chimera::anatomy::human::{BODY_CHILD, BODY_FEMALE};
    use chimera::voice::human_airway::HumanAirway;
    for body in [BODY_MALE, BODY_FEMALE, BODY_CHILD] {
        for sample_rate in [32000.0, 44100.0, 48000.0, 96000.0] {
            let airway = HumanAirway::new(sample_rate, body);
            assert!(
                airway.net.check_cfl() <= 0.94,
                "body {} rate {} CFL {}",
                body.scale,
                sample_rate,
                airway.net.check_cfl()
            );
        }
    }
}
