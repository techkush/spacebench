//! Linux boards (Raspberry Pi 5 / 4 / 3 / Zero 2 W): a QEMU "virt" VM on the host's hypervisor
//! (Hypervisor.framework on macOS, KVM on Linux). The console, QMP and the Space Bench agent's
//! virtio-serial port are unix sockets; the UI polls them ~30 times a second (src/linux/).
//! The dev server mirrors this in vite-linux.ts.
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

#[derive(serde::Deserialize)]
pub struct StartOptions {
  disk: String,
  kernel: Option<String>,
  initrd: Option<String>,
  append: Option<String>,
  credentials: Option<Vec<String>>,
  memory: Option<u32>,
  cpus: Option<u32>,
}

struct Session {
  child: Child,
  console: UnixStream,
  agent: UnixStream,
  qmp: BufReader<UnixStream>,
  out: Arc<Mutex<Vec<u8>>>,
  lines: Arc<Mutex<Vec<u8>>>,
  log: Arc<Mutex<String>>,
  dir: PathBuf,
}
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

pub fn dir() -> PathBuf { PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support/Space Bench/linux") }

fn safe(name: &str) -> Result<PathBuf, String> {
  if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) || name.starts_with('.') { return Err(format!("bad file name {name}")); }
  Ok(dir().join(name))
}

pub fn find() -> Option<PathBuf> {
  let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  for d in ["/opt/homebrew/bin", "/usr/local/bin"] { dirs.push(PathBuf::from(d)); }
  dirs.into_iter().map(|d| d.join("qemu-system-aarch64")).find(|p| p.is_file())
}

#[derive(serde::Serialize)]
pub struct Status { qemu: Option<String>, dir: String, files: std::collections::HashMap<String, bool>, boot: Option<serde_json::Value> }

pub fn status() -> Status {
  let qemu = find().and_then(|b| {
    let out = Command::new(&b).arg("--version").output().ok()?;
    Some(format!("{} · {}", String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim(), b.display()))
  });
  let files = ["debian.qcow2", "pi.qcow2", "vmlinuz", "initrd.img", "boot.json"].iter().map(|f| (f.to_string(), dir().join(f).exists())).collect();
  let boot = std::fs::read_to_string(dir().join("boot.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
  Status { qemu, dir: dir().display().to_string(), files, boot }
}

pub fn fetch(url: &str, name: &str) -> Result<(), String> {
  std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
  let dest = safe(name)?;
  let part = dest.with_extension("part");
  let ok = Command::new("curl").args(["-fsSL", "--retry", "3", "-o"]).arg(&part).arg(url).status().map_err(|e| e.to_string())?;
  if !ok.success() { return Err(format!("Download failed: {url}")); }
  std::fs::rename(&part, &dest).map_err(|e| e.to_string())
}

pub fn disk(base: &str, name: &str, size: &str) -> Result<(), String> {
  let bin = find().ok_or("QEMU was not found")?;
  let img = bin.with_file_name("qemu-img");
  let ok = Command::new(img).args(["create", "-q", "-f", "qcow2", "-b"]).arg(safe(base)?).args(["-F", "qcow2"]).arg(safe(name)?).arg(size).status().map_err(|e| e.to_string())?;
  if ok.success() { Ok(()) } else { Err("qemu-img could not create the disk".into()) }
}

/// Standard base64 (with padding) → bytes.
fn unbase64(text: &str) -> Result<Vec<u8>, String> {
  let val = |c: u8| -> Result<u32, String> {
    Ok(match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, _ => return Err("bad base64".into()) } as u32)
  };
  let s: Vec<u8> = text.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
  let mut out = Vec::with_capacity(s.len() / 4 * 3);
  for chunk in s.chunks(4) {
    let pad = chunk.iter().filter(|&&c| c == b'=').count();
    let mut n = 0u32;
    for (i, &c) in chunk.iter().enumerate() { n |= if c == b'=' { 0 } else { val(c)? } << (18 - 6 * i); }
    let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
    out.extend_from_slice(&bytes[..3 - pad.min(2)]);
  }
  Ok(out)
}

pub fn save(name: &str, data: &str, append: bool) -> Result<(), String> {
  std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
  let bytes = unbase64(data)?;
  let mut f = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(safe(name)?).map_err(|e| e.to_string())?;
  f.write_all(&bytes).map_err(|e| e.to_string())
}

fn connect(p: &std::path::Path) -> Result<UnixStream, String> {
  for _ in 0..100 {
    if let Ok(s) = UnixStream::connect(p) { return Ok(s); }
    std::thread::sleep(std::time::Duration::from_millis(50));
  }
  Err(format!("QEMU's socket {} did not open", p.display()))
}

/// A Raspberry Pi VM left running by an earlier Space Bench (one that quit or crashed without
/// stopping it) holds its disk's lock, and QEMU then refuses the disk. Only one VM runs at a time,
/// so any QEMU booted from the Linux folder is a stray.
fn kill_strays() {
  let pat = format!("qemu-system-aarch64.*{}", dir().display());
  let strays = || Command::new("pgrep").args(["-f", &pat]).output().map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().map(String::from).collect::<Vec<_>>()).unwrap_or_default();
  let pids = strays();
  if pids.is_empty() { return }
  let _ = Command::new("kill").arg("-9").args(&pids).status();
  for _ in 0..30 { if strays().is_empty() { break } std::thread::sleep(std::time::Duration::from_millis(100)); }
}

