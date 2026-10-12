//! Element stamps for the real-valued (DC / transient) MNA system.

use crate::circuit::{Circuit, DiodeModel, Element};
use crate::matrix::Dense;

/// Thermal voltage kT/q at 27 °C.
pub const VT_300K: f64 = 0.025_851_99;

/// Integration method for the current time point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Integ {
    /// DC operating point: capacitors open, inductors short.
    Dc,
    BackwardEuler { h: f64 },
    Trapezoidal { h: f64 },
}

/// History of a reactive element at the previous accepted time point.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReactiveState {
    pub v: f64,
    pub i: f64,
}

pub struct LoadCtx<'a> {
    pub t: f64,
    pub integ: Integ,
    /// Scale factor on independent sources (source stepping), normally 1.
    pub src_scale: f64,
    /// Conductance across every nonlinear junction.
    pub gmin: f64,
    /// Tiny conductance from every node to ground so capacitor-only nodes stay solvable.
    pub gshunt: f64,
    pub history: &'a [ReactiveState],
}

#[inline]
fn v_of(x: &[f64], n: usize) -> f64 {
    Circuit::unk(n).map_or(0.0, |i| x[i])
}

#[inline]
fn stamp_g(m: &mut Dense<f64>, a: usize, b: usize, g: f64) {
    let (ua, ub) = (Circuit::unk(a), Circuit::unk(b));
    if let Some(i) = ua { m.add(i, i, g); }
    if let Some(j) = ub { m.add(j, j, g); }
    if let (Some(i), Some(j)) = (ua, ub) {
        m.add(i, j, -g);
        m.add(j, i, -g);
    }
}

/// Current `i` injected from node `a`, through the element, into node `b`
/// (i.e. leaving `a`): rhs[a] −= i, rhs[b] += i.
#[inline]
fn stamp_i(rhs: &mut [f64], a: usize, b: usize, i: f64) {
    if let Some(u) = Circuit::unk(a) { rhs[u] -= i; }
    if let Some(u) = Circuit::unk(b) { rhs[u] += i; }
}

/// Branch row/column for an element whose branch current flows a → b inside it.
#[inline]
fn stamp_branch(m: &mut Dense<f64>, a: usize, b: usize, k: usize) {
    if let Some(i) = Circuit::unk(a) { m.add(i, k, 1.0); m.add(k, i, 1.0); }
    if let Some(j) = Circuit::unk(b) { m.add(j, k, -1.0); m.add(k, j, -1.0); }
}

/// Junction-voltage limiting (log-domain step limiting from Nagel's SPICE2
/// thesis): keeps Newton steps on exponential junctions from overflowing.
pub fn limit_junction(v_new: f64, v_old: f64, vt: f64, vcrit: f64) -> f64 {
    if v_new > vcrit && (v_new - v_old).abs() > 2.0 * vt {
        if v_old > 0.0 {
            let arg = 1.0 + (v_new - v_old) / vt;
            if arg > 0.0 { v_old + vt * arg.ln() } else { vcrit }
        } else {
            vt * (v_new / vt).ln()
        }
    } else {
        v_new
    }
}

/// Shockley diode current and conductance with a linear extension above
/// 40·nVt so exp() never overflows.
pub fn diode_eval(m: &DiodeModel, vd: f64) -> (f64, f64) {
    let vt = m.n * VT_300K;
    let x = vd / vt;
    const XMAX: f64 = 40.0;
    if x > XMAX {
        let e = XMAX.exp();
        let id = m.is * (e * (1.0 + (x - XMAX)) - 1.0);
        let gd = m.is * e / vt;
        (id, gd)
    } else {
        let e = x.exp();
        (m.is * (e - 1.0), m.is * e / vt)
    }
}

pub fn diode_vcrit(m: &DiodeModel) -> f64 {
    let vt = m.n * VT_300K;
    vt * (vt / (std::f64::consts::SQRT_2 * m.is)).ln()
}

