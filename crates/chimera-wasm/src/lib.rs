//! C-ABI bindings of the CHIMERA engine for the browser. No wasm-bindgen and no imports: the
//! AudioWorkletGlobalScope has no TextEncoder/TextDecoder or fetch, so everything crosses as
//! numbers and pointers into this module's linear memory.
//!
//! Ownership: every object is a handle (`*mut T` from `Box::into_raw`) freed by its `*_free`.
//! Buffers an object owns (output, gesture scratch, telemetry arrays) keep their address for the
//! object's lifetime; JavaScript must still re-create its typed-array views whenever
//! `memory.buffer` changes (memory growth detaches them), and copy telemetry before the next call.
//!
//! # Gesture records (layout version 2, [`GESTURE_RECORD`] = 280 bytes, little-endian)
//! | offset | type        | field |
//! |-------:|-------------|-------|
//! | 0      | f64         | t0 |
//! | 8      | f64         | t1 |
//! | 16     | f64         | rampIn |
//! | 24     | f64         | rampOut |
//! | 32     | f64         | strength |
//! | 40     | f64         | speed (NaN: absent) |
//! | 48     | f64         | releaseHold (NaN: absent) |
//! | 56     | f64         | tag (NaN: absent) |
//! | 64     | 23 × f64    | targets in ControlKey order: the 17 articulators, then abduction, closure, breath, f0, vibrato, posteriorGap (NaN: absent) |
//! | 248    | u8          | label length in bytes (255: no label) |
//! | 249    | 24 × u8     | label, UTF-8, cut at a character boundary |
//! | 273    | 7 × u8      | padding |
pub mod api;

use chimera::anatomy::human::{ArticPatch, BodyMix, N_ARTIC};
use chimera::control::score::{Gesture, Label, N_CONTROL, Targets};
use chimera::engine::{Engine, MAX_SCHEDULE};
use chimera::voice::human_voice::{SourcePatch, VoiceTelemetry};

const LABEL_OFFSET: usize = 64 + N_CONTROL * 8;
pub const GESTURE_RECORD: usize = LABEL_OFFSET + 32;
pub const LAYOUT_VERSION: u32 = 2;
/// Largest `engine_render` request (frames).
pub const MAX_RENDER: usize = 4096;

#[unsafe(no_mangle)]
pub extern "C" fn chimera_layout_version() -> u32 {
    LAYOUT_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn chimera_gesture_record_size() -> u32 {
    GESTURE_RECORD as u32
}

// ------------------------------------------------------------------ memory for JS-owned buffers

/// Allocate `n` bytes (8-aligned) for JavaScript; free with `chimera_free(ptr, n)`.
#[unsafe(no_mangle)]
pub extern "C" fn chimera_alloc(n: usize) -> *mut u8 {
    let v: Vec<u64> = vec![0; n.div_ceil(8).max(1)];
    Box::into_raw(v.into_boxed_slice()) as *mut u8
}

/// # Safety
/// `p` and `n` must come from one `chimera_alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn chimera_free(p: *mut u8, n: usize) {
    if p.is_null() {
        return;
    }
    let words = n.div_ceil(8).max(1);
    drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(p as *mut u64, words)) });
}

// ------------------------------------------------------------------ gesture records

fn opt(x: f64) -> Option<f64> {
    if x.is_nan() { None } else { Some(x) }
}

/// Decode one record (see the module docs).
pub fn read_gesture(b: &[u8]) -> Gesture {
    let f = |i: usize| f64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
    let mut targets = Targets::default();
    for k in 0..N_CONTROL {
        targets.0[k] = f(8 + k);
    }
    let len = b[LABEL_OFFSET];
    let label = if len == 255 { None } else { Some(Label::from_bytes(&b[LABEL_OFFSET + 1..LABEL_OFFSET + 1 + (len as usize).min(Label::CAP)])) };
    Gesture { t0: f(0), t1: f(1), ramp_in: f(2), ramp_out: f(3), strength: f(4), speed: opt(f(5)), release_hold: opt(f(6)), tag: opt(f(7)), targets, label }
}