pub fn start(o: StartOptions) -> Result<(), String> {
  stop();
  kill_strays();
  let bin = find().ok_or("QEMU (qemu-system-aarch64) was not found — install it with `brew install qemu`")?;
  let tmp = std::env::temp_dir().join(format!("sb-linux-{}", std::process::id()));
  std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
  let sock = |k: &str| tmp.join(format!("{k}.sock"));
  for k in ["console", "qmp", "agent"] { let _ = std::fs::remove_file(sock(k)); }
  let accel = if cfg!(target_os = "macos") { "hvf" } else { "kvm" };
  let mut cmd = Command::new(&bin);
  cmd.args(["-M", "virt", "-accel", accel, "-cpu", "host", "-smp"]).arg(o.cpus.unwrap_or(4).to_string()).arg("-m").arg(o.memory.unwrap_or(2048).to_string());
  if let Some(k) = &o.kernel {
    cmd.arg("-kernel").arg(safe(k)?).arg("-append").arg(o.append.clone().unwrap_or_else(|| "console=ttyAMA0".into()));
    if let Some(i) = &o.initrd { cmd.arg("-initrd").arg(safe(i)?); }
  } else {
    let fw = bin.parent().map(|p| p.join("../share/qemu/edk2-aarch64-code.fd")).filter(|p| p.exists()).ok_or("QEMU's UEFI firmware (edk2-aarch64-code.fd) was not found")?;
    cmd.args(["-M", "virt,acpi=off", "-drive"]).arg(format!("if=pflash,format=raw,readonly=on,file={}", fw.display()));
  }
  cmd.arg("-drive").arg(format!("if=virtio,file={}", safe(&o.disk)?.display()))
    .args(["-nic", "user,model=virtio-net-pci", "-display", "none", "-monitor", "none", "-serial"])
    .arg(format!("unix:{},server=on,wait=off", sock("console").display()))
    .arg("-qmp").arg(format!("unix:{},server=on,wait=off", sock("qmp").display()))
    .args(["-device", "virtio-serial-pci", "-chardev"]).arg(format!("socket,id=sb,path={},server=on,wait=off", sock("agent").display()))
    .args(["-device", "virtserialport,chardev=sb,name=spacebench"]);
  for c in o.credentials.unwrap_or_default() { cmd.arg("-smbios").arg(format!("type=11,value=io.systemd.credential:{c}")); }
  let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Could not start QEMU: {e}"))?;
  let log = Arc::new(Mutex::new(String::new()));
  { let log = log.clone(); let mut err = child.stderr.take().ok_or("no stderr")?; std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); log.lock().unwrap().push_str(&s); }); }
  let out = Arc::new(Mutex::new(Vec::new()));
  let lines = Arc::new(Mutex::new(Vec::new()));
  let pump = |s: UnixStream, buf: Arc<Mutex<Vec<u8>>>| { let mut s = s; std::thread::spawn(move || { let mut b = [0u8; 8192]; while let Ok(n) = s.read(&mut b) { if n == 0 { break } buf.lock().unwrap().extend_from_slice(&b[..n]); } }); };
  let console = connect(&sock("console"))?;
  pump(console.try_clone().map_err(|e| e.to_string())?, out.clone());
  let agent = connect(&sock("agent"))?;
  pump(agent.try_clone().map_err(|e| e.to_string())?, lines.clone());
  let mut qmp = BufReader::new(connect(&sock("qmp"))?);
  let mut greeting = String::new();
  qmp.read_line(&mut greeting).map_err(|e| e.to_string())?;
  *SESSION.lock().unwrap() = Some(Session { child, console, agent, qmp, out, lines, log, dir: tmp });
  qmp_cmd("qmp_capabilities")
}

