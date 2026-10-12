//! Time-dependent values for independent sources.

use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Waveform {
    Dc { value: f64 },
    Sin { offset: f64, amplitude: f64, freq: f64, #[serde(default)] delay: f64, #[serde(default)] damping: f64, #[serde(default)] phase_deg: f64 },
    Pulse { v1: f64, v2: f64, delay: f64, rise: f64, fall: f64, width: f64, period: f64 },
    /// Piecewise linear: (time, value) points, held constant after the last point.
    Pwl { points: Vec<(f64, f64)> },
}

impl Waveform {
    pub fn dc(value: f64) -> Self {
        Waveform::Dc { value }
    }

    /// Value at time `t`. For the DC operating point the engine uses `t = 0`.
    pub fn value(&self, t: f64) -> f64 {
        match self {
            Waveform::Dc { value } => *value,
            Waveform::Sin { offset, amplitude, freq, delay, damping, phase_deg } => {
                let ph = phase_deg.to_radians();
                if t < *delay {
                    offset + amplitude * ph.sin()
                } else {
                    let td = t - delay;
                    offset + amplitude * (-damping * td).exp() * (2.0 * PI * freq * td + ph).sin()
                }
            }
            Waveform::Pulse { v1, v2, delay, rise, fall, width, period } => {
                if t < *delay {
                    return *v1;
                }
                let tp = if *period > 0.0 { (t - delay) % period } else { t - delay };
                if tp < *rise {
                    v1 + (v2 - v1) * tp / rise.max(1e-15)
                } else if tp < rise + width {
                    *v2
                } else if tp < rise + width + fall {
                    v2 + (v1 - v2) * (tp - rise - width) / fall.max(1e-15)
                } else {
                    *v1
                }
            }
            Waveform::Pwl { points } => {
                if points.is_empty() {
                    return 0.0;
                }
                if t <= points[0].0 {
                    return points[0].1;
                }
                for w in points.windows(2) {
                    let ((t0, v0), (t1, v1)) = (w[0], w[1]);
                    if t <= t1 {
                        return v0 + (v1 - v0) * (t - t0) / (t1 - t0).max(1e-30);
                    }
                }
                points.last().unwrap().1
            }
        }
    }

    /// Times in [0, stop] where the waveform has a corner. The transient
    /// analysis lands exactly on these and restarts integration with Backward Euler.
    pub fn breakpoints(&self, stop: f64) -> Vec<f64> {
        let mut out = Vec::new();
        match self {
            Waveform::Pulse { delay, rise, fall, width, period, .. } => {
                let corners = [0.0, *rise, rise + width, rise + width + fall];
                let mut base = *delay;
                loop {
                    for c in corners {
                        let t = base + c;
                        if t <= stop {
                            out.push(t);
                        }
                    }
                    if *period <= 0.0 || base + period > stop {
                        break;
                    }
                    base += period;
                }
            }
            Waveform::Pwl { points } => out.extend(points.iter().map(|p| p.0).filter(|&t| t <= stop)),
            Waveform::Sin { delay, .. } if *delay > 0.0 && *delay <= stop => out.push(*delay),
            _ => {}
        }
        out
    }
}
