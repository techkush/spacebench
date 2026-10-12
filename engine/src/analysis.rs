//! Analyses: DC operating point, transient and AC small-signal.

use num_complex::Complex64;
use serde::Serialize;

use crate::circuit::{Circuit, Element};
use crate::matrix::Dense;
use crate::stamp::{self, Integ, LoadCtx, ReactiveState};
use crate::Error;

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub reltol: f64,
    pub vntol: f64,
    pub abstol: f64,
    pub gmin: f64,
    pub gshunt: f64,
    pub max_newton: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { reltol: 1e-3, vntol: 1e-6, abstol: 1e-12, gmin: 1e-12, gshunt: 0.0, max_newton: 100 }
    }
}

/// Result of one Newton–Raphson solve.
struct Solved {
    x: Vec<f64>,
    iterations: usize,
}

fn newton(
    ckt: &Circuit, n: usize, x0: &[f64], t: f64, integ: Integ, src_scale: f64, gmin: f64,
    history: &[ReactiveState], opts: &Options, max_iter: usize,
) -> Result<Solved, Error> {
    let n_nodes = ckt.node_count() - 1;
    let mut x = x0.to_vec();
    // junction voltages start from the initial guess
    let mut vd: Vec<f64> = ckt.elements.iter().map(|e| stamp::branch_voltage_or_zero(ckt, e, &x)).collect();
    let mut m = Dense::<f64>::new(n);
    let mut rhs = vec![0.0; n];
    let linear = !ckt.elements.iter().any(|e| e.is_nonlinear());
    for it in 1..=max_iter {
        let ctx = LoadCtx { t, integ, src_scale, gmin, gshunt: opts.gshunt, history };
        stamp::load(ckt, &x, &ctx, &mut vd, &mut m, &mut rhs);
        let xn = m.solve(&rhs).map_err(|s| Error::Singular {
            unknown: ckt.unknown_names().get(s.unknown).cloned().unwrap_or_default(),
        })?;
        if xn.iter().any(|v| !v.is_finite()) {
            return Err(Error::NoConvergence { t, detail: "solution became non-finite".into() });
        }
        let converged = linear
            || xn.iter().zip(&x).enumerate().all(|(i, (a, b))| {
                let tol = opts.reltol * a.abs().max(b.abs()) + if i < n_nodes { opts.vntol } else { opts.abstol };
                (a - b).abs() <= tol
            });
        x = xn;
        if converged && (linear || it > 1) {
            return Ok(Solved { x, iterations: it });
        }
    }
    Err(Error::NoConvergence { t, detail: format!("Newton did not converge in {max_iter} iterations") })
}

#[derive(Debug, Clone, Serialize)]
pub struct OpResult {
    pub names: Vec<String>,
    pub values: Vec<f64>,
    pub iterations: usize,
    /// How the operating point was found: "newton", "gmin-stepping" or "source-stepping".
    pub method: String,
}

impl OpResult {
    pub fn get(&self, name: &str) -> Option<f64> {
        self.names.iter().position(|n| n == name).map(|i| self.values[i])
    }
}

fn solve_dc(ckt: &Circuit, n: usize, t: f64, opts: &Options, history: &[ReactiveState]) -> Result<(Solved, &'static str), Error> {
    match solve_dc_once(ckt, n, t, opts, history) {
        // Nodes reached only through capacitors have no DC path: add a tiny
        // shunt to ground (1 TΩ) and retry. Off by default so exact circuits stay exact.
        Err(Error::Singular { .. }) if opts.gshunt == 0.0 => {
            let mut o = *opts;
            o.gshunt = 1e-12;
            solve_dc_once(ckt, n, t, &o, history)
        }
        r => r,
    }
}