pub fn qmp_cmd(cmd: &str) -> Result<(), String> {
  let mut g = SESSION.lock().unwrap();
  let s = g.as_mut().ok_or("The Linux board is not running")?;
  s.qmp.get_mut().write_all(format!("{{\"execute\":\"{cmd}\"}}\n").as_bytes()).map_err(|e| e.to_string())?;
  loop {
    let mut line = String::new();
    if s.qmp.read_line(&mut line).map_err(|e| e.to_string())? == 0 { return Err("QMP closed".into()); }
    if line.contains("\"return\"") { return Ok(()); }
    if line.contains("\"error\"") { return Err(line); }
  }
}

#[derive(serde::Serialize)]
pub struct Poll { console: String, agent: String, running: bool, log: String }

pub fn poll() -> Poll {
  let mut g = SESSION.lock().unwrap();
  let Some(s) = g.as_mut() else { return Poll { console: String::new(), agent: String::new(), running: false, log: String::new() } };
  let console = String::from_utf8_lossy(&std::mem::take(&mut *s.out.lock().unwrap())).into_owned();
  // whole agent lines only
  let agent = {
    let mut b = s.lines.lock().unwrap();
    let cut = b.iter().rposition(|&c| c == b'\n').map(|i| i + 1).unwrap_or(0);
    let head: Vec<u8> = b.drain(..cut).collect();
    String::from_utf8_lossy(&head).into_owned()
  };
  let running = matches!(s.child.try_wait(), Ok(None));
  let log = if running { String::new() } else { s.log.lock().unwrap().clone() };
  Poll { console, agent, running, log }
}

pub fn send(console: Option<String>, agent: Option<String>) -> Result<(), String> {
  let mut g = SESSION.lock().unwrap();
  let s = g.as_mut().ok_or("The Linux board is not running")?;
  if let Some(t) = console { s.console.write_all(t.as_bytes()).map_err(|e| e.to_string())?; }
  if let Some(t) = agent { s.agent.write_all(t.as_bytes()).map_err(|e| e.to_string())?; }
  Ok(())
}

/// Homebrew packages Space Bench installs when the user agrees (the assistant asks first):
/// QEMU for the Raspberry Pi boards, arduino-cli for compiling sketches.
pub const BREW_PACKAGES: [&str; 2] = ["qemu", "arduino-cli"];

pub fn brew_install(pkg: &str) -> Result<String, String> {
  if !BREW_PACKAGES.contains(&pkg) { return Err(format!("{pkg} isn't a package Space Bench installs")) }
  let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].iter().map(PathBuf::from).find(|p| p.exists())
    .ok_or("Homebrew isn't installed: get it from https://brew.sh (it asks for your password), then try again")?;
  let out = Command::new(&brew).args(["install", pkg]).env("HOMEBREW_NO_AUTO_UPDATE", "1").env("HOMEBREW_NO_ENV_HINTS", "1").output().map_err(|e| e.to_string())?;
  let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
  let tail = text.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>();
  let tail = tail[tail.len().saturating_sub(6)..].join("\n");
  if out.status.success() { Ok(tail) } else { Err(format!("brew install {pkg} failed:\n{tail}")) }
}

/// Ask the guest agent to write everything to its disk, then stop: QEMU is ended, not shut down
/// (the app quitting) — without this, packages just installed could be lost.
pub fn sync_and_stop() {
  // a co-simulation may have left it paused, and a paused guest can't write anything
  let _ = qmp_cmd("cont");
  if let Some(s) = SESSION.lock().unwrap().as_mut() {
    let _ = s.agent.write_all(b"{\"op\":\"sync\"}\n");
    let _ = s.agent.flush();
  }
  std::thread::sleep(std::time::Duration::from_millis(800));
  stop();
}

pub fn stop() {
  if let Some(mut s) = SESSION.lock().unwrap().take() {
    let _ = s.child.kill();
    let _ = s.child.wait();
    let _ = std::fs::remove_dir_all(&s.dir);
  }
}
