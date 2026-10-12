//! Measurement functions behind Kirk `measure`.
//! All work on the accepted solution points with linear interpolation.

use num_complex::Complex64;

/// Times where `y` crosses `level` going upwards.
pub fn rising_crossings(t: &[f64], y: &[f64], level: f64) -> Vec<f64> {
    let mut out = Vec::new();
    for i in 1..y.len() {
        if y[i - 1] < level && y[i] >= level {
            let f = (level - y[i - 1]) / (y[i] - y[i - 1]);
            out.push(t[i - 1] + f * (t[i] - t[i - 1]));
        }
    }
    out
}

pub fn falling_crossings(t: &[f64], y: &[f64], level: f64) -> Vec<f64> {
    let neg: Vec<f64> = y.iter().map(|v| -v).collect();
    rising_crossings(t, &neg, -level)
}

/// Mean frequency from consecutive rising crossings (ignores the first,
/// often start-up-distorted, period when at least 3 crossings exist).
pub fn frequency(t: &[f64], y: &[f64], level: f64) -> Option<f64> {
    let c = rising_crossings(t, y, level);
    let c: &[f64] = if c.len() >= 3 { &c[1..] } else { &c[..] };
    if c.len() < 2 {
        return None;
    }
    Some((c.len() - 1) as f64 / (c[c.len() - 1] - c[0]))
}

/// Fraction of the period spent above `level` (uses the last full period).
pub fn duty(t: &[f64], y: &[f64], level: f64) -> Option<f64> {
    let r = rising_crossings(t, y, level);
    let f = falling_crossings(t, y, level);
    if r.len() < 2 {
        return None;
    }
    let (t0, t1) = (r[r.len() - 2], r[r.len() - 1]);
    let fall = f.iter().find(|&&x| x > t0 && x < t1)?;
    Some((fall - t0) / (t1 - t0))
}

pub fn pp(y: &[f64]) -> f64 {
    let (mn, mx) = y.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
    mx - mn
}

/// Time-weighted average (trapezoidal), robust to non-uniform steps.
pub fn avg(t: &[f64], y: &[f64]) -> f64 {
    let span = t[t.len() - 1] - t[0];
    if span <= 0.0 {
        return y[0];
    }
    (1..t.len()).map(|i| 0.5 * (y[i] + y[i - 1]) * (t[i] - t[i - 1])).sum::<f64>() / span
}

pub fn rms(t: &[f64], y: &[f64]) -> f64 {
    let sq: Vec<f64> = y.iter().map(|v| v * v).collect();
    avg(t, &sq).sqrt()
}

/// Restrict a trace to t ≥ `from`.
pub fn window<'a>(t: &'a [f64], y: &'a [f64], from: f64) -> (&'a [f64], &'a [f64]) {
    let i = t.partition_point(|&x| x < from);
    (&t[i..], &y[i..])
}

pub fn db(v: Complex64) -> f64 {
    20.0 * v.norm().max(1e-300).log10()
}

/// First frequency where |H| drops `drop_db` below its low-frequency value
/// (log-interpolated). This is the −3 dB corner for `drop_db = 3.0103`.
pub fn corner_frequency(f: &[f64], h: &[Complex64], drop_db: f64) -> Option<f64> {
    let ref_db = db(h[0]);
    let target = ref_db - drop_db;
    for i in 1..h.len() {
        let (a, b) = (db(h[i - 1]), db(h[i]));
        if a >= target && b < target {
            let fr = (target - a) / (b - a);
            return Some(10f64.powf(f[i - 1].log10() + fr * (f[i].log10() - f[i - 1].log10())));
        }
    }
    None
}
