//! Circuit description: nodes, elements and the unknown layout used by MNA.
//!
//! Node 0 is ground. Unknown `i` in the solution vector is node `i + 1` for
//! `i < node_count - 1`; after the node voltages come branch currents for
//! elements that need one (voltage sources, inductors).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::waveform::Waveform;

pub type Node = usize;

/// Diode model parameters (Shockley). Series resistance and junction
/// capacitance arrive with the full diode model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DiodeModel {
    /// Saturation current [A]
    pub is: f64,
    /// Emission coefficient
    pub n: f64,
}

impl Default for DiodeModel {
    fn default() -> Self {
        // A small-signal silicon diode (≈ 0.62 V at 1 mA).
        Self { is: 2.52e-9, n: 1.752 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Element {
    Resistor { name: String, a: Node, b: Node, r: f64 },
    Capacitor { name: String, a: Node, b: Node, c: f64 },
    Inductor { name: String, a: Node, b: Node, l: f64 },
    /// Independent voltage source: V(a) − V(b) = wave(t). `ac` is the AC magnitude.
    Vsource { name: String, a: Node, b: Node, wave: Waveform, #[serde(default)] ac: f64 },
    /// Independent current source: current `wave(t)` flows from `a` through the source to `b`.
    Isource { name: String, a: Node, b: Node, wave: Waveform, #[serde(default)] ac: f64 },
    /// Diode, anode `a`, cathode `k`.
    Diode { name: String, a: Node, k: Node, #[serde(default)] model: DiodeModel },
    /// Voltage-controlled current source: I(a→b) = gm · (V(cp) − V(cn)).
    Vccs { name: String, a: Node, b: Node, cp: Node, cn: Node, gm: f64 },
    /// Voltage-controlled voltage source: V(a) − V(b) = gain · (V(cp) − V(cn)).
    Vcvs { name: String, a: Node, b: Node, cp: Node, cn: Node, gain: f64 },
}

impl Element {
    pub fn name(&self) -> &str {
        match self {
            Element::Resistor { name, .. }
            | Element::Capacitor { name, .. }
            | Element::Inductor { name, .. }
            | Element::Vsource { name, .. }
            | Element::Isource { name, .. }
            | Element::Diode { name, .. }
            | Element::Vccs { name, .. }
            | Element::Vcvs { name, .. } => name,
        }
    }

    /// Does this element add a branch-current unknown?
    pub fn needs_branch(&self) -> bool {
        matches!(self, Element::Inductor { .. } | Element::Vsource { .. } | Element::Vcvs { .. })
    }

    pub fn is_nonlinear(&self) -> bool {
        matches!(self, Element::Diode { .. })
    }
}

/// A flat circuit ready for analysis. Build it with [`Circuit::node`] and the
/// element helpers, or deserialize it from JSON (see [`crate::api`]).
#[derive(Debug, Clone, Default)]
pub struct Circuit {
    node_names: Vec<String>,
    node_index: HashMap<String, Node>,
    pub elements: Vec<Element>,
    /// Branch unknown index (absolute) per element, if any.
    branch_of: Vec<Option<usize>>,
}

impl Circuit {
    pub fn new() -> Self {
        let mut c = Self::default();
        c.node_names.push("0".into());
        c.node_index.insert("0".into(), 0);
        for alias in ["gnd", "GND"] {
            c.node_index.insert(alias.into(), 0);
        }
        c
    }

    /// Get or create a node by name. "0", "gnd" and "GND" are ground.
    pub fn node(&mut self, name: &str) -> Node {
        if let Some(&n) = self.node_index.get(name) {
            return n;
        }
        let n = self.node_names.len();
        self.node_names.push(name.to_string());
        self.node_index.insert(name.to_string(), n);
        n
    }

    pub fn node_name(&self, n: Node) -> &str {
        &self.node_names[n]
    }

    pub fn find_node(&self, name: &str) -> Option<Node> {
        self.node_index.get(name).copied()
    }

    pub fn node_count(&self) -> usize {
        self.node_names.len()
    }

    pub fn add(&mut self, e: Element) -> &mut Self {
        self.elements.push(e);
        self.branch_of.clear(); // invalidate layout
        self
    }

    // ---- convenience builders -------------------------------------------------
    pub fn resistor(&mut self, name: &str, a: &str, b: &str, r: f64) -> &mut Self {
        let (a, b) = (self.node(a), self.node(b));
        self.add(Element::Resistor { name: name.into(), a, b, r })
    }
    pub fn capacitor(&mut self, name: &str, a: &str, b: &str, c: f64) -> &mut Self {
        let (a, b) = (self.node(a), self.node(b));
        self.add(Element::Capacitor { name: name.into(), a, b, c })
    }
    pub fn inductor(&mut self, name: &str, a: &str, b: &str, l: f64) -> &mut Self {
        let (a, b) = (self.node(a), self.node(b));
        self.add(Element::Inductor { name: name.into(), a, b, l })
    }
    pub fn vsource(&mut self, name: &str, a: &str, b: &str, wave: Waveform, ac: f64) -> &mut Self {
        let (a, b) = (self.node(a), self.node(b));
        self.add(Element::Vsource { name: name.into(), a, b, wave, ac })
    }
    pub fn isource(&mut self, name: &str, a: &str, b: &str, wave: Waveform) -> &mut Self {
        let (a, b) = (self.node(a), self.node(b));
        self.add(Element::Isource { name: name.into(), a, b, wave, ac: 0.0 })
    }
    pub fn diode(&mut self, name: &str, a: &str, k: &str, model: DiodeModel) -> &mut Self {
        let (a, k) = (self.node(a), self.node(k));
        self.add(Element::Diode { name: name.into(), a, k, model })
    }

    /// Assign branch unknowns. Called by every analysis before solving.
    pub fn layout(&mut self) -> usize {
        let mut next = self.node_count() - 1;
        self.branch_of = self
            .elements
            .iter()
            .map(|e| {
                if e.needs_branch() {
                    next += 1;
                    Some(next - 1)
                } else {
                    None
                }
            })
            .collect();
        next
    }

    pub fn branch(&self, element: usize) -> usize {
        self.branch_of[element].expect("element has no branch unknown")
    }

    /// Unknown index of a node, or None for ground.
    #[inline]
    pub fn unk(n: Node) -> Option<usize> {
        if n == 0 { None } else { Some(n - 1) }
    }

    /// Human-readable names for every unknown: V(node) then I(element).
    pub fn unknown_names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.node_names[1..].iter().map(|n| format!("V({n})")).collect();
        for (i, e) in self.elements.iter().enumerate() {
            if self.branch_of.get(i).copied().flatten().is_some() {
                v.push(format!("I({})", e.name()));
            }
        }
        v
    }

    /// Basic topology checks before solving (errors that say which part or net is at fault).
    pub fn validate(&self) -> Result<(), crate::Error> {
        if self.elements.is_empty() {
            return Err(crate::Error::Topology("circuit has no elements".into()));
        }
        // every non-ground node must touch at least two terminals or a source
        let mut degree = vec![0usize; self.node_count()];
        for e in &self.elements {
            for n in terminals(e) {
                degree[n] += 1;
            }
        }
        if degree[0] == 0 {
            return Err(crate::Error::Topology("nothing is connected to ground (node 0)".into()));
        }
        for (n, d) in degree.iter().enumerate().skip(1) {
            if *d < 2 {
                return Err(crate::Error::Topology(format!(
                    "node {} is connected to only one terminal (floating)",
                    self.node_names[n]
                )));
            }
        }
        Ok(())
    }
}

pub(crate) fn terminals(e: &Element) -> Vec<Node> {
    match *e {
        Element::Resistor { a, b, .. }
        | Element::Capacitor { a, b, .. }
        | Element::Inductor { a, b, .. }
        | Element::Vsource { a, b, .. }
        | Element::Isource { a, b, .. } => vec![a, b],
        Element::Diode { a, k, .. } => vec![a, k],
        Element::Vccs { a, b, cp, cn, .. } | Element::Vcvs { a, b, cp, cn, .. } => vec![a, b, cp, cn],
    }
}
