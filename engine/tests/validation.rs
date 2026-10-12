//! Engine validation against analytic results.

use sb_engine::{ac, measure, op, tran, Circuit, DiodeModel, Error, Options, Sweep, TranSpec, Waveform};
use std::f64::consts::PI;

fn opts() -> Options {
    Options::default()
}

fn step(v: f64) -> Waveform {
    Waveform::Pulse { v1: 0.0, v2: v, delay: 0.0, rise: 1e-9, fall: 1e-9, width: 1.0, period: 0.0 }
}

#[test]
fn divider_operating_point_is_exact() {
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", Waveform::dc(10.0), 0.0)
        .resistor("R1", "in", "mid", 3e3)
        .resistor("R2", "mid", "0", 7e3);
    let r = op(&mut c, &opts()).unwrap();
    assert!((r.get("V(mid)").unwrap() - 7.0).abs() < 1e-9);
    assert!((r.get("I(V1)").unwrap() + 1e-3).abs() < 1e-12, "source current = −1 mA (flows out of +)");
    assert!((r.get("I(R1)").unwrap() - 1e-3).abs() < 1e-12);
}

#[test]
fn superposition_with_current_source() {
    // 1 mA into node a, 2 kΩ to ground, 5 V through 1 kΩ: V(a) = (5/1k + 1m)/(1/1k + 1/2k)
    let mut c = Circuit::new();
    c.vsource("V1", "s", "0", Waveform::dc(5.0), 0.0)
        .resistor("R1", "s", "a", 1e3)
        .resistor("R2", "a", "0", 2e3)
        .isource("I1", "0", "a", Waveform::dc(1e-3));
    let r = op(&mut c, &opts()).unwrap();
    let expect = (5.0 / 1e3 + 1e-3) / (1.0 / 1e3 + 1.0 / 2e3);
    assert!((r.get("V(a)").unwrap() - expect).abs() < 1e-9);
}

#[test]
fn inductor_is_short_at_dc() {
    let mut c = Circuit::new();
    c.vsource("V1", "a", "0", Waveform::dc(2.0), 0.0).inductor("L1", "a", "b", 1e-3).resistor("R1", "b", "0", 100.0);
    let r = op(&mut c, &opts()).unwrap();
    assert!((r.get("I(L1)").unwrap() - 0.02).abs() < 1e-12);
}

#[test]
fn rc_step_response_matches_exponential() {
    let (r, cap) = (1e3, 1e-6); // tau = 1 ms
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", step(1.0), 0.0).resistor("R1", "in", "out", r).capacitor("C1", "out", "0", cap);
    let res = tran(&mut c, TranSpec { stop: 5e-3, step: 1e-6 }, &opts()).unwrap();
    let v = res.signal("V(out)").unwrap();
    let mut worst: f64 = 0.0;
    for (i, &t) in res.time.iter().enumerate() {
        if t < 1e-5 { continue; }
        let exact = 1.0 - (-(t - 0.5e-9) / (r * cap)).exp();
        worst = worst.max((v[i] - exact).abs());
    }
    assert!(worst < 1e-3, "max error {worst} V (0.1 % of 1 V)");
}

#[test]
fn rlc_underdamped_matches_analytic() {
    let (r, l, cap) = (10.0, 1e-3, 1e-6);
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", step(1.0), 0.0).resistor("R1", "in", "a", r).inductor("L1", "a", "b", l).capacitor("C1", "b", "0", cap);
    let res = tran(&mut c, TranSpec { stop: 1e-3, step: 2e-7 }, &opts()).unwrap();
    let vc = res.signal("V(b)").unwrap();
    let alpha = r / (2.0 * l);
    let w0 = 1.0 / (l * cap).sqrt();
    let wd = (w0 * w0 - alpha * alpha).sqrt();
    let mut worst: f64 = 0.0;
    for (i, &t) in res.time.iter().enumerate() {
        let exact = 1.0 - (-alpha * t).exp() * ((wd * t).cos() + alpha / wd * (wd * t).sin());
        worst = worst.max((vc[i] - exact).abs());
    }
    assert!(worst < 5e-3, "max error {worst} V (0.5 % of the 1 V step)");
    // ringing frequency
    let f = measure::frequency(&res.time, vc, 1.0).unwrap();
    assert!((f - wd / (2.0 * PI)).abs() / (wd / (2.0 * PI)) < 5e-3, "f = {f}");
}

#[test]
fn rc_lowpass_ac_corner_and_phase() {
    let (r, cap) = (1.6e3, 100e-9);
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", Waveform::dc(0.0), 1.0).resistor("R1", "in", "out", r).capacitor("C1", "out", "0", cap);
    let res = ac(&mut c, Sweep::Dec { points: 200, start: 10.0, stop: 100e3 }, &opts()).unwrap();
    let h = res.signal("V(out)").unwrap();
    let fc = measure::corner_frequency(&res.freq, &h, 10f64.log10() * 10.0 * 0.30103).unwrap();
    let exact = 1.0 / (2.0 * PI * r * cap); // 994.7 Hz
    assert!((fc - exact).abs() / exact < 1e-3, "fc = {fc} Hz, expected {exact}");
    // phase −45° at fc (closest sweep point)
    let i = res.freq.iter().enumerate().min_by(|a, b| (a.1 - exact).abs().partial_cmp(&(b.1 - exact).abs()).unwrap()).unwrap().0;
    let ph = h[i].arg().to_degrees();
    assert!((ph + 45.0).abs() < 1.0, "phase {ph}°");
}

