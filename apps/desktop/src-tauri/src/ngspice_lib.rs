//! ngspice as a shared library (libngspice): loaded at runtime, one engine per process.
//! A run loads the deck (`ngSpice_Circ`), simulates in ngspice's background thread
//! (`bg_run`) and streams progress and data points to the UI as events; at the end the
//! vectors are read back into the same JSON the `ngspice -b` path returns. A new run halts
//! the one before (Live mode), and a running circuit can be altered and resumed.
use std::ffi::{c_char, c_int, c_short, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use libloading::{Library, Symbol};
use serde_json::json;
#[cfg(test)]
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::ngspice::{assemble, signal_name};

const TIMEOUT: Duration = Duration::from_secs(120);
const EMIT_EVERY: Duration = Duration::from_millis(33);

// ---------------------------------------------------------------- C interface (sharedspice.h)

#[repr(C)]
struct NgComplex { re: f64, im: f64 }
#[repr(C)]
struct VectorInfo { v_name: *mut c_char, v_type: c_int, v_flags: c_short, v_realdata: *mut f64, v_compdata: *mut NgComplex, v_length: c_int }
#[repr(C)]
struct VecValues { name: *mut c_char, creal: f64, cimag: f64, is_scale: bool, is_complex: bool }
#[repr(C)]
struct VecValuesAll { veccount: c_int, vecindex: c_int, vecsa: *mut *mut VecValues }
#[repr(C)]
struct VecInfo { number: c_int, vecname: *mut c_char, is_real: bool, pdvec: *mut c_void, pdvecscale: *mut c_void }
#[repr(C)]
struct VecInfoAll { name: *mut c_char, title: *mut c_char, date: *mut c_char, typename: *mut c_char, veccount: c_int, vecs: *mut *mut VecInfo }

type SendChar = extern "C" fn(*mut c_char, c_int, *mut c_void) -> c_int;
type SendStat = extern "C" fn(*mut c_char, c_int, *mut c_void) -> c_int;
type ControlledExit = extern "C" fn(c_int, bool, bool, c_int, *mut c_void) -> c_int;
type SendData = extern "C" fn(*mut VecValuesAll, c_int, c_int, *mut c_void) -> c_int;
type SendInitData = extern "C" fn(*mut VecInfoAll, c_int, *mut c_void) -> c_int;
type BgThreadRunning = extern "C" fn(bool, c_int, *mut c_void) -> c_int;

struct Api {
  _lib: Library,
  path: PathBuf,
  command: unsafe extern "C" fn(*mut c_char) -> c_int,
  circ: unsafe extern "C" fn(*mut *mut c_char) -> c_int,
  vec_info: unsafe extern "C" fn(*mut c_char) -> *mut VectorInfo,
  cur_plot: unsafe extern "C" fn() -> *mut c_char,
  all_vecs: unsafe extern "C" fn(*mut c_char) -> *mut *mut c_char,
  running: unsafe extern "C" fn() -> bool,
}
// the function pointers are plain C entry points; ngspice itself guards its state
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

impl Api {
  fn cmd(&self, c: &str) -> c_int {
    let s = CString::new(c).unwrap_or_default();
    unsafe { (self.command)(s.as_ptr() as *mut c_char) }
  }
}

/// Where libngspice may be: an explicit path, next to the ngspice program, env, usual places.
pub fn candidates(custom_bin: Option<&str>) -> Vec<PathBuf> {
  let name = if cfg!(target_os = "macos") { "libngspice.dylib" } else if cfg!(windows) { "ngspice.dll" } else { "libngspice.so" };
  let mut out = vec![];
  if let Ok(p) = std::env::var("SPICEBENCH_LIBNGSPICE") { out.push(PathBuf::from(p)); }
  if let Some(bin) = custom_bin.map(str::trim).filter(|b| !b.is_empty()) {
    // …/bin/ngspice → …/lib/libngspice.*
    if let Some(prefix) = Path::new(bin).parent().and_then(Path::parent) { out.push(prefix.join("lib").join(name)); }
  }
  for d in ["/opt/homebrew/lib", "/usr/local/lib", "/usr/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "C:\\Program Files\\Spice64\\bin-dll"] {
    out.push(Path::new(d).join(name));
  }
  if cfg!(target_os = "linux") { out.push(PathBuf::from("/usr/lib/x86_64-linux-gnu/libngspice.so.0")); }
  out
}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn api(custom_bin: Option<&str>) -> Result<&'static Api, String> {
  API.get_or_init(|| load(custom_bin)).as_ref().map_err(Clone::clone)
}

