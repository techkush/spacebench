//! ESP32 sketches on Espressif's QEMU (qemu-system-xtensa, https://github.com/espressif/qemu).
//! UART0 is the Serial Monitor (stdin / stdout); UART2 carries the Space Bench bridge — pin
//! activity from the firmware and input levels to it — over a local TCP socket.
//! One session at a time; the UI polls it ~30 times a second.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

struct Session { child: Child, stdin: ChildStdin, bridge: Option<TcpStream>, qmp: Option<std::io::BufReader<TcpStream>>, serial: Arc<Mutex<Vec<u8>>>, pins: Arc<Mutex<Vec<u8>>>, log: Arc<Mutex<String>> }
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn runnable(p: &std::path::Path) -> bool {
  #[cfg(unix)]
  { use std::os::unix::fs::PermissionsExt; std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false) }
  #[cfg(not(unix))]
  { p.is_file() }
}

/// qemu-system-xtensa: the custom path, PATH, ESP-IDF's tools folder, Space Bench's own install.
pub fn find(custom: Option<&str>) -> Option<PathBuf> { find_arch(custom, "xtensa") }

/// Espressif's QEMU for an architecture: "xtensa" (ESP32, ESP32-S3) or "riscv32" (ESP32-C3).
pub fn find_arch(custom: Option<&str>, arch: &str) -> Option<PathBuf> {
  if arch == "xtensa" { if let Some(p) = custom.map(str::trim).filter(|p| !p.is_empty()) { let p = PathBuf::from(p); return runnable(&p).then_some(p); } }
  let exe = if cfg!(windows) { format!("qemu-system-{arch}.exe") } else { format!("qemu-system-{arch}") };
  // Espressif's builds first (Space Bench's install, then ESP-IDF's): Homebrew's qemu-system-xtensa
  // (installed with QEMU for the Pi boards) has no ESP32 machines
  let mut dirs: Vec<PathBuf> = Vec::new();
  let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
  for root in [home.join(format!("Library/Application Support/Space Bench/qemu-{arch}")), home.join(format!(".espressif/tools/qemu-{arch}"))] {
    if let Ok(rd) = std::fs::read_dir(&root) {
      let mut v: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
      v.sort(); v.reverse();
      for d in v { dirs.push(d.join("qemu/bin")); }
    }
  }
  if let Some(p) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&p)); }
  for d in ["/opt/homebrew/bin", "/usr/local/bin"] { dirs.push(PathBuf::from(d)); }
  dirs.into_iter().map(|d| d.join(&exe)).find(|p| runnable(p))
}

pub fn status(custom: Option<&str>) -> Result<String, String> {
  let bin = find(custom).ok_or_else(not_found)?;
  let out = Command::new(&bin).arg("--version").output().map_err(|e| e.to_string())?;
  Ok(format!("{} · {}", String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim(), bin.display()))
}

fn not_found() -> String {
  "Espressif's QEMU (qemu-system-xtensa) was not found. Install it from Settings → Microcontrollers (or with ESP-IDF: idf_tools.py install qemu-xtensa).".into()
}

/// Download Espressif's prebuilt QEMU for this computer into Space Bench's folder: the Xtensa
/// build (ESP32, ESP32-S3) and the RISC-V one (ESP32-C3), ≈ 4 MB each.
pub fn install() -> Result<String, String> {
  let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
  let os = if cfg!(target_os = "macos") { "apple-darwin" } else if cfg!(target_os = "linux") { "linux-gnu" } else { return Err("Automatic install is for macOS and Linux; on Windows use ESP-IDF's installer.".into()) };
  let tag = "esp-develop-9.2.2-20260417";
  let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
  for cpu in ["xtensa", "riscv32"] {
    let file = format!("qemu-{cpu}-softmmu-esp_develop_9.2.2_20260417-{arch}-{os}.tar.xz");
    let url = format!("https://github.com/espressif/qemu/releases/download/{tag}/{file}");
    let dest = home.join(format!("Library/Application Support/Space Bench/qemu-{cpu}/9.2.2"));
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let tar = dest.join(&file);
    let ok = Command::new("curl").args(["-fsSL", "-o"]).arg(&tar).arg(&url).status().map_err(|e| e.to_string())?;
    if !ok.success() { return Err(format!("Download failed: {url}")); }
    let ok = Command::new("tar").arg("-xJf").arg(&tar).arg("-C").arg(&dest).status().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tar);
    if !ok.success() { return Err("Could not unpack QEMU".into()); }
  }
  status(None)
}

