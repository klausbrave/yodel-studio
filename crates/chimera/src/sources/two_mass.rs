//! Experimental symmetric, triangular two-mass vocal-fold mechanics.
//!
//! Spring/contact mechanics follow Birkholz, Kröger & Neuschaefer-Rube (2011),
//! equations 1–4 and Table 1. Units are grams, centimetres and seconds.
//! Quasi-steady pressure is inferred from the two areas and the airway's actual
//! transglottal pressure. The airway solves the resulting flow through the
//! effective minimum area. This reduced load approximation needs calibration.

use crate::math::{TAU, clamp, exp, js_max, js_min, pow, smoothstep, sqrt};

#[derive(Clone, Debug)]
pub struct TwoMassGlottis {
    x: [f64; 2],
    velocity: [f64; 2],
    q: f64,
    stiffness_correction: f64,
    sample_rate: f64,
    control_smoothing: f64,
    measurement_smoothing: f64,
    rest: f64,
    time: f64,
    last_peak: f64,
    pressure_mean: f64,
    filtered_velocity: [f64; 2],
    mean_area: f64,
    area_variance: f64,
    pub f0: f64,
    pub voicing: f64,
    pub phase: f64,
}

impl Default for TwoMassGlottis {
    fn default() -> Self {
        Self {
            x: [0.0; 2],
            velocity: [0.0; 2],
            q: 1.0,
            stiffness_correction: 1.0,
            sample_rate: 0.0,
            control_smoothing: 0.0,
            measurement_smoothing: 0.0,
            rest: 0.02,
            time: 0.0,
            last_peak: -1.0,
            pressure_mean: 0.0,
            filtered_velocity: [0.0; 2],
            mean_area: 0.0,
            area_variance: 0.0,
            f0: 136.0,
            voicing: 0.0,
            phase: 0.0,
        }
    }
}

/// Area, fraction in contact, and mean resting displacement in the contact zone.
fn geometry(displacement: f64, rest: f64, length: f64) -> (f64, f64, f64) {
    if rest <= 0.0 {
        return (
            js_max(0.0, 2.0 * length * (rest + displacement)),
            if displacement + rest < 0.0 { 1.0 } else { 0.0 },
            rest,
        );
    }
    let contact = clamp(-displacement / rest, 0.0, 1.0);
    let opening = js_max(0.0, displacement + rest);
    let area = if displacement >= 0.0 {
        2.0 * length * (displacement + rest / 2.0)
    } else {
        length * opening * opening / rest
    };
    (area, contact, rest * contact / 2.0)
}

