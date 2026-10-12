//! # Space Bench Engine
//!
//! Our own circuit simulator (experimental). v0.1 implements
//! phases E0–E3: modified nodal analysis, dense LU, Newton–Raphson with
//! junction limiting + gmin/source stepping, transient (Backward Euler /
//! trapezoidal with breakpoints and step halving) and AC small-signal.

pub mod analysis;
pub mod api;
pub mod circuit;
pub mod matrix;
pub mod measure;
pub mod stamp;
pub mod waveform;

pub use analysis::{ac, op, tran, AcResult, OpResult, Options, Sweep, TranResult, TranSpec};
pub use circuit::{Circuit, DiodeModel, Element};
pub use waveform::Waveform;

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// Bad input (missing value, wrong node count, unknown kind…).
    Spec(String),
    /// The circuit cannot be solved as connected (floating node, no ground…).
    Topology(String),
    /// The MNA matrix is singular; `unknown` names the offending node or branch.
    Singular { unknown: String },
    /// Newton–Raphson failed to converge at time `t`.
    NoConvergence { t: f64, detail: String },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Spec(m) => write!(f, "invalid circuit: {m}"),
            Error::Topology(m) => write!(f, "topology error: {m}"),
            Error::Singular { unknown } => write!(
                f,
                "singular matrix at {unknown}: check for a floating node, a loop of voltage sources or a cut-set of current sources"
            ),
            Error::NoConvergence { t, detail } => write!(f, "no convergence at t = {t:.6e} s: {detail}"),
        }
    }
}

impl std::error::Error for Error {}