fn load(custom_bin: Option<&str>) -> Result<Api, String> {
  let path = candidates(custom_bin).into_iter().find(|p| p.is_file()).ok_or("libngspice was not found")?;
  unsafe {
    let lib = Library::new(&path).map_err(|e| format!("could not load {}: {e}", path.display()))?;
    macro_rules! sym { ($n:literal) => {{ let s: Symbol<_> = lib.get($n).map_err(|e| format!("libngspice: {e}"))?; *s }} }
    let init: unsafe extern "C" fn(Option<SendChar>, Option<SendStat>, Option<ControlledExit>, Option<SendData>, Option<SendInitData>, Option<BgThreadRunning>, *mut c_void) -> c_int = sym!(b"ngSpice_Init\0");
    let api = Api {
      command: sym!(b"ngSpice_Command\0"),
      circ: sym!(b"ngSpice_Circ\0"),
      vec_info: sym!(b"ngGet_Vec_Info\0"),
      cur_plot: sym!(b"ngSpice_CurPlot\0"),
      all_vecs: sym!(b"ngSpice_AllVecs\0"),
      running: sym!(b"ngSpice_running\0"),
      path: path.clone(),
      _lib: lib,
    };
    if init(Some(on_char), Some(on_stat), Some(on_exit), Some(on_data), Some(on_init_data), Some(on_bg), std::ptr::null_mut()) != 0 {
      return Err("ngSpice_Init failed".into());
    }
    Ok(api)
  }
}

pub fn available(custom_bin: Option<&str>) -> Result<String, String> {
  let a = api(custom_bin)?;
  Ok(a.path.display().to_string())
}

// ---------------------------------------------------------------- state shared with the callbacks

#[derive(Default)]
struct Shared {
  log: Vec<String>,
  /// the background thread has started / finished for the current run
  started: bool,
  finished: bool,
  /// ngspice called its exit callback (a fatal error)
  exited: bool,
  scale: Option<String>,
  plot_label: String,
  run: Option<String>,
  /// a Live re-run: the next Live run may halt it
  live: bool,
  app: Option<AppHandle>,
  // streaming
  names: Vec<String>,
  keep: Vec<usize>,
  rows: Vec<Vec<f64>>,
  last_points: Option<Instant>,
  last_stat: Option<Instant>,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static WAKE: Condvar = Condvar::new();
/// one run at a time; a new run first halts the current one
static RUN_LOCK: Mutex<()> = Mutex::new(());
/// set while we pause the engine ourselves (halt for alter), so the waiter doesn't finish
static CANCEL: Mutex<Option<String>> = Mutex::new(None);

fn shared() -> MutexGuard<'static, Option<Shared>> {
  SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

fn cstr(p: *const c_char) -> String {
  if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() }
}

extern "C" fn on_char(s: *mut c_char, _id: c_int, _u: *mut c_void) -> c_int {
  let line = cstr(s);
  let line = line.strip_prefix("stdout ").or_else(|| line.strip_prefix("stderr ")).unwrap_or(&line).to_string();
  if let Some(sh) = shared().as_mut() {
    if sh.log.len() < 2000 { sh.log.push(line); }
  }
  0
}

extern "C" fn on_stat(s: *mut c_char, _id: c_int, _u: *mut c_void) -> c_int {
  let text = cstr(s);
  let mut g = shared();
  let Some(sh) = g.as_mut() else { return 0 };
  let due = sh.last_stat.is_none_or(|t| t.elapsed() >= EMIT_EVERY);
  if let (true, Some(app), Some(run)) = (due, sh.app.as_ref(), sh.run.as_ref()) {
    // "tran: 45.3%" → 0.453
    let pct = text.rsplit(' ').next().and_then(|p| p.trim_end_matches('%').parse::<f64>().ok());
    let _ = app.emit("ngspice://progress", json!({ "run": run, "text": text, "fraction": pct.map(|p| p / 100.0) }));
    sh.last_stat = Some(Instant::now());
  }
  0
}

