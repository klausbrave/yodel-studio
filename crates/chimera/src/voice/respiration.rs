//! Lumped respiratory mechanics coupled to the airway's signed volume flow.
//!
//! Lung/chest recoil and opposing inspiratory/expiratory muscle pressures generate
//! alveolar pressure. The airway determines flow, which changes the remaining lung
//! volume. Effective compartments approximate coordinated muscle activity.
//! The default pressure-volume curve is an engineering approximation. Its direction
//! and active braking follow Sundberg (1993) and Salomoni et al. (2016).

use crate::math::{clamp, exp, smoothstep};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RespiratoryTelemetry {
    pub enabled: bool,
    /// Usable volume above the residual volume, litres.
    pub volume: f64,
    pub capacity: f64,
    /// Normalized effective muscle activation.
    pub diaphragm: f64,
    pub abdomen: f64,
    /// Normalized volume displacement of the chest compartment.
    pub rib_cage: f64,
    /// Passive respiratory recoil, cmH2O.
    pub recoil: f64,
    /// Mean signed flow out of the lungs, litres per second.
    pub flow: f64,
    /// Alveolar pressure, cmH2O.
    pub pressure: f64,
    /// 0 resting, 1 inhaling, 2 phonatory expiration.
    pub phase: u8,
    pub nose_flow: f64,
    pub mouth_flow: f64,
}

#[derive(Clone, Debug)]
pub struct Respiration {
    pub state: RespiratoryTelemetry,
    rest_time: f64,
    inhaling: bool,
    flow_sum: f64,
    flow_time: f64,
}

impl Respiration {
    pub fn new(body_scale: f64) -> Self {
        let capacity = 4.5 * body_scale * body_scale * body_scale;
        let recoil = 12.0 * 0.33 + 8.0 * 0.33 * 0.33 * 0.33;
        Self {
            state: RespiratoryTelemetry { capacity, volume: capacity * 0.68, rib_cage: 0.68, diaphragm: recoil / 16.0, recoil, ..Default::default() },
            rest_time: 0.0,
            inhaling: false,
            flow_sum: 0.0,
            flow_time: 0.0,
        }
    }

    /// Accumulate the actual network flow after each acoustic step. CGS cm³/s → L/s.
    pub fn advance_flow(&mut self, flow: f64, dt: f64) {
        let litres = flow * 0.001 * dt;
        self.state.volume = clamp(self.state.volume - litres, 0.0, self.state.capacity);
        self.flow_sum += litres;
        self.flow_time += dt;
    }

    /// Generate pressure from finite air volume and bounded, smoothly recruited muscles.
    /// The requested pressure is the performer's control target.
    pub fn control(&mut self, dt: f64, requested: f64, gate: f64) -> f64 {
        let s = &mut self.state;
        let fraction = clamp(s.volume / s.capacity, 0.0, 1.0);
        s.rib_cage = fraction;
        let displacement = fraction - 0.35;
        s.recoil = 12.0 * displacement + 8.0 * displacement * displacement * displacement;
        if self.flow_time > 0.0 {
            s.flow = self.flow_sum / self.flow_time;
            self.flow_sum = 0.0;
            self.flow_time = 0.0;
        }

        if gate.abs() > 0.005 {
            self.rest_time = 0.0;
            self.inhaling = requested < 0.0 || gate < 0.0;
        } else {
            self.rest_time += dt;
            if fraction >= 0.72 {
                self.inhaling = false;
            } else if self.rest_time > 0.16 && fraction < 0.70 {
                self.inhaling = true;
            }
        }

        let target = if gate.abs() > 0.005 {
            let available = if self.inhaling { 1.0 - fraction } else { fraction };
            requested * smoothstep(0.0, 0.08, available)
        } else if self.inhaling {
            // A depleted phrase needs a brisk replenishing breath. The target
            // remains an alveolar pressure; muscle recruitment below also
            // accounts for the current passive recoil.
            let deficit = 0.72 - fraction;
            // A short, soft syllable needs only a quiet top-up. Recruit the
            // stronger inspiratory effort after a substantially depleted phrase.
            let recruitment = 9.0 * (1.0 + smoothstep(0.12, 0.30, deficit));
            -clamp(deficit * recruitment, 0.12, 4.0)
        } else {
            0.0
        };
        let muscle_pressure = target - s.recoil;
        let diaphragm_goal = clamp(-muscle_pressure / 16.0, 0.0, 1.0);
        let abdomen_goal = clamp(muscle_pressure / 20.0, 0.0, 1.0);
        s.diaphragm += (diaphragm_goal - s.diaphragm) * (1.0 - exp(-dt / 0.055));
        s.abdomen += (abdomen_goal - s.abdomen) * (1.0 - exp(-dt / 0.045));
        s.pressure = s.recoil + 20.0 * s.abdomen - 16.0 * s.diaphragm;
        s.phase = if self.inhaling { 1 } else if gate > 0.005 { 2 } else { 0 };
        s.pressure
    }

    pub fn inhaling(&self) -> bool {
        self.inhaling
    }
}
