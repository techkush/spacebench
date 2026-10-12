//! Renode boards (STM32 / nRF52): Antmicro's Renode (MIT) runs the firmware ELF; Space Bench
//! drives it through its monitor socket and a helper loaded into it (renode/sb_renode.py),
//! one command at a time (src/renode/). The dev server mirrors this in vite-renode.ts.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Session { child: Child, sock: TcpStream, dir: PathBuf }
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn home() -> PathBuf { PathBuf::from(std::env::var("HOME").unwrap_or_default()) }
fn own_dir() -> PathBuf { home().join("Library/Application Support/Space Bench/renode") }

pub fn find() -> Option<PathBuf> {
  let mut c = vec![own_dir().join("Renode.app/Contents/MacOS/renode"), PathBuf::from("/Applications/Renode.app/Contents/MacOS/renode")];
  if let Some(p) = std::env::var_os("PATH") { for d in std::env::split_paths(&p) { c.push(d.join("renode")); } }
  c.into_iter().find(|p| p.is_file())
}

pub fn status() -> Option<String> {
  let bin = find()?;
  let out = Command::new(&bin).arg("--version").output().ok()?;
  Some(format!("{} · {}", String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim(), bin.display()))
}

/// Download Renode's portable macOS build (≈ 75 MB) into Space Bench's folder.
pub fn install() -> Result<Option<String>, String> {
  if !cfg!(target_os = "macos") { return Err("Automatic install is for macOS; on Linux install Renode from renode.io".into()); }
  let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
  let ver = "1.17.0";
  let url = format!("https://github.com/renode/renode/releases/download/v{ver}/renode-{ver}.osx-{arch}-portable.dmg");
  let dir = own_dir();
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let dmg = dir.join("renode.dmg");
  let ok = Command::new("curl").args(["-fsSL", "-o"]).arg(&dmg).arg(&url).status().map_err(|e| e.to_string())?;
  if !ok.success() { return Err(format!("Download failed: {url}")); }
  let mnt = std::env::temp_dir().join("sb-renode-mnt");
  let _ = std::fs::create_dir_all(&mnt);
  let ok = Command::new("hdiutil").args(["attach", "-nobrowse", "-readonly", "-mountpoint"]).arg(&mnt).arg(&dmg).stdout(Stdio::null()).status().map_err(|e| e.to_string())?;
  if !ok.success() { return Err("Could not open the Renode disk image".into()); }
  let _ = std::fs::remove_dir_all(dir.join("Renode.app"));
  let copied = Command::new("cp").arg("-R").arg(mnt.join("Renode.app")).arg(&dir).status().map_err(|e| e.to_string());
  let _ = Command::new("hdiutil").arg("detach").arg(&mnt).stdout(Stdio::null()).status();
  let _ = std::fs::remove_file(&dmg);
  if !copied?.success() { return Err("Could not copy Renode".into()); }
  Ok(status())
}

pub fn stop() {
  if let Some(mut s) = SESSION.lock().unwrap().take() {
    let _ = s.child.kill();
    let _ = s.child.wait();
    let _ = std::fs::remove_dir_all(&s.dir);
  }
}

/// Send one monitor command; return the __SB__ JSON of sb_* calls, or the monitor's text up to the prompt.
fn exec(s: &mut Session, line: &str, timeout: Duration) -> Result<String, String> {
  s.sock.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())?;
  let sb = line.starts_with("python") && line.contains("sb_");
  let end = Instant::now() + timeout;
  let mut buf = String::new();
  let mut chunk = [0u8; 65536];
  while Instant::now() < end {
    match s.sock.read(&mut chunk) {
      Ok(0) => return Err("Renode closed its monitor".into()),
      Ok(n) => buf.push_str(&String::from_utf8_lossy(&chunk[..n])),
      Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
      Err(e) => return Err(e.to_string()),
    }
    if sb {
      if let Some(i) = buf.find("__SB__") { if let Some(j) = buf[i..].find('\n') { return Ok(buf[i + 6..i + j].trim().to_string()); } }
      if (buf.contains("There was an error") || buf.contains("Traceback")) && buf.trim_end().ends_with(')') { return Err(buf.trim().chars().rev().take(600).collect::<String>().chars().rev().collect()); }
    } else if prompt(&buf) { return Ok(buf); }
  }
  Err(format!("Renode didn't answer: {}", line.chars().take(60).collect::<String>()))
}

/// The monitor's prompt "(machine) " at the end of the text.
fn prompt(buf: &str) -> bool {
  let t = buf.trim_end();
  t.ends_with(')') && t.rfind('(').map(|i| t[i + 1..t.len() - 1].chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')).unwrap_or(false)
}

pub fn start(helper: &str) -> Result<String, String> {
  stop();
  let bin = find().ok_or("Renode was not found — install it from Settings → Microcontrollers")?;
  let dir = std::env::temp_dir().join(format!("sb-renode-{}", std::process::id()));
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let helper_path = dir.join("sb_renode.py");
  std::fs::write(&helper_path, helper).map_err(|e| e.to_string())?;
  let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| e.to_string())?;
  let child = Command::new(&bin).args(["--disable-gui", "--plain", "-P"]).arg(port.to_string())
    .current_dir(bin.parent().unwrap_or(std::path::Path::new("/")))
    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Could not start Renode: {e}"))?;
  let mut sock = None;
  for _ in 0..150 {
    if let Ok(s) = TcpStream::connect(("127.0.0.1", port)) { sock = Some(s); break }
    std::thread::sleep(Duration::from_millis(100));
  }
  let sock = sock.ok_or("Renode's monitor didn't open")?;
  sock.set_read_timeout(Some(Duration::from_millis(50))).map_err(|e| e.to_string())?;
  let mut s = Session { child, sock, dir };
  exec(&mut s, "help", Duration::from_secs(60))?;
  *SESSION.lock().unwrap() = Some(s);
  Ok(helper_path.display().to_string())
}

pub fn cmd(line: &str) -> Result<String, String> {
  let mut g = SESSION.lock().unwrap();
  let s = g.as_mut().ok_or("Renode is not running")?;
  exec(s, line, Duration::from_secs(120))
}

/// A copy of the compiled ELF the next compile won't delete.
pub fn stage(elf: &str) -> Result<String, String> {
  let dir = std::env::temp_dir().join("sb-renode-elf");
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
  let dest = dir.join(format!("{stamp:x}.elf"));
  std::fs::copy(elf, &dest).map_err(|e| format!("Could not copy the firmware: {e}"))?;
  Ok(dest.display().to_string())
}