/// Encode one record (the inverse of [`read_gesture`]).
pub fn write_gesture(g: &Gesture, b: &mut [u8]) {
    let mut put = |i: usize, x: f64| b[i * 8..i * 8 + 8].copy_from_slice(&x.to_le_bytes());
    for (i, x) in [g.t0, g.t1, g.ramp_in, g.ramp_out, g.strength, g.speed.unwrap_or(f64::NAN), g.release_hold.unwrap_or(f64::NAN), g.tag.unwrap_or(f64::NAN)].into_iter().enumerate() {
        put(i, x);
    }
    for k in 0..N_CONTROL {
        put(8 + k, g.targets.0[k]);
    }
    match &g.label {
        None => b[LABEL_OFFSET] = 255,
        Some(l) => {
            let bytes = l.as_bytes();
            b[LABEL_OFFSET] = bytes.len() as u8;
            b[LABEL_OFFSET + 1..LABEL_OFFSET + 1 + bytes.len()].copy_from_slice(bytes);
        }
    }
}

// ------------------------------------------------------------------ the engine (audio thread)

/// An engine and the buffers JavaScript reads and writes.
pub struct Handle {
    engine: Engine,
    out: Vec<f32>,
    /// MAX_SCHEDULE gesture records written by JS before `engine_schedule`
    records: Vec<u8>,
    gestures: Vec<Gesture>,
    /// N_ARTIC values (NaN: absent) for `engine_set_artic`; also source values for `engine_set_source`
    values: Vec<f64>,
    tele: VoiceTelemetry,
    /// the flat telemetry block (see `engine_telemetry`)
    tele_block: Vec<f64>,
    /// active gesture labels: up to 4 × (length byte + 24 bytes)
    tele_labels: Vec<u8>,
    respiratory_block: [f64; 12],
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_new(sample_rate: f64) -> *mut Handle {
    let mut h = Box::new(Handle {
        engine: Engine::new(sample_rate),
        out: vec![0.0; MAX_RENDER],
        records: vec![0u8; MAX_SCHEDULE * GESTURE_RECORD],
        gestures: Vec::with_capacity(MAX_SCHEDULE),
        values: vec![f64::NAN; 32],
        tele: VoiceTelemetry::default(),
        tele_block: Vec::with_capacity(TELE_HEADER + 1024),
        tele_labels: vec![0u8; 4 * 25],
        respiratory_block: [0.0; 12],
    });
    // size every telemetry buffer once, so later snapshots reuse them
    h.engine.telemetry(&mut h.tele);
    Box::into_raw(h)
}

/// # Safety
/// `h` must come from `engine_new` and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_free(h: *mut Handle) {
    if !h.is_null() {
        drop(unsafe { Box::from_raw(h) });
    }
}

macro_rules! handle {
    ($h:expr) => {
        unsafe { &mut *$h }
    };
}

/// Render `n` (≤ MAX_RENDER) frames; returns the output buffer's address.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_render(h: *mut Handle, n: usize) -> *const f32 {
    let h = handle!(h);
    let n = n.min(MAX_RENDER);
    h.engine.render(&mut h.out[..n]);
    h.out.as_ptr()
}

/// The record area JavaScript fills before `engine_schedule` (MAX_SCHEDULE records).
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_records(h: *mut Handle) -> *mut u8 {
    handle!(h).records.as_mut_ptr()
}

/// Physical record buffer size. One synchronous schedule transaction can use several buffers.
#[unsafe(no_mangle)]
pub extern "C" fn chimera_schedule_batch_size() -> usize {
    MAX_SCHEDULE
}

/// Free score slots for an entire replace or append transaction.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_schedule_room(h: *mut Handle, replace: u32) -> usize {
    handle!(h).engine.schedule_room(replace != 0)
}