fn solve_dc_once(ckt: &Circuit, n: usize, t: f64, opts: &Options, history: &[ReactiveState]) -> Result<(Solved, &'static str), Error> {
    let x0 = vec![0.0; n];
    if let Ok(s) = newton(ckt, n, &x0, t, Integ::Dc, 1.0, opts.gmin, history, opts, opts.max_newton) {
        return Ok((s, "newton"));
    }
    // gmin stepping: start with heavy junction conductance and relax it
    let mut x = x0.clone();
    let mut total = 0;
    let mut ok = true;
    let mut g = 1e-2;
    while g >= opts.gmin * 0.999 {
        match newton(ckt, n, &x, t, Integ::Dc, 1.0, g, history, opts, opts.max_newton) {
            Ok(s) => { total += s.iterations; x = s.x; }
            Err(_) => { ok = false; break; }
        }
        g /= 10.0;
    }
    if ok {
        let s = newton(ckt, n, &x, t, Integ::Dc, 1.0, opts.gmin, history, opts, opts.max_newton)?;
        return Ok((Solved { x: s.x, iterations: total + s.iterations }, "gmin-stepping"));
    }
    // source stepping: ramp all independent sources from 0 to 100 %
    let mut x = x0;
    let mut total = 0;
    for k in 1..=20 {
        let s = newton(ckt, n, &x, t, Integ::Dc, k as f64 / 20.0, opts.gmin, history, opts, opts.max_newton)?;
        total += s.iterations;
        x = s.x;
    }
    Ok((Solved { x, iterations: total }, "source-stepping"))
}

/// Extra named outputs: currents through every element (where defined).
fn element_outputs(ckt: &Circuit) -> Vec<String> {
    ckt.elements.iter().filter(|e| !e.needs_branch() && !matches!(e, Element::Vccs { .. })).map(|e| format!("I({})", e.name())).collect()
}

fn element_values(ckt: &Circuit, x: &[f64], integ: Integ, history: &[ReactiveState]) -> Vec<f64> {
    ckt.elements
        .iter()
        .enumerate()
        .filter(|(_, e)| !e.needs_branch() && !matches!(e, Element::Vccs { .. }))
        .map(|(i, _)| stamp::element_current(ckt, i, x, integ, &history[i]).unwrap_or(0.0))
        .collect()
}

pub fn op(ckt: &mut Circuit, opts: &Options) -> Result<OpResult, Error> {
    ckt.validate()?;
    let n = ckt.layout();
    let history = vec![ReactiveState::default(); ckt.elements.len()];
    let (s, method) = solve_dc(ckt, n, 0.0, opts, &history)?;
    let mut names = ckt.unknown_names();
    names.extend(element_outputs(ckt));
    let mut values = s.x.clone();
    values.extend(element_values(ckt, &s.x, Integ::Dc, &history));
    Ok(OpResult { names, values, iterations: s.iterations, method: method.into() })
}

#[derive(Debug, Clone, Serialize)]
pub struct TranResult {
    pub time: Vec<f64>,
    pub names: Vec<String>,
    /// data[signal][point]
    pub data: Vec<Vec<f64>>,
    pub steps_accepted: usize,
    pub steps_rejected: usize,
}