impl TwoMassGlottis {
    pub fn next(
        &mut self,
        fs: f64,
        pressure: f64,
        target_f0: f64,
        abduction: f64,
        closure: f64,
        vibrate: bool,
    ) -> f64 {
        let dt = 1.0 / fs;
        if self.sample_rate != fs {
            self.sample_rate = fs;
            self.control_smoothing = 1.0 - exp(-dt / 0.01);
            self.measurement_smoothing = 1.0 - exp(-dt / 0.02);
        }
        let smoothing = self.control_smoothing;
        self.pressure_mean += smoothing * (pressure - self.pressure_mean);
        if self.pressure_mean < 500.0 {
            self.stiffness_correction += smoothing * (1.0 - self.stiffness_correction);
        }
        // This feed-forward stiffness scale is a prototype calibration around
        // the nominal 136 Hz oscillation. Reported f0 below is measured motion.
        self.q +=
            smoothing * (clamp(target_f0 / 136.0 * self.stiffness_correction, 0.2, 8.0) - self.q);
        let root_q = sqrt(self.q);
        let length = 1.3 * root_q;
        let rest_target = 0.02 + js_max(0.0, abduction) / (2.0 * length) - 0.08 * closure;
        self.rest += smoothing * (rest_target - self.rest);
        let m1 = 0.125 / self.q;
        let m2 = 0.025 / self.q;
        let k1 = 80000.0 * self.q;
        let k2 = 8000.0 * self.q;
        let coupling = 25000.0 * self.q * self.q;
        let (a1, contact1, rest1) = geometry(self.x[0], self.rest, length);
        let (a2, contact2, rest2) = geometry(self.x[1], self.rest, length);
        let area = js_min(a1, a2);
        let pressure = js_max(0.0, pressure);
        let ratio = if a1 > 1e-9 { area / a1 } else { 1.0 };
        let lower_pressure = pressure * (1.0 - ratio * ratio);
        let force1 = lower_pressure * (0.25 / root_q) * length * (1.0 - contact1)
            + 0.25 * (pressure + lower_pressure) * 0.4 * length;
        let silent_damping = if vibrate { 0.0 } else { 2.0 };
        let damping1 = 2.0 * (0.1 + contact1 + silent_damping) * sqrt(k1 * m1);
        let damping2 = 2.0 * (0.6 + contact2 + silent_damping) * sqrt(k2 * m2);
        // Implicit integration of the coupled spring/damper system remains
        // stable under contact stiffness and abrupt acoustic-pressure loads.
        let contact_k1 = 240000.0 * self.q * contact1;
        let contact_k2 = 24000.0 * self.q * contact2;
        // Strain hardening bounds large displacements at low pitch/high pressure.
        // The cubic coefficient is an engineering default pending tissue calibration.
        let nonlinear1 = 100.0 * self.x[0] * self.x[0];
        let nonlinear2 = 100.0 * self.x[1] * self.x[1];
        let a11 =
            m1 + dt * damping1 + dt * dt * (k1 * (1.0 + 3.0 * nonlinear1) + coupling + contact_k1);
        let a22 =
            m2 + dt * damping2 + dt * dt * (k2 * (1.0 + 3.0 * nonlinear2) + coupling + contact_k2);
        let a12 = -dt * dt * coupling;
        let b1 = m1 * self.velocity[0]
            + dt * (force1
                - k1 * self.x[0] * (1.0 + nonlinear1)
                - contact_k1 * (self.x[0] + rest1)
                - coupling * (self.x[0] - self.x[1]));
        let b2 = m2 * self.velocity[1]
            + dt * (-k2 * self.x[1] * (1.0 + nonlinear2)
                - contact_k2 * (self.x[1] + rest2)
                - coupling * (self.x[1] - self.x[0]));
        let determinant = a11 * a22 - a12 * a12;
        self.velocity[0] = (b1 * a22 - b2 * a12) / determinant;
        self.velocity[1] = (b2 * a11 - b1 * a12) / determinant;
        self.x[0] += dt * self.velocity[0];
        self.x[1] += dt * self.velocity[1];
        debug_assert!(
            self.x.iter().all(|x| x.is_finite()),
            "two-mass state q={} pressure={} x={:?}",
            self.q,
            pressure,
            self.x
        );
        self.time += dt;
        // Tissue-mode peaks can contain short acoustic ripples during a stop
        // release. Track the low-frequency motion through a two-pole smoother.
        let omega_dt = TAU * js_max(20.0, target_f0) * 2.0 * dt;
        let filter = omega_dt / (1.0 + omega_dt);
        let old_velocity = self.filtered_velocity[1];
        self.filtered_velocity[0] += filter * (self.velocity[0] - self.filtered_velocity[0]);
        self.filtered_velocity[1] +=
            filter * (self.filtered_velocity[0] - self.filtered_velocity[1]);
        if old_velocity > 0.0 && self.filtered_velocity[1] <= 0.0 {
            let period = self.time - self.last_peak;
            if (0.0005..0.05).contains(&period) {
                self.f0 += 0.25 * (1.0 / period - self.f0);
                if self.area_variance > 1e-4 && self.pressure_mean > 1500.0 && vibrate {
                    // A slow pitch controller recruits stiffness from measured
                    // tissue cycles, including changes from acoustic loading.
                    self.stiffness_correction = clamp(
                        self.stiffness_correction * pow(clamp(target_f0 / self.f0, 0.5, 2.0), 0.06),
                        0.25,
                        2.0,
                    );
                }
            }
            self.last_peak = self.time;
            self.phase = 0.0;
        } else {
            self.phase = js_min(0.999, self.phase + dt * self.f0);
        }
        let measure = self.measurement_smoothing;
        self.mean_area += measure * (area - self.mean_area);
        self.area_variance +=
            measure * ((area - self.mean_area) * (area - self.mean_area) - self.area_variance);
        self.voicing = if vibrate && self.time - self.last_peak < 0.04 {
            smoothstep(1e-6, 1e-4, self.area_variance)
        } else {
            0.0
        };
        area
    }
}
