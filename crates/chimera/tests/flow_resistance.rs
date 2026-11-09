//! Frequency-dependent port termination: respiratory DC flow and acoustic damping.
use chimera::airway::frequency::transfer_function;
use chimera::airway::network::{AirwayNetwork, PortSpec};
use chimera::math::{PI, cos, sin, sqrt};

const ACOUSTIC_RESISTANCE: f64 = 8.5;
const STEADY_RESISTANCE: f64 = 0.5;
const CUTOFF: f64 = 10.0;

fn fixed_port(fs: f64) -> (AirwayNetwork, usize, usize) {
    let mut network = AirwayNetwork::new(fs);
    let upstream = network.add_pressure_node("upstream");
    let downstream = network.add_pressure_node("downstream");
    let port = network.add_port(upstream, downstream,
        PortSpec::new(2.0, 0.2).kinetic(0.0, 0.0).no_half_sections().resistance(ACOUSTIC_RESISTANCE));
    network.viscous_scale = 0.0;
    network.finalize();
    network.begin_block(1);
    (network, upstream, port)
}

fn settle(network: &mut AirwayNetwork, upstream: usize, pressure: f64, seconds: f64) {
    for _ in 0..(seconds * network.fs) as usize {
        network.set_fixed_pressure(upstream, pressure);
        assert!(network.step().is_finite());
        assert!(network.u.iter().all(|flow| flow.is_finite()));
    }
}

#[test]
fn steady_flow_uses_the_requested_resistance_in_both_directions() {
    for pressure in [-100.0, 100.0] {
        let (mut original, upstream, port) = fixed_port(48000.0);
        let mut respiratory = original.clone();
        respiratory.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF);
        settle(&mut original, upstream, pressure, 3.0);
        settle(&mut respiratory, upstream, pressure, 3.0);
        let expected = pressure / STEADY_RESISTANCE;
        println!("pressure {pressure}: original flow {:.4}, respiratory flow {:.4} cm3/s", original.u[port], respiratory.u[port]);
        assert!((respiratory.u[port] - expected).abs() < expected.abs() * 0.001);
        assert!((original.u[port] - pressure / ACOUSTIC_RESISTANCE).abs() < 1e-9);
    }
}

#[test]
fn sinusoidal_flow_matches_the_passive_relaxation_impedance() {
    for fs in [48000.0, 96000.0] {
        for frequency in [1.0, 10.0, 100.0, 1000.0] {
            let (mut network, upstream, port) = fixed_port(fs);
            network.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF);
            let elements = network.linear_elements();
            settle(&mut network, upstream, 0.0, 1.0);
            let mut in_phase = 0.0;
            let mut quadrature = 0.0;
            let omega = 2.0 * PI * frequency;
            for sample in 0..(4.0 * fs) as usize {
                let phase = omega * sample as f64 / fs;
                network.set_fixed_pressure(upstream, sin(phase));
                network.step();
                if sample >= (3.0 * fs) as usize {
                    in_phase += network.u[port] * sin(phase);
                    quadrature += network.u[port] * cos(phase);
                }
            }
            let gain = 2.0 * sqrt(in_phase * in_phase + quadrature * quadrature) / fs;
            let ratio = frequency / CUTOFF;
            let reduction = ACOUSTIC_RESISTANCE - STEADY_RESISTANCE;
            let real = ACOUSTIC_RESISTANCE - reduction / (1.0 + ratio * ratio);
            let imaginary = omega * elements.l[port] + reduction * ratio / (1.0 + ratio * ratio);
            let expected = 1.0 / sqrt(real * real + imaginary * imaginary);
            assert!((gain / expected - 1.0).abs() < 0.012, "{fs} Hz at {frequency} Hz: gain {gain}, expected {expected}");
            if frequency >= 100.0 {
                let original = 1.0 / sqrt(ACOUSTIC_RESISTANCE.powi(2) + (omega * elements.l[port]).powi(2));
                assert!((gain / original - 1.0).abs() < 0.015, "acoustic damping changed at {frequency} Hz");
            }
        }
    }
}