/// `machine`: "esp32", "esp32s3" (both qemu-system-xtensa) or "esp32c3" (qemu-system-riscv32).
pub fn start(image: &str, custom: Option<&str>, machine: &str) -> Result<(), String> {
  stop();
  let bin = if machine == "esp32c3" {
    find_arch(None, "riscv32").ok_or("Espressif's QEMU for RISC-V (qemu-system-riscv32) was not found — install it from Settings → Microcontrollers")?
  } else { find(custom).ok_or_else(not_found)? };
  // QEMU writes the flash (NVS, SPIFFS): run on a copy so the compiled image stays clean
  let dir = std::env::temp_dir().join("spacebench-esp32");
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let flash = dir.join("flash.bin");
  std::fs::copy(image, &flash).map_err(|e| format!("Could not copy the firmware image: {e}"))?;
  let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| e.to_string())?;
  // the bridge is UART2 on the ESP32, UART1 on the S3 / C3 (QEMU wires only UART0 and UART1 there)
  let bridge = format!("tcp:127.0.0.1:{port},server=on,wait=off");
  // QMP: schematics pause the chip while the circuit simulates (lockstep)
  let qport = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| e.to_string())?;
  let mut cmd = Command::new(&bin);
  cmd.args(["-nographic", "-monitor", "none", "-nic", "none", "-qmp"]).arg(format!("tcp:127.0.0.1:{qport},server=on,wait=off"))
    .arg("-drive").arg(format!("file={},if=mtd,format=raw", flash.display()));
  match machine {
    "esp32" => { cmd.args(["-machine", "esp32", "-m", "4M", "-serial", "stdio", "-serial", "null", "-serial"]).arg(&bridge); }
    "esp32c3" => { cmd.args(["-machine", "esp32c3", "-icount", "3", "-serial", "stdio", "-serial"]).arg(&bridge); }
    m => { cmd.args(["-machine", m, "-serial", "stdio", "-serial"]).arg(&bridge); }
  }
  let mut child = cmd
    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
    .spawn().map_err(|e| format!("Could not start QEMU: {e}"))?;
  let stdin = child.stdin.take().ok_or("no stdin")?;
  let serial = Arc::new(Mutex::new(Vec::new()));
  let pins = Arc::new(Mutex::new(Vec::new()));
  let log = Arc::new(Mutex::new(String::new()));
  let pump = |mut r: Box<dyn Read + Send>, buf: Arc<Mutex<Vec<u8>>>| { std::thread::spawn(move || { let mut b = [0u8; 4096]; while let Ok(n) = r.read(&mut b) { if n == 0 { break } buf.lock().unwrap().extend_from_slice(&b[..n]); } }); };
  pump(Box::new(child.stdout.take().ok_or("no stdout")?), serial.clone());
  { let log = log.clone(); let mut err = child.stderr.take().ok_or("no stderr")?; std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); log.lock().unwrap().push_str(&s); }); }
  let mut bridge = None;
  for _ in 0..50 {
    if let Ok(s) = TcpStream::connect(("127.0.0.1", port)) { bridge = Some(s); break }
    std::thread::sleep(std::time::Duration::from_millis(40));
  }
  let bridge = bridge.ok_or("QEMU's bridge port did not open")?;
  pump(Box::new(bridge.try_clone().map_err(|e| e.to_string())?), pins.clone());
  let mut qmp = None;
  for _ in 0..50 {
    if let Ok(s) = TcpStream::connect(("127.0.0.1", qport)) {
      let mut r = std::io::BufReader::new(s);
      let mut greeting = String::new();
      use std::io::BufRead;
      if r.read_line(&mut greeting).is_ok() { qmp = Some(r); }
      break
    }
    std::thread::sleep(std::time::Duration::from_millis(40));
  }
  *SESSION.lock().unwrap() = Some(Session { child, stdin, bridge: Some(bridge), qmp, serial, pins, log });
  let _ = qmp_cmd("qmp_capabilities");
  Ok(())
}

/// A QMP command ("stop" pauses the chip and its clock, "cont" resumes it).
pub fn qmp_cmd(cmd: &str) -> Result<(), String> {
  use std::io::BufRead;
  let mut g = SESSION.lock().unwrap();
  let q = g.as_mut().and_then(|s| s.qmp.as_mut()).ok_or("The ESP32 is not running")?;
  q.get_mut().write_all(format!("{{\"execute\":\"{cmd}\"}}\n").as_bytes()).map_err(|e| e.to_string())?;
  loop {
    let mut line = String::new();
    if q.read_line(&mut line).map_err(|e| e.to_string())? == 0 { return Err("QMP closed".into()); }
    if line.contains("\"return\"") { return Ok(()); }
    if line.contains("\"error\"") { return Err(line); }
  }
}

#[derive(serde::Serialize)]
pub struct Poll { serial: String, bridge: Vec<u8>, running: bool, log: String }

pub fn poll() -> Poll {
  let mut g = SESSION.lock().unwrap();
  let Some(s) = g.as_mut() else { return Poll { serial: String::new(), bridge: vec![], running: false, log: String::new() } };
  let serial = String::from_utf8_lossy(&std::mem::take(&mut *s.serial.lock().unwrap())).into_owned();
  let bridge = std::mem::take(&mut *s.pins.lock().unwrap());
  let running = matches!(s.child.try_wait(), Ok(None));
  let log = if running { String::new() } else { s.log.lock().unwrap().clone() };
  Poll { serial, bridge, running, log }
}

pub fn send(serial: Option<String>, bridge: Option<Vec<u8>>) -> Result<(), String> {
  let mut g = SESSION.lock().unwrap();
  let s = g.as_mut().ok_or("The ESP32 is not running")?;
  if let Some(t) = serial { s.stdin.write_all(t.as_bytes()).map_err(|e| e.to_string())?; let _ = s.stdin.flush(); }
  if let (Some(b), Some(sock)) = (bridge, s.bridge.as_mut()) { sock.write_all(&b).map_err(|e| e.to_string())?; }
  Ok(())
}

pub fn stop() {
  if let Some(mut s) = SESSION.lock().unwrap().take() { let _ = s.child.kill(); let _ = s.child.wait(); }
}