extern "C" fn on_exit(_status: c_int, _unload: bool, _quit: bool, _id: c_int, _u: *mut c_void) -> c_int {
  if let Some(sh) = shared().as_mut() { sh.exited = true; sh.finished = true; }
  WAKE.notify_all();
  0
}

extern "C" fn on_init_data(p: *mut VecInfoAll, _id: c_int, _u: *mut c_void) -> c_int {
  if p.is_null() { return 0; }
  let all = unsafe { &*p };
  let vecs: Vec<&VecInfo> = (0..all.veccount.max(0) as usize).filter_map(|i| unsafe { (*all.vecs.add(i)).as_ref() }).collect();
  // the scale is the vector that is its own scale
  let scale = vecs.iter().find(|v| !v.pdvec.is_null() && v.pdvec == v.pdvecscale).map(|v| cstr(v.vecname));
  if let Some(sh) = shared().as_mut() {
    sh.scale = scale;
    sh.plot_label = cstr(all.name);
    sh.names.clear();
    sh.keep.clear();
    sh.rows.clear();
  }
  0
}

extern "C" fn on_data(p: *mut VecValuesAll, _n: c_int, _id: c_int, _u: *mut c_void) -> c_int {
  if p.is_null() { return 0; }
  let all = unsafe { &*p };
  let mut g = shared();
  let Some(sh) = g.as_mut() else { return 0 };
  if sh.app.is_none() { return 0; }
  let vals: Vec<&VecValues> = (0..all.veccount.max(0) as usize).filter_map(|i| unsafe { (*all.vecsa.add(i)).as_ref() }).collect();
  if sh.names.is_empty() {
    // first point: decide which vectors to stream (scale first, then UI-visible signals)
    let mut keep = vec![];
    let mut names = vec![];
    if let Some(k) = vals.iter().position(|v| v.is_scale) { keep.push(k); names.push("scale".to_string()); }
    for (k, v) in vals.iter().enumerate() {
      if v.is_scale { continue; }
      if let Some(n) = signal_name(&cstr(v.name)) { keep.push(k); names.push(n); }
    }
    sh.keep = keep;
    sh.names = names;
  }
  let row: Vec<f64> = sh.keep.iter().map(|&k| vals.get(k).map_or(f64::NAN, |v| v.creal)).collect();
  sh.rows.push(row);
  if sh.last_points.is_none_or(|t| t.elapsed() >= EMIT_EVERY) { flush_points(sh); }
  0
}

fn flush_points(sh: &mut Shared) {
  if sh.rows.is_empty() { return; }
  if let (Some(app), Some(run)) = (sh.app.as_ref(), sh.run.as_ref()) {
    let _ = app.emit("ngspice://points", json!({ "run": run, "names": sh.names, "rows": sh.rows }));
  }
  sh.rows.clear();
  sh.last_points = Some(Instant::now());
}

extern "C" fn on_bg(not_running: bool, _id: c_int, _u: *mut c_void) -> c_int {
  if let Some(sh) = shared().as_mut() {
    if not_running { sh.finished = true; } else { sh.started = true; }
  }
  WAKE.notify_all();
  0
}

// ---------------------------------------------------------------- runs

/// Halt the run simulating now: `Some(id)` only that run (Stop); `None` only a Live run (a
/// newer Live run replaces it). Sweeps and manual runs are never halted by `None`.
/// Returns whether a run was halted.
pub fn halt(run: Option<&str>, custom_bin: Option<&str>) -> bool {
  let Ok(a) = api(custom_bin) else { return false };
  let (current, live) = shared().as_ref().map(|s| (s.run.clone(), s.live)).unwrap_or((None, false));
  if current.is_none() || current.as_deref() == CANCEL.lock().unwrap_or_else(|e| e.into_inner()).as_deref() { return false; }
  match run { Some(r) if Some(r) != current.as_deref() => return false, None if !live => return false, _ => {} }
  *CANCEL.lock().unwrap_or_else(|e| e.into_inner()) = current;
  if unsafe { (a.running)() } { a.cmd("bg_halt"); }
  WAKE.notify_all();
  true
}