#[test]
fn toggles_are_smooth_and_the_disabled_path_is_sample_exact() {
    let (mut original, upstream, port) = fixed_port(48000.0);
    let mut respiratory = original.clone();
    respiratory.set_port_flow_resistance(port, None, CUTOFF);
    for sample in 0..1000 {
        let pressure = 100.0 * sin(sample as f64 * 0.01);
        original.set_fixed_pressure(upstream, pressure);
        respiratory.set_fixed_pressure(upstream, pressure);
        assert_eq!(original.step(), respiratory.step());
        assert_eq!(original.u, respiratory.u);
        assert_eq!(original.p, respiratory.p);
    }
    settle(&mut respiratory, upstream, 100.0, 0.1);
    let before = respiratory.u[port];
    respiratory.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF);
    respiratory.step();
    assert!((respiratory.u[port] / before - 1.0).abs() < 0.001);
    settle(&mut respiratory, upstream, 100.0, 3.0);
    let before = respiratory.u[port];
    respiratory.set_port_flow_resistance(port, None, CUTOFF);
    respiratory.step();
    assert!((respiratory.u[port] / before - 1.0).abs() < 0.01);
    settle(&mut respiratory, upstream, 100.0, 1.0);
    assert!((respiratory.u[port] - 100.0 / ACOUSTIC_RESISTANCE).abs() < 1e-8);
    original.reset();
    respiratory.reset();
    for sample in 0..1000 {
        let pressure = 50.0 + 10.0 * sin(sample as f64 * 0.01);
        original.set_fixed_pressure(upstream, pressure);
        respiratory.set_fixed_pressure(upstream, pressure);
        original.step();
        respiratory.step();
        assert_eq!(original.u, respiratory.u);
    }
}

#[test]
fn control_block_boundaries_do_not_change_the_relaxation_state() {
    let (mut a, upstream, port) = fixed_port(48000.0);
    let mut b = a.clone();
    a.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF);
    b.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF);
    for sample in 0..48000 {
        if sample == 8000 || sample == 8200 {
            let area = if sample == 8000 { 0.0 } else { 2.0 };
            a.set_port_area(port, area);
            b.set_port_area(port, area);
        }
        if sample % 71 == 0 { a.begin_block(71); }
        if sample % 128 == 0 { b.begin_block(128); }
        let pressure = 50.0 + 10.0 * sin(sample as f64 * 0.01);
        a.set_fixed_pressure(upstream, pressure);
        b.set_fixed_pressure(upstream, pressure);
        a.step();
        b.step();
        assert_eq!(a.u, b.u);
        assert_eq!(a.p, b.p);
    }
}

#[test]
fn a_closed_port_dissipates_its_internal_relaxation_flow() {
    let (mut network, upstream, port) = fixed_port(48000.0);
    network.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF);
    settle(&mut network, upstream, 100.0, 3.0);
    assert!(network.u[port] > 190.0);
    network.set_port_area(port, 0.0);
    settle(&mut network, upstream, 0.0, 1.0);
    assert_eq!(network.u[port], 0.0);
    network.set_port_area(port, 2.0);
    for _ in 0..1000 {
        network.step();
        assert!(network.u[port].abs() < 1e-8, "stale internal flow on reopening");
    }
}

#[test]
fn stationary_relaxation_does_not_generate_net_energy() {
    let (mut network, upstream, port) = fixed_port(48000.0);
    network.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF);
    settle(&mut network, upstream, 0.0, 1.0);
    let mut work = 0.0;
    // The low-frequency flow pole is omega_c * Rdc/Rac, so allow several
    // of its time constants for stored inductive energy to dissipate.
    for sample in 0..192000 {
        let time = sample as f64 / network.fs;
        let pressure = if time < 1.0 { 100.0 * sin(2.0 * PI * 7.0 * time) + 30.0 * sin(2.0 * PI * 313.0 * time) } else { 0.0 };
        network.set_fixed_pressure(upstream, pressure);
        network.step();
        work += pressure * network.u[port] / network.fs;
        assert!(work >= -1e-9, "passive load generated cumulative energy {work}");
    }
    println!("passive relaxation work {work:.6}, residual flow {:.8}", network.u[port]);
    assert!(network.u[port].abs() < 0.05);
}