/// Assemble G and rhs at the iterate `x`. `vd` holds the limited junction
/// voltage of every element (only diodes use it) and is updated in place.
pub fn load(ckt: &Circuit, x: &[f64], ctx: &LoadCtx, vd: &mut [f64], m: &mut Dense<f64>, rhs: &mut [f64]) {
    m.clear();
    rhs.iter_mut().for_each(|v| *v = 0.0);
    for n in 1..ckt.node_count() {
        stamp_g(m, n, 0, ctx.gshunt);
    }
    for (idx, e) in ckt.elements.iter().enumerate() {
        match e {
            Element::Resistor { a, b, r, .. } => stamp_g(m, *a, *b, 1.0 / r),
            Element::Capacitor { a, b, c, .. } => {
                let hist = ctx.history[idx];
                match ctx.integ {
                    Integ::Dc => {}
                    Integ::BackwardEuler { h } => {
                        let geq = c / h;
                        stamp_g(m, *a, *b, geq);
                        // i = geq·v − geq·v_prev  → equivalent source of −geq·v_prev
                        stamp_i(rhs, *a, *b, -geq * hist.v);
                    }
                    Integ::Trapezoidal { h } => {
                        let geq = 2.0 * c / h;
                        stamp_g(m, *a, *b, geq);
                        stamp_i(rhs, *a, *b, -(geq * hist.v + hist.i));
                    }
                }
            }
            Element::Inductor { a, b, l, .. } => {
                let k = ckt.branch(idx);
                stamp_branch(m, *a, *b, k);
                let hist = ctx.history[idx];
                match ctx.integ {
                    Integ::Dc => {} // V(a) − V(b) = 0
                    Integ::BackwardEuler { h } => {
                        m.add(k, k, -l / h);
                        rhs[k] = -l / h * hist.i;
                    }
                    Integ::Trapezoidal { h } => {
                        m.add(k, k, -2.0 * l / h);
                        rhs[k] = -2.0 * l / h * hist.i - hist.v;
                    }
                }
            }
            Element::Vsource { a, b, wave, .. } => {
                let k = ckt.branch(idx);
                stamp_branch(m, *a, *b, k);
                rhs[k] = ctx.src_scale * wave.value(ctx.t);
            }
            Element::Isource { a, b, wave, .. } => stamp_i(rhs, *a, *b, ctx.src_scale * wave.value(ctx.t)),
            Element::Vccs { a, b, cp, cn, gm, .. } => {
                for (row, s_row) in [(*a, 1.0), (*b, -1.0)] {
                    let Some(r) = Circuit::unk(row) else { continue };
                    if let Some(c) = Circuit::unk(*cp) { m.add(r, c, s_row * gm); }
                    if let Some(c) = Circuit::unk(*cn) { m.add(r, c, -s_row * gm); }
                }
            }
            Element::Vcvs { a, b, cp, cn, gain, .. } => {
                let k = ckt.branch(idx);
                stamp_branch(m, *a, *b, k);
                if let Some(c) = Circuit::unk(*cp) { m.add(k, c, -gain); }
                if let Some(c) = Circuit::unk(*cn) { m.add(k, c, *gain); }
            }
            Element::Diode { a, k, model, .. } => {
                let vt = model.n * VT_300K;
                let v_raw = v_of(x, *a) - v_of(x, *k);
                let v = limit_junction(v_raw, vd[idx], vt, diode_vcrit(model));
                vd[idx] = v;
                let (id, gd) = diode_eval(model, v);
                stamp_g(m, *a, *k, gd + ctx.gmin);
                stamp_i(rhs, *a, *k, id - gd * v);
            }
        }
    }
}

/// Currents through two-terminal elements at a solved point (for outputs and
/// for updating reactive history). Positive = flowing a → b inside the element.
pub fn element_current(ckt: &Circuit, idx: usize, x: &[f64], integ: Integ, hist: &ReactiveState) -> Option<f64> {
    let e = &ckt.elements[idx];
    match e {
        Element::Resistor { a, b, r, .. } => Some((v_of(x, *a) - v_of(x, *b)) / r),
        Element::Diode { a, k, model, .. } => Some(diode_eval(model, v_of(x, *a) - v_of(x, *k)).0),
        Element::Capacitor { a, b, c, .. } => {
            let v = v_of(x, *a) - v_of(x, *b);
            Some(match integ {
                Integ::Dc => 0.0,
                Integ::BackwardEuler { h } => c / h * (v - hist.v),
                Integ::Trapezoidal { h } => 2.0 * c / h * (v - hist.v) - hist.i,
            })
        }
        Element::Inductor { .. } | Element::Vsource { .. } | Element::Vcvs { .. } => Some(x[ckt.branch(idx)]),
        Element::Isource { wave, .. } => Some(wave.value(0.0)),
        Element::Vccs { .. } => None,
    }
}

pub fn branch_voltage(ckt: &Circuit, idx: usize, x: &[f64]) -> f64 {
    let (a, b) = match &ckt.elements[idx] {
        Element::Resistor { a, b, .. } | Element::Capacitor { a, b, .. } | Element::Inductor { a, b, .. }
        | Element::Vsource { a, b, .. } | Element::Isource { a, b, .. } | Element::Vccs { a, b, .. }
        | Element::Vcvs { a, b, .. } => (*a, *b),
        Element::Diode { a, k, .. } => (*a, *k),
    };
    v_of(x, a) - v_of(x, b)
}

/// Initial junction voltage for Newton (diodes only; other elements unused).
pub fn branch_voltage_or_zero(_ckt: &Circuit, e: &Element, x: &[f64]) -> f64 {
    match e {
        Element::Diode { a, k, .. } => v_of(x, *a) - v_of(x, *k),
        _ => 0.0,
    }
}