/// Schedule `count` records from the record area, times relative to now + `lead`. Returns the
/// offset added (the plan's time 0 on the voice clock).
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_schedule(h: *mut Handle, count: usize, lead: f64, replace: u32) -> f64 {
    let h = handle!(h);
    if count > MAX_SCHEDULE {
        return f64::NAN;
    }
    h.gestures.clear();
    for i in 0..count {
        h.gestures.push(read_gesture(&h.records[i * GESTURE_RECORD..(i + 1) * GESTURE_RECORD]));
    }
    h.engine.schedule(&h.gestures, lead, replace != 0)
}

/// A scratch array of 32 f64 for value-carrying calls (artic patches, source patches).
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_values(h: *mut Handle) -> *mut f64 {
    handle!(h).values.as_mut_ptr()
}

/// Apply the articulation in the value area (N_ARTIC values in ArticKey order, NaN: unchanged).
/// `tip_free`: 0 false, 1 true, anything else unchanged.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_set_artic(h: *mut Handle, tip_free: u32) {
    let h = handle!(h);
    let mut p = ArticPatch::default();
    for k in 0..N_ARTIC {
        p.values[k] = opt(h.values[k]);
    }
    let tf = match tip_free {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    h.engine.set_artic(&p, tf);
}

/// Source values in the value area, in this order (NaN: unchanged): f0, glide, pressure,
/// breathiness, tension, fry, roughness, vibratoDepth, vibratoRate, drift, voiced (0/1), brightness,
/// respiration (0/1), posteriorGap, selfOscillating (0/1).
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_set_source(h: *mut Handle) {
    let h = handle!(h);
    let v = &h.values;
    let p = SourcePatch {
        f0: opt(v[0]),
        glide: opt(v[1]),
        pressure: opt(v[2]),
        breathiness: opt(v[3]),
        tension: opt(v[4]),
        fry: opt(v[5]),
        roughness: opt(v[6]),
        vibrato_depth: opt(v[7]),
        vibrato_rate: opt(v[8]),
        drift: opt(v[9]),
        voiced: opt(v[10]).map(|x| x != 0.0),
        brightness: opt(v[11]),
        respiration: opt(v[12]).map(|x| x != 0.0),
        posterior_gap: opt(v[13]),
        self_oscillating: opt(v[14]).map(|x| x != 0.0),
    };
    h.engine.set_source(&p);
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_set_gate(h: *mut Handle, level: f64) {
    handle!(h).engine.set_gate(level);
}

/// Switch body: `female` 0 (male) … 1 (female), `child` 0 (adult) … 1 (child); see `BodyMix`.
/// Allocates. The new voice's node counts can be read with `engine_n_ph`/`engine_n_or`.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_set_body(h: *mut Handle, female: f64, child: f64) {
    let h = handle!(h);
    h.engine.set_body(BodyMix::new(female, child));
    h.engine.telemetry(&mut h.tele); // resize the telemetry buffers for the new voice
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_stop_speech(h: *mut Handle) {
    handle!(h).engine.stop_speech();
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_release(h: *mut Handle, tag: f64) {
    handle!(h).engine.release(tag);
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_clock(h: *mut Handle) -> f64 {
    handle!(h).engine.clock()
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_n_ph(h: *mut Handle) -> u32 {
    handle!(h).engine.info().n_ph as u32
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_n_or(h: *mut Handle) -> u32 {
    handle!(h).engine.info().n_or as u32
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_body_female(h: *mut Handle) -> f64 {
    handle!(h).engine.info().body.female
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_body_child(h: *mut Handle) -> f64 {
    handle!(h).engine.info().body.child
}

/// Evaluate one of the engine's math functions (diagnostics: native and wasm must agree bit for
/// bit). 0 sin 1 cos 2 tan 3 exp 4 ln 5 log10 6 log2 7 pow 8 tanh 9 atan2 10 acos 11 cbrt 12 hypot 13 sqrt.
#[unsafe(no_mangle)]
pub extern "C" fn chimera_probe(f: u32, x: f64, y: f64) -> f64 {
    use chimera::math as m;
    match f {
        0 => m::sin(x),
        1 => m::cos(x),
        2 => m::tan(x),
        3 => m::exp(x),
        4 => m::ln(x),
        5 => m::log10(x),
        6 => m::log2(x),
        7 => m::pow(x, y),
        8 => m::tanh(x),
        9 => m::atan2(x, y),
        10 => m::acos(x),
        11 => m::cbrt(x),
        12 => m::hypot(x, y),
        13 => m::sqrt(x),
        _ => f64::NAN,
    }
}

/// Scalars at the head of the telemetry block, in order: phLen, orLen, velumPort, f0, voicing,
/// pLung, outRms, noiseLevel, noiseNode, gate, clock, then the array lengths nArtic, nPh, nOr,
/// nScope, nActive. The arrays follow: artic, phAreas, orAreas, pressureRms (nPh+nOr),
/// flow (nPh+nOr), glottalArea (nScope), glottalFlow (nScope).
pub const TELE_HEADER: usize = 16;

/// Take a human-voice telemetry snapshot (resets its interval measurements: RMS levels) into the
/// flat f64 block whose address it returns; active gesture labels go to `engine_tele_labels`.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_telemetry(h: *mut Handle) -> *const f64 {
    let h = handle!(h);
    h.engine.telemetry(&mut h.tele);
    let t = &h.tele;
    let b = &mut h.tele_block;
    b.clear();
    let n_ph = t.ph_areas.len();
    let n_or = t.or_areas.len();
    b.extend_from_slice(&[t.ph_len, t.or_len, t.velum_port, t.f0, t.voicing, t.p_lung, t.out_rms, t.noise_level, t.noise_node as f64, t.gate, t.clock]);
    b.extend_from_slice(&[t.artic.len() as f64, n_ph as f64, n_or as f64, t.glottal_area.len() as f64, t.active.len() as f64]);
    debug_assert_eq!(b.len(), TELE_HEADER);
    for arr in [&t.artic, &t.ph_areas, &t.or_areas, &t.pressure_rms, &t.flow, &t.glottal_area, &t.glottal_flow] {
        b.extend(arr.iter().map(|x| *x as f64));
    }
    for (i, l) in t.active.iter().enumerate() {
        let bytes = l.as_bytes();
        h.tele_labels[i * 25] = bytes.len() as u8;
        h.tele_labels[i * 25 + 1..i * 25 + 1 + bytes.len()].copy_from_slice(bytes);
    }
    b.as_ptr()
}

/// The active-label area of the last telemetry snapshot: up to 4 × (length byte, 24 bytes).
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_tele_labels(h: *mut Handle) -> *const u8 {
    handle!(h).tele_labels.as_ptr()
}

/// Respiratory state from the last human telemetry snapshot. Existing telemetry stays compatible.
/// Fields: enabled, volume, capacity, diaphragm, abdomen, ribCage, recoil, flow, pressure,
/// phase, noseFlow, mouthFlow. Volume is L, flow is L/s, pressure is cmH2O.
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_respiration(h: *mut Handle) -> *const f64 {
    let h = handle!(h);
    let s = h.tele.respiration;
    h.respiratory_block = [s.enabled as u8 as f64, s.volume, s.capacity, s.diaphragm,
        s.abdomen, s.rib_cage, s.recoil, s.flow, s.pressure, s.phase as f64, s.nose_flow, s.mouth_flow];
    h.respiratory_block.as_ptr()
}

/// The human voice's gesture score as JSON in the result buffer (diagnostics and tests; allocates).
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_score_json(h: *mut Handle) -> u32 {
    let h = handle!(h);
    api::set_result(serde_json::to_value(h.engine.score().gestures()).map_err(|e| e.to_string()))
}