#[test]
fn frequency_domain_analysis_includes_the_relaxation_load() {
    for enabled in [false, true] {
        let fs = 48000.0;
        let mut network = AirwayNetwork::new(fs);
        let boundary = network.add_pressure_node("lung");
        let cavity = network.add_cavity("cavity", 10.0, None);
        let port = network.add_port(boundary, cavity,
            PortSpec::new(2.0, 0.2).kinetic(0.0, 0.0).no_half_sections().resistance(ACOUSTIC_RESISTANCE));
        let radiation = network.add_radiation(cavity);
        network.viscous_scale = 0.0;
        network.finalize();
        if enabled { network.set_port_flow_resistance(port, Some(STEADY_RESISTANCE), CUTOFF); }
        let elements = network.linear_elements();
        for frequency in [5.0, 20.0, 200.0] {
            network.reset();
            network.begin_block(1);
            settle(&mut network, boundary, 0.0, 1.0);
            let expected = transfer_function(&elements, cavity, &[frequency], &[]).mag[0];
            let mut in_phase = 0.0;
            let mut quadrature = 0.0;
            for sample in 0..(3.0 * fs) as usize {
                let phase = 2.0 * PI * frequency * sample as f64 / fs;
                network.ext_flow[cavity] = sin(phase);
                network.step();
                if sample >= (2.0 * fs) as usize {
                    in_phase += network.rad_u[radiation] * sin(phase);
                    quadrature += network.rad_u[radiation] * cos(phase);
                }
            }
            let actual = 2.0 * sqrt(in_phase * in_phase + quadrature * quadrature) / fs;
            assert!((actual / expected - 1.0).abs() < 0.005, "enabled={enabled} {frequency} Hz: actual={actual} expected={expected}");
        }
    }
}

#[test]
fn several_ports_can_be_enabled_and_faded_independently() {
    let mut network = AirwayNetwork::new(48000.0);
    let inlet = network.add_pressure_node("inlet");
    let outlet = network.add_pressure_node("outlet");
    let spec = PortSpec::new(2.0, 0.2).kinetic(0.0, 0.0).no_half_sections().resistance(ACOUSTIC_RESISTANCE);
    let first = network.add_port(inlet, outlet, spec.clone());
    let second = network.add_port(inlet, outlet, spec);
    network.viscous_scale = 0.0;
    network.finalize();
    network.begin_block(1);

    network.set_port_flow_resistance(first, Some(STEADY_RESISTANCE), CUTOFF);
    // Toggling before a sample runs must not enroll the same port twice.
    network.set_port_flow_resistance(first, None, CUTOFF);
    network.set_port_flow_resistance(first, Some(STEADY_RESISTANCE), CUTOFF);
    network.set_port_flow_resistance(second, Some(2.0), CUTOFF);
    settle(&mut network, inlet, 100.0, 3.0);
    assert!((network.u[first] - 200.0).abs() < 0.2);
    assert!((network.u[second] - 50.0).abs() < 0.05);

    network.set_port_flow_resistance(first, None, CUTOFF);
    settle(&mut network, inlet, 100.0, 1.0);
    assert!((network.u[first] - 100.0 / ACOUSTIC_RESISTANCE).abs() < 1e-8);
    assert!((network.u[second] - 50.0).abs() < 0.05);

    network.set_port_flow_resistance(first, Some(STEADY_RESISTANCE), CUTOFF);
    network.set_port_flow_resistance(second, None, CUTOFF);
    settle(&mut network, inlet, 100.0, 3.0);
    assert!((network.u[first] - 200.0).abs() < 0.2);
    assert!((network.u[second] - 100.0 / ACOUSTIC_RESISTANCE).abs() < 1e-8);
}
