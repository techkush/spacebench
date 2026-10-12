//! ngspice back end: write the netlist, run `ngspice -b` in a scratch
//! directory, parse the ASCII raw file and return the same JSON shapes the
//! UI already understands (op / tran / ac results).
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

static RUN: AtomicU64 = AtomicU64::new(0);
const TIMEOUT: Duration = Duration::from_secs(120);

/// `custom`: a path chosen in Settings → Simulation engine (wins when it exists).
pub fn find_ngspice(custom: Option<&str>) -> Option<PathBuf> {
  if let Some(p) = custom.map(str::trim).filter(|p| !p.is_empty()) {
    let p = PathBuf::from(p);
    return p.is_file().then_some(p);
  }
  if let Ok(p) = std::env::var("SPICEBENCH_NGSPICE") {
    return Some(PathBuf::from(p));
  }
  let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  // GUI apps on macOS get a minimal PATH, so also look in the usual places.
  dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "C:\\Program Files\\Spice64\\bin"].map(PathBuf::from));
  let exe = if cfg!(windows) { "ngspice_con.exe" } else { "ngspice" };
  dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

pub fn version(custom: Option<&str>) -> Result<String, String> {
  let bin = find_ngspice(custom).ok_or("ngspice not found")?;
  let out = Command::new(&bin).arg("-v").output().map_err(|e| e.to_string())?;
  let text = String::from_utf8_lossy(&out.stdout);
  Ok(text.split_whitespace().find(|w| w.starts_with("ngspice-")).unwrap_or("ngspice").to_string())
}