/// Solve 5 V → 1 kΩ → diode exactly by bisection on the Shockley equation.
fn diode_reference(vs: f64, r: f64, m: &DiodeModel) -> f64 {
    let vt = m.n * 0.025_851_99;
    let (mut lo, mut hi) = (0.0, vs);
    for _ in 0..200 {
        let vd = 0.5 * (lo + hi);
        let f = (vs - vd) / r - m.is * ((vd / vt).exp() - 1.0);
        if f > 0.0 { lo = vd } else { hi = vd }
    }
    0.5 * (lo + hi)
}

#[test]
fn diode_operating_point_matches_shockley() {
    let m = DiodeModel::default();
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", Waveform::dc(5.0), 0.0).resistor("R1", "in", "a", 1e3).diode("D1", "a", "0", m);
    let r = op(&mut c, &opts()).unwrap();
    let exact = diode_reference(5.0, 1e3, &m);
    let got = r.get("V(a)").unwrap();
    assert!((got - exact).abs() < 1e-5, "Vd = {got}, expected {exact}");
    assert!(r.iterations < 30, "took {} Newton iterations", r.iterations);
}

#[test]
fn diode_converges_from_a_hard_start() {
    // 100 V straight into a diode through 10 Ω: needs junction limiting
    let m = DiodeModel::default();
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", Waveform::dc(100.0), 0.0).resistor("R1", "in", "a", 10.0).diode("D1", "a", "0", m);
    let r = op(&mut c, &opts()).unwrap();
    let exact = diode_reference(100.0, 10.0, &m);
    assert!((r.get("V(a)").unwrap() - exact).abs() < 1e-4);
}

#[test]
fn half_wave_rectifier_peak() {
    let m = DiodeModel::default();
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", Waveform::Sin { offset: 0.0, amplitude: 10.0, freq: 50.0, delay: 0.0, damping: 0.0, phase_deg: 0.0 }, 0.0)
        .diode("D1", "in", "out", m)
        .resistor("RL", "out", "0", 1e3);
    let res = tran(&mut c, TranSpec { stop: 40e-3, step: 10e-6 }, &opts()).unwrap();
    let out = res.signal("V(out)").unwrap();
    let peak = out.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    // peak = 10 V − Vd at ≈ 9.3 mA
    let vd = diode_reference(10.0, 1e3, &m);
    assert!((peak - (10.0 - vd)).abs() < 0.02, "peak {peak}");
    let neg = out.iter().cloned().fold(f64::INFINITY, f64::min);
    assert!(neg > -1e-3, "no conduction in reverse: min {neg}");
}

#[test]
fn floating_node_is_reported() {
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", Waveform::dc(1.0), 0.0).resistor("R1", "in", "dangling", 1e3);
    match op(&mut c, &opts()) {
        Err(Error::Topology(m)) => assert!(m.contains("dangling"), "{m}"),
        other => panic!("expected topology error, got {other:?}"),
    }
}

#[test]
fn voltage_source_loop_is_singular() {
    let mut c = Circuit::new();
    c.vsource("V1", "a", "0", Waveform::dc(1.0), 0.0).vsource("V2", "a", "0", Waveform::dc(2.0), 0.0).resistor("R1", "a", "0", 1e3);
    assert!(matches!(op(&mut c, &opts()), Err(Error::Singular { .. })));
}

#[test]
fn json_api_round_trip() {
    let job = r#"{
      "elements": [
        {"kind":"vsource","name":"V1","nodes":["in","0"],"wave":{"type":"dc","value":5},"ac":1},
        {"kind":"resistor","name":"R1","nodes":["in","out"],"value":1000},
        {"kind":"capacitor","name":"C1","nodes":["out","0"],"value":1e-6}
      ],
      "analysis": {"type":"op"}
    }"#;
    let out = sb_engine::api::run_json(job).unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["type"], "op");
    let names = v["names"].as_array().unwrap();
    let i = names.iter().position(|n| n == "V(out)").unwrap();
    assert!((v["values"][i].as_f64().unwrap() - 5.0).abs() < 1e-6, "capacitor is open at DC");
}

#[test]
fn capacitor_only_node_gets_dc_fallback() {
    // the node between two series capacitors has no DC path; the engine retries with a 1 TΩ shunt
    let mut c = Circuit::new();
    c.vsource("V1", "in", "0", Waveform::dc(5.0), 0.0)
        .capacitor("C1", "in", "mid", 1e-6)
        .capacitor("C2", "mid", "0", 1e-6)
        .resistor("R1", "in", "0", 1e3);
    let r = op(&mut c, &opts()).unwrap();
    assert!(r.get("V(mid)").unwrap().is_finite());
}
