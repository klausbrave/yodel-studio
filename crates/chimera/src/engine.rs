//! The human singing voice. Gesture times are relative to the render clock.

use crate::anatomy::human::{ArticPatch, BodyMix, BodyName};
use crate::control::score::{Gesture, GestureScore};
use crate::voice::human_voice::{HumanVoice, SourcePatch, VoiceTelemetry};

/// Gestures transferred in one preallocated batch. A score may span several batches.
pub const MAX_SCHEDULE: usize = 4000;

/// Default pitch per body (Hz): the presets', blended geometrically in between.
pub fn default_f0(body: impl Into<BodyMix>) -> f64 {
    let body = body.into();
    let f = |b: BodyName| match b {
        BodyName::Male => 110.0,
        BodyName::Female => 205.0,
        BodyName::Child => 260.0,
    };
    match body.preset() {
        Some(b) => f(b),
        None => crate::math::exp(body.blend(|b| crate::math::ln(f(b)))),
    }
}

/// Identity of the voice the engine is playing (the browser's "ready" message).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VoiceInfo {
    pub body: BodyMix,
    pub n_ph: usize,
    pub n_or: usize,
}

pub struct Engine {
    pub sample_rate: f64,
    body: BodyMix,
    voice: HumanVoice,
    /// the performer's breath (the voice's own gate also follows the score)
    gate_level: f64,
    scratch: Vec<Gesture>,

}

impl Engine {
    pub fn new(sample_rate: f64) -> Engine {
        crate::init();
        let body = BodyMix::MALE;
        Engine { sample_rate, body, voice: Self::make_voice(sample_rate, body), gate_level: 0.0, scratch: Vec::with_capacity(MAX_SCHEDULE) }
    }

    fn make_voice(fs: f64, body: BodyMix) -> HumanVoice {
        let mut v = HumanVoice::new(fs, body.body(), if fs > 60000.0 { 1 } else { 2 });
        v.set_source(&SourcePatch::f0(default_f0(body)));
        v
    }

    pub fn info(&self) -> VoiceInfo {
        VoiceInfo { body: self.body, n_ph: self.voice.airway.n_ph, n_or: self.voice.airway.n_or }
    }

    pub fn voice(&self) -> &HumanVoice {
        &self.voice
    }

    pub fn voice_mut(&mut self) -> &mut HumanVoice {
        &mut self.voice
    }

    /// Switch the human body. The performer's settings carry over: source (pitch reset to the
    /// new body's default), posture, breath. Allocates (a new airway network).
    pub fn set_body(&mut self, body: impl Into<BodyMix>) -> VoiceInfo {
        let body: BodyMix = body.into();
        let body = BodyMix::new(body.female, body.child);
        let prev = core::mem::replace(&mut self.voice, Self::make_voice(self.sample_rate, body));
        self.body = body;
        let mut src = SourcePatch::from_source(&prev.source);
        src.f0 = Some(default_f0(body));
        self.voice.set_source(&src);
        let mut target = ArticPatch::default();
        for (k, x) in prev.artic.target.to_array().iter().enumerate() {
            target.values[k] = Some(*x);
        }
        self.voice.set_articulation(&target, Some(prev.artic.tip_free));
        // the performer's breath, not the voice's (which includes breath from the score)
        self.voice.set_gate(self.gate_level);
        self.info()
    }

    pub fn set_artic(&mut self, values: &ArticPatch, tip_free: Option<bool>) {
        self.voice.set_articulation(values, tip_free);
    }

    pub fn set_source(&mut self, values: &SourcePatch) {
        self.voice.set_source(values);
    }

    pub fn set_gate(&mut self, level: f64) {
        self.gate_level = level;
        self.voice.set_gate(level);
    }

    /// Schedule gestures planned with times relative to "now": they are shifted onto the voice
    /// clock by `clock + lead`. Returns that offset, or NaN when the entire transaction cannot fit.
    pub fn schedule(&mut self, gestures: &[Gesture], lead: f64, replace: bool) -> f64 {
        let off = self.voice.clock + lead;
        if !off.is_finite() || gestures.len() > self.schedule_room(replace) { return f64::NAN; }
        if replace {
            self.voice.cancel_score();
        }
        for batch in gestures.chunks(MAX_SCHEDULE) {
            self.scratch.clear();
            for g in batch {
                let mut g = *g;
                g.t0 += off;
                g.t1 += off;
                self.scratch.push(g);
            }
            self.voice.schedule(&self.scratch);
        }
        off
    }

    pub fn schedule_room(&self, replace: bool) -> usize {
        GestureScore::CAPACITY - if replace { 0 } else { self.voice.score.size() }
    }

    pub fn stop_speech(&mut self) {
        self.voice.cancel_score();
    }

    /// End the open-ended gestures with this tag now (a sung note released).
    pub fn release(&mut self, tag: f64) {
        self.voice.release(tag);
    }

    pub fn score(&self) -> &GestureScore {
        &self.voice.score
    }

    /// The voice clock (s): the time base of scheduled gestures.
    pub fn clock(&self) -> f64 {
        self.voice.clock
    }

    /// Render `out.len()` samples.
    pub fn render(&mut self, out: &mut [f32]) {
        self.voice.render(out);
    }

    pub fn telemetry(&mut self, out: &mut VoiceTelemetry) {
        self.voice.telemetry(out);
    }
}
