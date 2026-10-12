//! JSON interface used by the desktop app (and later the Kirk compiler).
//!
//! ```json
//! { "elements": [
//!     {"kind":"vsource","name":"V1","nodes":["in","0"],"wave":{"type":"dc","value":5},"ac":1},
//!     {"kind":"resistor","name":"R1","nodes":["in","out"],"value":1000},
//!     {"kind":"capacitor","name":"C1","nodes":["out","0"],"value":1e-6}
//!   ],
//!   "analysis": {"type":"tran","stop":0.01,"step":1e-5} }
//! ```

use serde::{Deserialize, Serialize};

use crate::analysis::{self, AcResult, OpResult, Options, Sweep, TranResult, TranSpec};
use crate::circuit::{Circuit, DiodeModel, Element};
use crate::waveform::Waveform;
use crate::Error;

#[derive(Debug, Clone, Deserialize)]
pub struct ElementSpec {
    pub kind: String,
    pub name: String,
    pub nodes: Vec<String>,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub wave: Option<Waveform>,
    #[serde(default)]
    pub ac: Option<f64>,
    #[serde(default)]
    pub model: Option<DiodeModel>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AnalysisSpec {
    Op,
    Tran { stop: f64, step: f64 },
    Ac { start: f64, stop: f64, #[serde(default = "default_ppd")] points_per_decade: usize },
}
fn default_ppd() -> usize { 50 }

#[derive(Debug, Clone, Deserialize)]
pub struct Job {
    pub elements: Vec<ElementSpec>,
    pub analysis: AnalysisSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum JobResult {
    Op(OpResult),
    Tran(TranResult),
    Ac(AcResult),
}

pub fn build_circuit(elements: &[ElementSpec]) -> Result<Circuit, Error> {
    let mut c = Circuit::new();
    for e in elements {
        let need = |k: usize| -> Result<(), Error> {
            if e.nodes.len() == k { Ok(()) } else {
                Err(Error::Spec(format!("{} ({}) needs {k} nodes, got {}", e.name, e.kind, e.nodes.len())))
            }
        };
        let val = || e.value.ok_or_else(|| Error::Spec(format!("{} needs a value", e.name)));
        let wave = || e.wave.clone().or(e.value.map(Waveform::dc)).ok_or_else(|| Error::Spec(format!("{} needs a wave or value", e.name)));
        let n: Vec<usize> = e.nodes.iter().map(|s| c.node(s)).collect();
        let name = e.name.clone();
        let el = match e.kind.as_str() {
            "resistor" => { need(2)?; let r = val()?; if r <= 0.0 { return Err(Error::Spec(format!("{name}: resistance must be > 0"))); } Element::Resistor { name, a: n[0], b: n[1], r } }
            "capacitor" => { need(2)?; Element::Capacitor { name, a: n[0], b: n[1], c: val()? } }
            "inductor" => { need(2)?; Element::Inductor { name, a: n[0], b: n[1], l: val()? } }
            "vsource" => { need(2)?; Element::Vsource { name, a: n[0], b: n[1], wave: wave()?, ac: e.ac.unwrap_or(0.0) } }
            "isource" => { need(2)?; Element::Isource { name, a: n[0], b: n[1], wave: wave()?, ac: e.ac.unwrap_or(0.0) } }
            "diode" => { need(2)?; Element::Diode { name, a: n[0], k: n[1], model: e.model.unwrap_or_default() } }
            "vccs" => { need(4)?; Element::Vccs { name, a: n[0], b: n[1], cp: n[2], cn: n[3], gm: val()? } }
            "vcvs" => { need(4)?; Element::Vcvs { name, a: n[0], b: n[1], cp: n[2], cn: n[3], gain: val()? } }
            other => return Err(Error::Spec(format!("unknown element kind '{other}'"))),
        };
        c.add(el);
    }
    Ok(c)
}

pub fn run(job: &Job) -> Result<JobResult, Error> {
    let mut c = build_circuit(&job.elements)?;
    let opts = Options::default();
    Ok(match job.analysis {
        AnalysisSpec::Op => JobResult::Op(analysis::op(&mut c, &opts)?),
        AnalysisSpec::Tran { stop, step } => JobResult::Tran(analysis::tran(&mut c, TranSpec { stop, step }, &opts)?),
        AnalysisSpec::Ac { start, stop, points_per_decade } => {
            JobResult::Ac(analysis::ac(&mut c, Sweep::Dec { points: points_per_decade, start, stop }, &opts)?)
        }
    })
}

/// JSON in, JSON out — the single entry point the app calls.
pub fn run_json(job_json: &str) -> Result<String, Error> {
    let job: Job = serde_json::from_str(job_json).map_err(|e| Error::Spec(format!("invalid job JSON: {e}")))?;
    let res = run(&job)?;
    Ok(serde_json::to_string(&res).expect("result serializes"))
}