/// Change a device or model parameter of the running circuit and carry on (live inputs).
/// `alter` is an ngspice alter / altermod argument, e.g. `r1 resistance=2k`.
pub fn alter(command: &str, custom_bin: Option<&str>) -> Result<(), String> {
  let a = api(custom_bin)?;
  if !command.chars().all(|c| c.is_ascii_alphanumeric() || " =.@[]_-+".contains(c)) { return Err("bad alter command".into()); }
  let was = unsafe { (a.running)() };
  if was {
    // pause without finishing the run: the waiter ignores this halt
    if let Some(sh) = shared().as_mut() { sh.started = false; }
    a.cmd("bg_halt");
    wait_until(|s| s.finished || s.exited, Duration::from_secs(2));
    if let Some(sh) = shared().as_mut() { sh.finished = false; }
  }
  let rc = a.cmd(&format!("alter {command}"));
  if was { a.cmd("bg_resume"); }
  if rc != 0 { Err(format!("alter {command} failed")) } else { Ok(()) }
}

fn wait_until(done: impl Fn(&Shared) -> bool, max: Duration) -> bool {
  let start = Instant::now();
  let mut g = shared();
  loop {
    if g.as_ref().is_some_and(&done) { return true; }
    let left = max.saturating_sub(start.elapsed());
    if left.is_zero() { return false; }
    g = WAKE.wait_timeout(g, left.min(Duration::from_millis(20))).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
  }
}

/// Run `netlist` (one analysis line, no `.end`) — same contract and JSON as `ngspice::run`.
/// `live`: a Live re-run, which halts an older Live run and may itself be halted by a newer one.
pub fn run(netlist: &str, custom_bin: Option<&str>, app: Option<AppHandle>, run_id: Option<String>, live: bool) -> Result<String, String> {
  let a = api(custom_bin)?;
  if live { halt(None, custom_bin); }
  let _turn = RUN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  *CANCEL.lock().unwrap_or_else(|e| e.into_inner()) = None;
  let started = Instant::now();
  let id = run_id.clone().unwrap_or_else(|| format!("lib{}", started.elapsed().as_nanos()));
  *shared() = Some(Shared { run: Some(id.clone()), live, app, ..Default::default() });

  // drop the previous circuit and its plots
  trace("remcirc");
  a.cmd("remcirc");
  trace("destroy");
  a.cmd("destroy all");
  let mut lines: Vec<CString> = netlist.trim_end().lines().chain(std::iter::once(".end")).map(|l| CString::new(l).unwrap_or_default()).collect();
  if lines.len() < 2 { return Err("empty netlist".into()); }
  let mut ptrs: Vec<*mut c_char> = lines.iter_mut().map(|l| l.as_ptr() as *mut c_char).collect();
  ptrs.push(std::ptr::null_mut());
  trace("circ");
  let rc = unsafe { (a.circ)(ptrs.as_mut_ptr()) };
  trace(&format!("circ rc={rc} log={:?}", shared().as_ref().map(|s| s.log.clone())));
  let log_now = || shared().as_ref().map(|s| s.log.clone()).unwrap_or_default();
  // a line ngspice skipped means a wrong (or empty) circuit — and simulating an empty
  // circuit crashes libngspice — so anything it ignored stops the run here
  let parse_errors: Vec<String> = log_now().into_iter().filter(|l| {
    let lo = l.to_lowercase();
    lo.contains("error on line") || lo.contains("circuit not parsed") || lo.contains("ignored!") || lo.contains("unknown device") || lo.starts_with("error")
  }).collect();
  if rc != 0 || !parse_errors.is_empty() {
    return Err(if parse_errors.is_empty() { "ngspice could not parse the circuit".into() } else { parse_errors.join("\n") });
  }

  trace("bg_run");
  a.cmd("bg_run");
  // wait for the background thread: started → finished; a thread that never starts means a setup error
  let began = wait_until(|s| s.started || s.finished, Duration::from_secs(5));
  let ok = began && wait_until(|s| s.finished, TIMEOUT);
  let cancelled = CANCEL.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(id.as_str());
  if !ok {
    a.cmd("bg_halt");
    return Err(format!("ngspice did not finish within {} s", TIMEOUT.as_secs()));
  }
  if let Some(sh) = shared().as_mut() { flush_points(sh); }
  if cancelled { return Err("cancelled".into()); }

  let (log, label, scale, exited) = {
    let g = shared();
    let s = g.as_ref().ok_or("lost run state")?;
    (s.log.clone(), s.plot_label.clone(), s.scale.clone(), s.exited)
  };
  if exited { return Err(messages(&log).unwrap_or_else(|| "ngspice stopped with an error".into())); }

  let plot = cstr(unsafe { (a.cur_plot)() });
  let kind = plot.trim_end_matches(char::is_numeric);
  let label = if label.is_empty() { match kind { "tran" => "Transient Analysis", "ac" => "AC Analysis", "op" => "Operating Point", "dc" => "DC transfer characteristic", _ => "" }.to_string() } else { label };
  if !matches!(kind, "tran" | "ac" | "op" | "dc") {
    return Err(messages(&log).unwrap_or_else(|| format!("no result (plot “{plot}”)")));
  }
  // read every vector of the plot; scale first (op has none)
  let plot_c = CString::new(plot.clone()).unwrap_or_default();
  let list = unsafe { (a.all_vecs)(plot_c.as_ptr() as *mut c_char) };
  let mut names = vec![];
  let mut k = 0;
  while !list.is_null() {
    let p = unsafe { *list.add(k) };
    if p.is_null() { break; }
    names.push(cstr(p));
    k += 1;
  }
  if kind != "op" {
    let s = scale.filter(|s| names.contains(s)).or_else(|| ["time", "frequency"].iter().map(|s| s.to_string()).find(|s| names.contains(s))).or_else(|| names.last().cloned());
    if let Some(s) = s { names.retain(|n| *n != s); names.insert(0, s); }
  }
  let (mut re, mut im) = (vec![], vec![]);
  let mut npts = 0;
  for n in &names {
    let full = CString::new(format!("{plot}.{n}")).unwrap_or_default();
    let info = unsafe { (a.vec_info)(full.as_ptr() as *mut c_char).as_ref() };
    let (r, i) = match info {
      Some(v) if v.v_length > 0 && !v.v_realdata.is_null() => (unsafe { std::slice::from_raw_parts(v.v_realdata, v.v_length as usize) }.to_vec(), vec![]),
      Some(v) if v.v_length > 0 && !v.v_compdata.is_null() => {
        let c = unsafe { std::slice::from_raw_parts(v.v_compdata, v.v_length as usize) };
        (c.iter().map(|z| z.re).collect(), c.iter().map(|z| z.im).collect())
      }
      _ => (vec![], vec![]),
    };
    npts = npts.max(r.len());
    re.push(r);
    im.push(i);
  }
  let mut v = assemble(&label, &names, &re, &im, npts)?;
  v["log"] = json!(filtered(&log));
  v["elapsed_ms"] = json!(started.elapsed().as_secs_f64() * 1e3);
  v["engine"] = json!("libngspice");
  Ok(v.to_string())
}