impl TranResult {
    pub fn signal(&self, name: &str) -> Option<&[f64]> {
        self.names.iter().position(|n| n == name).map(|i| self.data[i].as_slice())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TranSpec {
    pub stop: f64,
    /// Maximum internal step (and the default output resolution).
    pub step: f64,
}

pub fn tran(ckt: &mut Circuit, spec: TranSpec, opts: &Options) -> Result<TranResult, Error> {
    ckt.validate()?;
    if spec.stop <= 0.0 || spec.step <= 0.0 {
        return Err(Error::Spec("transient needs stop > 0 and step > 0".into()));
    }
    let n = ckt.layout();
    let ne = ckt.elements.len();
    let mut history = vec![ReactiveState::default(); ne];
    let (s0, _) = solve_dc(ckt, n, 0.0, opts, &history)?;
    let mut x = s0.x;
    // initial reactive history from the operating point
    for i in 0..ne {
        history[i].v = stamp::branch_voltage(ckt, i, &x);
        history[i].i = match ckt.elements[i] { Element::Inductor { .. } => x[ckt.branch(i)], _ => 0.0 };
    }
    // breakpoints from all sources
    let mut bps: Vec<f64> = ckt.elements.iter().flat_map(|e| match e {
        Element::Vsource { wave, .. } | Element::Isource { wave, .. } => wave.breakpoints(spec.stop),
        _ => vec![],
    }).filter(|&t| t > 0.0).collect();
    bps.push(spec.stop);
    bps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    bps.dedup_by(|a, b| (*a - *b).abs() < 1e-15);

    let mut names = ckt.unknown_names();
    names.extend(element_outputs(ckt));
    let mut data: Vec<Vec<f64>> = vec![Vec::new(); names.len()];
    let mut time = vec![0.0];
    let push = |data: &mut Vec<Vec<f64>>, x: &[f64], extra: Vec<f64>| {
        for (i, v) in x.iter().chain(extra.iter()).enumerate() { data[i].push(*v); }
    };
    push(&mut data, &x, element_values(ckt, &x, Integ::Dc, &history));

    let mut t = 0.0;
    let mut bp_i = 0;
    let mut first_after_bp = true;
    let (mut accepted, mut rejected) = (0usize, 0usize);
    let h_min = spec.step * 1e-9;
    while t < spec.stop * (1.0 - 1e-12) {
        while bp_i < bps.len() && bps[bp_i] <= t + h_min { bp_i += 1; }
        let next_bp = bps.get(bp_i).copied().unwrap_or(spec.stop);
        let mut h = spec.step.min(next_bp - t);
        let mut cuts = 0;
        let solved = loop {
            let integ = if first_after_bp { Integ::BackwardEuler { h } } else { Integ::Trapezoidal { h } };
            match newton(ckt, n, &x, t + h, integ, 1.0, opts.gmin, &history, opts, 50) {
                Ok(s) => break (s, integ),
                Err(Error::NoConvergence { .. }) if cuts < 10 => { h /= 2.0; cuts += 1; rejected += 1; }
                Err(Error::NoConvergence { detail, .. }) => {
                    return Err(Error::NoConvergence { t: t + h, detail: format!("timestep too small ({detail})") });
                }
                Err(e) => return Err(e),
            }
        };
        let (s, integ) = solved;
        t += h;
        // update reactive history
        for i in 0..ne {
            match ckt.elements[i] {
                Element::Capacitor { .. } => {
                    let i_new = stamp::element_current(ckt, i, &s.x, integ, &history[i]).unwrap();
                    history[i] = ReactiveState { v: stamp::branch_voltage(ckt, i, &s.x), i: i_new };
                }
                Element::Inductor { .. } => {
                    history[i] = ReactiveState { v: stamp::branch_voltage(ckt, i, &s.x), i: s.x[ckt.branch(i)] };
                }
                _ => {}
            }
        }
        x = s.x;
        time.push(t);
        let extra: Vec<f64> = ckt.elements.iter().enumerate()
            .filter(|(_, e)| !e.needs_branch() && !matches!(e, Element::Vccs { .. }))
            .map(|(i, e)| match e { Element::Capacitor { .. } => history[i].i, _ => stamp::element_current(ckt, i, &x, integ, &history[i]).unwrap_or(0.0) })
            .collect();
        push(&mut data, &x, extra);
        accepted += 1;
        first_after_bp = (next_bp - t).abs() < h_min;
    }
    Ok(TranResult { time, names, data, steps_accepted: accepted, steps_rejected: rejected })
}

#[derive(Debug, Clone, Serialize)]
pub struct AcResult {
    pub freq: Vec<f64>,
    pub names: Vec<String>,
    pub re: Vec<Vec<f64>>,
    pub im: Vec<Vec<f64>>,
}

impl AcResult {
    pub fn signal(&self, name: &str) -> Option<Vec<Complex64>> {
        let i = self.names.iter().position(|n| n == name)?;
        Some(self.re[i].iter().zip(&self.im[i]).map(|(r, m)| Complex64::new(*r, *m)).collect())
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Sweep {
    Dec { points: usize, start: f64, stop: f64 },
    Lin { points: usize, start: f64, stop: f64 },
}

impl Sweep {
    pub fn freqs(&self) -> Vec<f64> {
        match *self {
            Sweep::Dec { points, start, stop } => {
                let decades = (stop / start).log10();
                let n = (decades * points as f64).round() as usize;
                (0..=n).map(|i| start * 10f64.powf(i as f64 / points as f64)).collect()
            }
            Sweep::Lin { points, start, stop } => {
                (0..points).map(|i| start + (stop - start) * i as f64 / (points.max(2) - 1) as f64).collect()
            }
        }
    }
}

pub fn ac(ckt: &mut Circuit, sweep: Sweep, opts: &Options) -> Result<AcResult, Error> {
    let op_res = op(ckt, opts)?;
    let n = ckt.layout();
    let xop = &op_res.values[..n];
    let freqs = sweep.freqs();
    let names = ckt.unknown_names();
    let mut re = vec![Vec::with_capacity(freqs.len()); n];
    let mut im = vec![Vec::with_capacity(freqs.len()); n];
    let unk = Circuit::unk;
    let c = |v: f64| Complex64::new(v, 0.0);
    for &f in &freqs {
        let w = 2.0 * std::f64::consts::PI * f;
        let mut m = Dense::<Complex64>::new(n);
        let mut b = vec![Complex64::default(); n];
        let g2 = |m: &mut Dense<Complex64>, a: usize, bb: usize, y: Complex64| {
            if let Some(i) = unk(a) { m.add(i, i, y); }
            if let Some(j) = unk(bb) { m.add(j, j, y); }
            if let (Some(i), Some(j)) = (unk(a), unk(bb)) { m.add(i, j, -y); m.add(j, i, -y); }
        };
        let br = |m: &mut Dense<Complex64>, a: usize, bb: usize, k: usize| {
            if let Some(i) = unk(a) { m.add(i, k, c(1.0)); m.add(k, i, c(1.0)); }
            if let Some(j) = unk(bb) { m.add(j, k, c(-1.0)); m.add(k, j, c(-1.0)); }
        };
        for node in 1..ckt.node_count() { g2(&mut m, node, 0, c(opts.gshunt)); }
        for (idx, e) in ckt.elements.iter().enumerate() {
            match e {
                Element::Resistor { a, b: bb, r, .. } => g2(&mut m, *a, *bb, c(1.0 / r)),
                Element::Capacitor { a, b: bb, c: cap, .. } => g2(&mut m, *a, *bb, Complex64::new(0.0, w * cap)),
                Element::Inductor { a, b: bb, l, .. } => {
                    let k = ckt.branch(idx);
                    br(&mut m, *a, *bb, k);
                    m.add(k, k, Complex64::new(0.0, -w * l));
                }
                Element::Vsource { a, b: bb, ac, .. } => {
                    let k = ckt.branch(idx);
                    br(&mut m, *a, *bb, k);
                    b[k] = c(*ac);
                }
                Element::Isource { a, b: bb, ac, .. } => {
                    if let Some(u) = unk(*a) { b[u] -= c(*ac); }
                    if let Some(u) = unk(*bb) { b[u] += c(*ac); }
                }
                Element::Vccs { a, b: bb, cp, cn, gm, .. } => {
                    for (row, s) in [(*a, 1.0), (*bb, -1.0)] {
                        let Some(r) = unk(row) else { continue };
                        if let Some(cc) = unk(*cp) { m.add(r, cc, c(s * gm)); }
                        if let Some(cc) = unk(*cn) { m.add(r, cc, c(-s * gm)); }
                    }
                }
                Element::Vcvs { a, b: bb, cp, cn, gain, .. } => {
                    let k = ckt.branch(idx);
                    br(&mut m, *a, *bb, k);
                    if let Some(cc) = unk(*cp) { m.add(k, cc, c(-gain)); }
                    if let Some(cc) = unk(*cn) { m.add(k, cc, c(*gain)); }
                }
                Element::Diode { a, k, model, .. } => {
                    let vd = unk(*a).map_or(0.0, |i| xop[i]) - unk(*k).map_or(0.0, |i| xop[i]);
                    let (_, gd) = stamp::diode_eval(model, vd);
                    g2(&mut m, *a, *k, c(gd + opts.gmin));
                }
            }
        }
        let x = m.solve(&b).map_err(|s| Error::Singular { unknown: names.get(s.unknown).cloned().unwrap_or_default() })?;
        for i in 0..n { re[i].push(x[i].re); im[i].push(x[i].im); }
    }
    Ok(AcResult { freq: freqs, names, re, im })
}
