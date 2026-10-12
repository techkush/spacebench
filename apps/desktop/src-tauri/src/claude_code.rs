//! Claude Code CLI back end for the AI assistant: run `claude -p` (print mode,
//! stream-json in and out) with the user's own Claude Code login, streaming every
//! output line to the UI as it arrives. Runs can be cancelled.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

fn running() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
  static R: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();
  R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// An executable file (a stale npm install can leave a link to a non-executable stub).
fn runnable(p: &std::path::Path) -> bool {
  #[cfg(unix)]
  { use std::os::unix::fs::PermissionsExt; std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false) }
  #[cfg(not(unix))]
  { p.is_file() }
}

/// Find `claude`: the custom path, PATH, the usual install places, then the login shell.
pub fn find_claude(custom: Option<&str>) -> Option<PathBuf> {
  if let Some(p) = custom.map(str::trim).filter(|p| !p.is_empty()) {
    let p = PathBuf::from(p);
    return runnable(&p).then_some(p);
  }
  let home = std::env::var("HOME").unwrap_or_default();
  let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  // GUI apps on macOS start with a minimal PATH
  for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] { dirs.push(PathBuf::from(d)); }
  for d in [".claude/local", ".local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin"] { dirs.push(PathBuf::from(&home).join(d)); }
  let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
  if let Some(p) = dirs.into_iter().map(|d| d.join(exe)).find(|p| runnable(p)) { return Some(p); }
  // last resort: ask the user's login shell (nvm and friends set PATH there)
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let out = Command::new(shell).args(["-lc", "command -v claude"]).output().ok()?;
  let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
  (!p.is_empty() && runnable(&PathBuf::from(&p))).then(|| PathBuf::from(p))
}

pub fn version(custom: Option<&str>) -> Result<String, String> {
  let bin = find_claude(custom).ok_or("Claude Code (the `claude` command) was not found")?;
  let out = Command::new(&bin).arg("--version").output().map_err(|e| e.to_string())?;
  Ok(format!("{} · {}", String::from_utf8_lossy(&out.stdout).trim(), bin.display()))
}

/// Run `claude <args>` with `stdin`, in a scratch working directory (so no project
/// CLAUDE.md is picked up). Each stdout line is emitted as `claude-code://line`
/// `{ run, line }`; returns `{ code, stderr }` when the process ends.
pub fn run(app: AppHandle, run_id: String, args: Vec<String>, stdin: String, custom: Option<String>) -> Result<serde_json::Value, String> {
  let bin = find_claude(custom.as_deref()).ok_or("Claude Code (the `claude` command) was not found. Install it (npm install -g @anthropic-ai/claude-code) and log in by running `claude` once in a terminal.")?;
  let dir = std::env::temp_dir().join("spacebench-claude");
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let mut child = Command::new(&bin)
    .args(&args)
    .current_dir(&dir)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("could not start claude: {e}"))?;
  {
    let mut si = child.stdin.take().ok_or("no stdin")?;
    si.write_all(stdin.as_bytes()).map_err(|e| e.to_string())?;
    // closing stdin ends the stream-json input
  }
  let stdout = child.stdout.take().ok_or("no stdout")?;
  let stderr = child.stderr.take().ok_or("no stderr")?;
  let child = Arc::new(Mutex::new(child));
  running().lock().unwrap().insert(run_id.clone(), child.clone());
  let err_reader = std::thread::spawn(move || { let mut s = String::new(); for l in BufReader::new(stderr).lines().map_while(Result::ok) { s.push_str(&l); s.push('\n'); } s });
  for line in BufReader::new(stdout).lines().map_while(Result::ok) {
    let _ = app.emit("claude-code://line", serde_json::json!({ "run": run_id, "line": line }));
  }
  // poll (never hold the lock while blocking, so cancel() can always get in)
  let status = loop {
    if let Some(st) = child.lock().unwrap().try_wait().map_err(|e| e.to_string())? { break st; }
    std::thread::sleep(std::time::Duration::from_millis(20));
  };
  running().lock().unwrap().remove(&run_id);
  let stderr = err_reader.join().unwrap_or_default();
  Ok(serde_json::json!({ "code": status.code(), "stderr": stderr.chars().take(4000).collect::<String>() }))
}

pub fn cancel(run_id: &str) -> bool {
  if let Some(c) = running().lock().unwrap().remove(run_id) { let _ = c.lock().unwrap().kill(); true } else { false }
}