fn trace(m: &str) { if std::env::var_os("SB_TRACE").is_some() { eprintln!("[ngspice_lib] {m}"); } }

fn filtered(log: &[String]) -> Vec<&str> {
  log.iter().map(|l| l.trim()).filter(|l| {
    let lo = l.to_lowercase();
    !l.is_empty() && (lo.contains("error") || lo.contains("warning") || l.contains("singular") || l.contains("Timestep too small"))
  }).take(30).collect()
}

fn messages(log: &[String]) -> Option<String> {
  let m = filtered(log);
  (!m.is_empty()).then(|| m.join("\n"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn num(v: &Value, name: &str, i: usize) -> f64 {
    let k = v["names"].as_array().unwrap().iter().position(|n| n == name).unwrap_or_else(|| panic!("{name} missing in {}", v["names"]));
    v["data"][k][i].as_f64().unwrap()
  }

  /// Same circuits through both back ends: identical names, matching values.
  #[test]
  fn library_matches_program() {
    if api(None).is_err() || crate::ngspice::find_ngspice(None).is_none() { return; }
    let rc = "rc\n.options savecurrents\nV1 in 0 PULSE(0 1 0 1n 1n 1 2) AC 1\nR1 in out 1k\nC1 out 0 1u";
    for analysis in [".tran 10u 5m 0 10u", ".ac dec 20 10 10k", ".op", ".dc V1 0 5 0.5"] {
      // like the app: device currents for everything but AC
      let deck = if analysis.starts_with(".ac") { format!("{rc}\n{analysis}").replace(".options savecurrents\n", "") } else { format!("{rc}\n{analysis}") };
      let lib: Value = serde_json::from_str(&run(&deck, None, None, None, false).unwrap()).unwrap();
      let cli: Value = serde_json::from_str(&crate::ngspice::run(&deck, None).unwrap()).unwrap();
      assert_eq!(lib["type"], cli["type"], "{analysis}");
      // same signals (order may differ) with matching values
      let sorted = |v: &Value| { let mut n: Vec<String> = v["names"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect(); n.sort(); n };
      assert_eq!(sorted(&lib), sorted(&cli), "{analysis}");
      let series = |v: &Value, key: &str, name: &str| -> Vec<f64> {
        let k = v["names"].as_array().unwrap().iter().position(|n| n == name).unwrap();
        let x = &v[key][k];
        x.as_array().map(|a| a.iter().filter_map(|y| y.as_f64()).collect()).unwrap_or_else(|| x.as_f64().into_iter().collect())
      };
      let close = |a: &[f64], b: &[f64], what: &str| {
        assert_eq!(a.len(), b.len(), "{analysis} {what}");
        // the raw file prints 15 significant digits
        for (x, y) in a.iter().zip(b) { assert!((x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1e-12), "{analysis} {what}: {x} vs {y}"); }
      };
      let scale = |v: &Value, key: &str| v[key].as_array().map(|a| a.iter().filter_map(|y| y.as_f64()).collect::<Vec<_>>()).unwrap_or_default();
      for key in ["time", "freq", "sweep"] { close(&scale(&lib, key), &scale(&cli, key), key); }
      let keys: &[&str] = match lib["type"].as_str().unwrap() { "op" => &["values"], "ac" => &["re", "im"], _ => &["data"] };
      for name in sorted(&lib) { for key in keys { close(&series(&lib, key, &name), &series(&cli, key, &name), &format!("{key} {name}")); } }
    }
    let t: Value = serde_json::from_str(&run(&format!("{rc}\n.tran 10u 5m 0 10u"), None, None, None, false).unwrap()).unwrap();
    let j = t["time"].as_array().unwrap().iter().position(|x| x.as_f64().unwrap() >= 1e-3).unwrap();
    assert!((num(&t, "V(out)", j) - 0.632).abs() < 0.01);
    assert!(t["names"].as_array().unwrap().iter().any(|n| n == "I(R1)"));
  }

  #[test]
  fn parse_error() {
    if api(None).is_err() { return; }
    let e = run("bad\nR1 a 0\n.op", None, None, None, false).unwrap_err();
    assert!(e.contains("not a valid resistor"), "{e}");
    // the engine is still fine afterwards
    let ok = run("div\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op", None, None, None, false);
    assert!(ok.is_ok(), "{ok:?}");
  }

  #[test]
  fn halt_by_next_run() {
    if api(None).is_err() { return; }
    // a long transient is halted by the next run, which still succeeds
    let long = "long\nV1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 5 0 10u";
    let h = std::thread::spawn(move || run(long, None, None, Some("long".into()), true));
    std::thread::sleep(Duration::from_millis(300));
    let t0 = Instant::now();
    let ok = run("div\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op", None, None, None, true).unwrap();
    assert!(t0.elapsed() < Duration::from_secs(3), "halt took {:?}", t0.elapsed());
    assert_eq!(h.join().unwrap().unwrap_err(), "cancelled");
    let v: Value = serde_json::from_str(&ok).unwrap();
    let k = v["names"].as_array().unwrap().iter().position(|n| n == "V(out)").unwrap();
    assert!((v["values"][k].as_f64().unwrap() - 5.0).abs() < 1e-9);
  }
}

#[cfg(test)]
mod bench {
  #[test]
  #[ignore]
  fn speed() {
    let deck = "rc\n.options savecurrents\nV1 in 0 PULSE(0 1 0 1n 1n 1m 2m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 10m 0 10u";
    let t = std::time::Instant::now();
    for _ in 0..20 { super::run(deck, None, None, None, false).unwrap(); }
    let lib = t.elapsed().as_secs_f64() * 1e3 / 20.0;
    let t = std::time::Instant::now();
    for _ in 0..20 { crate::ngspice::run(deck, None).unwrap(); }
    let cli = t.elapsed().as_secs_f64() * 1e3 / 20.0;
    eprintln!("BENCH library {lib:.1} ms/run · program {cli:.1} ms/run");
  }
}