/// `netlist` must contain exactly one analysis line (.op / .tran / .ac / .dc)
/// and no `.end`; the control block is appended here.
pub fn run(netlist: &str, custom: Option<&str>) -> Result<String, String> {
  let bin = find_ngspice(custom).ok_or("ngspice was not found. Install it (macOS: `brew install ngspice`) or set SPICEBENCH_NGSPICE to its path.")?;
  let dir = std::env::temp_dir().join(format!("spicebench-{}-{}", std::process::id(), RUN.fetch_add(1, Ordering::Relaxed)));
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let raw = dir.join("out.raw");
  let deck = format!(
    "{}\n.control\nset filetype=ascii\nset noaskquit\nrun\nwrite {}\nquit\n.endc\n.end\n",
    netlist.trim_end(),
    raw.display()
  );
  let cir = dir.join("circuit.cir");
  std::fs::write(&cir, &deck).map_err(|e| e.to_string())?;

  let started = Instant::now();
  let mut child = Command::new(&bin)
    .arg("-b")
    .arg(&cir)
    .current_dir(&dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("could not start ngspice: {e}"))?;
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if started.elapsed() > TIMEOUT => {
        let _ = child.kill();
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("ngspice did not finish within {} s", TIMEOUT.as_secs()));
      }
      Ok(None) => std::thread::sleep(Duration::from_millis(5)),
      Err(e) => return Err(e.to_string()),
    }
  }
  let out = child.wait_with_output().map_err(|e| e.to_string())?;
  let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
  let parsed = std::fs::read_to_string(&raw).ok().map(|t| parse_raw(&t));
  let _ = std::fs::remove_dir_all(&dir);

  let messages: Vec<&str> = log
    .lines()
    .map(str::trim)
    .filter(|l| !l.is_empty() && (l.to_lowercase().contains("error") || l.to_lowercase().contains("warning") || l.contains("singular") || l.contains("Timestep too small")))
    .take(30)
    .collect();
  match parsed {
    Some(Ok(mut v)) => {
      v["log"] = json!(messages);
      v["elapsed_ms"] = json!(started.elapsed().as_secs_f64() * 1e3);
      Ok(v.to_string())
    }
    Some(Err(e)) => Err(format!("{e}\n{}", messages.join("\n"))),
    None => Err(if messages.is_empty() { log.lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n") } else { messages.join("\n") }),
  }
}

/// ngspice vector name → UI signal name: v(out) → V(out), i(v1) → I(V1),
/// i(@r1[i]) → I(R1), i(@q1[ic]) → Ic(Q1). Subcircuit internals are dropped.
pub(crate) fn signal_name(raw: &str) -> Option<String> {
  let l = raw.to_lowercase();
  // the shared library names device currents without the i( ): @r1[i]
  if l.starts_with('@') { return signal_name(&format!("i({raw})")); }
  if let Some(n) = l.strip_prefix("v(").and_then(|s| s.strip_suffix(')')) {
    if n.contains('.') || n.contains('#') { return None; }
    return Some(format!("V({})", &raw[2..raw.len() - 1]));
  }
  if let Some(inner) = l.strip_prefix("i(").and_then(|s| s.strip_suffix(')')) {
    if let Some(dev) = inner.strip_prefix('@') {
      let (name, param) = dev.split_once('[')?;
      if name.contains('.') { return None; }
      let param = param.trim_end_matches(']');
      let name = name.to_uppercase();
      return Some(if param == "i" || param == "id" && name.starts_with('D') { format!("I({name})") } else { format!("I{}({name})", param.trim_start_matches('i')) });
    }
    if inner.contains('.') { return None; }
    return Some(format!("I({})", inner.to_uppercase()));
  }
  if let Some(n) = l.strip_suffix("#branch") {
    if n.contains('.') { return None; }
    return Some(format!("I({})", n.to_uppercase()));
  }
  if !l.contains('(') && !l.contains('.') && !l.contains('#') && !l.contains('@') {
    return Some(format!("V({raw})"));
  }
  None
}

fn parse_raw(text: &str) -> Result<Value, String> {
  let mut lines = text.lines();
  let mut plot = String::new();
  let mut complex = false;
  let mut nvars = 0usize;
  let mut npts = 0usize;
  let mut vars: Vec<String> = vec![];
  while let Some(line) = lines.next() {
    if let Some(v) = line.strip_prefix("Plotname:") { plot = v.trim().to_string(); }
    else if let Some(v) = line.strip_prefix("Flags:") { complex = v.contains("complex"); }
    else if let Some(v) = line.strip_prefix("No. Variables:") { nvars = v.trim().parse().map_err(|_| "bad raw header")?; }
    else if let Some(v) = line.strip_prefix("No. Points:") { npts = v.trim().parse().map_err(|_| "bad raw header")?; }
    else if line.starts_with("Variables:") {
      for _ in 0..nvars {
        let l = lines.next().ok_or("truncated raw file")?;
        vars.push(l.split_whitespace().nth(1).unwrap_or("").to_string());
      }
    } else if line.starts_with("Values:") { break; }
  }
  let mut re = vec![Vec::with_capacity(npts); nvars];
  let mut im = vec![Vec::with_capacity(if complex { npts } else { 0 }); nvars];
  let mut k = 0usize;
  for line in lines {
    let t = line.trim();
    if t.is_empty() { continue; }
    let mut it = t.split_whitespace();
    let mut tok = it.next().unwrap();
    if k % nvars == 0 { tok = it.next().ok_or("bad raw values")?; } // leading point index
    let var = k % nvars;
    if complex {
      let (a, b) = tok.split_once(',').ok_or("bad complex value")?;
      re[var].push(a.parse::<f64>().unwrap_or(f64::NAN));
      im[var].push(b.parse::<f64>().unwrap_or(f64::NAN));
    } else {
      re[var].push(tok.parse::<f64>().unwrap_or(f64::NAN));
    }
    k += 1;
  }
  assemble(&plot, &vars, &re, &im, npts)
}

/// Plot name ("Transient Analysis" …), variables (scale first, except for op) and their
/// values → the result JSON the UI understands. Shared by the raw-file and library paths.
pub(crate) fn assemble(plot: &str, vars: &[String], re: &[Vec<f64>], im: &[Vec<f64>], npts: usize) -> Result<Value, String> {
  let kept: Vec<(usize, String)> = vars.iter().enumerate().skip(1).filter_map(|(i, v)| signal_name(v).map(|n| (i, n))).collect();
  let names: Vec<&String> = kept.iter().map(|(_, n)| n).collect();
  let lower = plot.to_lowercase();
  if lower.contains("transient") {
    Ok(json!({ "type": "tran", "time": re[0], "names": names, "data": kept.iter().map(|(i, _)| &re[*i]).collect::<Vec<_>>(), "steps_accepted": npts, "steps_rejected": 0 }))
  } else if lower.contains("ac analysis") {
    Ok(json!({ "type": "ac", "freq": re[0], "names": names,
      "re": kept.iter().map(|(i, _)| &re[*i]).collect::<Vec<_>>(), "im": kept.iter().map(|(i, _)| &im[*i]).collect::<Vec<_>>() }))
  } else if lower.contains("operating point") {
    // op has no scale vector: every variable is a value
    let all: Vec<(usize, String)> = vars.iter().enumerate().filter_map(|(i, v)| signal_name(v).map(|n| (i, n))).collect();
    Ok(json!({ "type": "op", "names": all.iter().map(|(_, n)| n).collect::<Vec<_>>(), "values": all.iter().map(|(i, _)| re[*i].first().copied().unwrap_or(f64::NAN)).collect::<Vec<_>>(), "iterations": 0, "method": "ngspice" }))
  } else if lower.contains("dc transfer") {
    Ok(json!({ "type": "dc", "sweep": re[0], "sweep_name": vars[0], "names": names, "data": kept.iter().map(|(i, _)| &re[*i]).collect::<Vec<_>>() }))
  } else {
    Err(format!("unsupported plot “{plot}”"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names() {
    assert_eq!(signal_name("v(out)").as_deref(), Some("V(out)"));
    assert_eq!(signal_name("i(v1)").as_deref(), Some("I(V1)"));
    assert_eq!(signal_name("i(@r1[i])").as_deref(), Some("I(R1)"));
    assert_eq!(signal_name("i(@q1[ic])").as_deref(), Some("Ic(Q1)"));
    assert_eq!(signal_name("v(x1.int)"), None);
    assert_eq!(signal_name("out").as_deref(), Some("V(out)"));
  }

  #[test]
  fn rc_transient_and_ac() {
    if find_ngspice(None).is_none() { return; }
    let r: Value = serde_json::from_str(&run("rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2) AC 1\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 5m 0 10u", None).unwrap()).unwrap();
    let t = r["time"].as_array().unwrap();
    let k = r["names"].as_array().unwrap().iter().position(|n| n == "V(out)").unwrap();
    let v = r["data"][k].as_array().unwrap();
    // at t = τ = 1 ms the capacitor is at 1 − 1/e
    let j = t.iter().position(|x| x.as_f64().unwrap() >= 1e-3).unwrap();
    assert!((v[j].as_f64().unwrap() - 0.632).abs() < 0.01);
    let a: Value = serde_json::from_str(&run("rc\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 20 10 10k", None).unwrap()).unwrap();
    assert_eq!(a["type"], "ac");
    let o: Value = serde_json::from_str(&run("div\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op", None).unwrap()).unwrap();
    let k = o["names"].as_array().unwrap().iter().position(|n| n == "V(out)").unwrap();
    assert!((o["values"][k].as_f64().unwrap() - 5.0).abs() < 1e-9);
  }
}
