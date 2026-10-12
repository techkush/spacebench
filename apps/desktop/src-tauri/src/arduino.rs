//! Compile Arduino sketches with the user's `arduino-cli` (https://arduino.github.io/arduino-cli/).
//! The sketch files go into a scratch sketch folder per board, with a build folder next to it,
//! so arduino-cli's incremental build cache makes the second compile fast.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Deserialize)]
pub struct SketchFile { pub name: String, pub content: String }

#[derive(Serialize)]
pub struct CompileResult { pub ok: bool, pub hex: Option<String>, pub bin: Option<String>, pub image: Option<String>, pub elf: Option<String>, pub stdout: String, pub stderr: String, pub sketch_dir: String }

fn runnable(p: &std::path::Path) -> bool {
  #[cfg(unix)]
  { use std::os::unix::fs::PermissionsExt; std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false) }
  #[cfg(not(unix))]
  { p.is_file() }
}

/// Find `arduino-cli`: the custom path, PATH, the usual install places, then the login shell.
pub fn find(custom: Option<&str>) -> Option<PathBuf> {
  if let Some(p) = custom.map(str::trim).filter(|p| !p.is_empty()) {
    let p = PathBuf::from(p);
    return runnable(&p).then_some(p);
  }
  let home = std::env::var("HOME").unwrap_or_default();
  let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] { dirs.push(PathBuf::from(d)); }
  for d in ["bin", ".local/bin", "go/bin"] { dirs.push(PathBuf::from(&home).join(d)); }
  let exe = if cfg!(windows) { "arduino-cli.exe" } else { "arduino-cli" };
  if let Some(p) = dirs.into_iter().map(|d| d.join(exe)).find(|p| runnable(p)) { return Some(p); }
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let out = Command::new(shell).args(["-lc", "command -v arduino-cli"]).output().ok()?;
  let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
  (!p.is_empty() && runnable(&PathBuf::from(&p))).then(|| PathBuf::from(p))
}

fn not_found() -> String {
  "arduino-cli was not found. Install it (macOS: `brew install arduino-cli`; others: https://arduino.github.io/arduino-cli/latest/installation/) or set its path in Settings.".into()
}

fn run(bin: &PathBuf, args: &[&str]) -> Result<(bool, String, String), String> {
  let out = Command::new(bin).args(args).output().map_err(|e| format!("Could not run arduino-cli: {e}"))?;
  Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
}

/// `arduino-cli version` and whether the AVR core is installed.
pub fn status(custom: Option<&str>) -> Result<serde_json::Value, String> {
  let bin = find(custom).ok_or_else(not_found)?;
  let (_, version, _) = run(&bin, &["version"])?;
  let (_, cores, _) = run(&bin, &["core", "list"])?;
  let installed: Vec<String> = cores.lines().skip(1).filter_map(|l| l.split_whitespace().next().map(str::to_string)).collect();
  Ok(serde_json::json!({ "path": bin.display().to_string(), "version": version.trim(), "cores": installed }))
}

/// Install a board core (`arduino:avr`), downloading the index first.
pub fn install_core(core: &str, url: Option<&str>, custom: Option<&str>) -> Result<String, String> {
  let bin = find(custom).ok_or_else(not_found)?;
  let extra: Vec<&str> = url.map(|u| vec!["--additional-urls", u]).unwrap_or_default();
  let _ = run(&bin, &[&["core", "update-index"][..], &extra].concat());
  let (ok, out, err) = run(&bin, &[&["core", "install", core][..], &extra].concat())?;
  if ok { Ok(out) } else { Err(if err.trim().is_empty() { out } else { err }) }
}

/// Install libraries named in libraries.txt (`Name` or `Name@version`), skipping installed ones.
pub fn install_libraries(names: &[String], custom: Option<&str>) -> Result<String, String> {
  let bin = find(custom).ok_or_else(not_found)?;
  if names.is_empty() { return Ok(String::new()); }
  let (_, listed, _) = run(&bin, &["lib", "list", "--format", "json"])?;
  let mut log = String::new();
  for name in names {
    let bare = name.split('@').next().unwrap_or(name).trim();
    if bare.is_empty() { continue; }
    if listed.contains(&format!("\"name\": \"{bare}\"")) || listed.contains(&format!("\"name\":\"{bare}\"")) { continue; }
    let (ok, out, err) = run(&bin, &["lib", "install", name.trim()])?;
    log.push_str(&out);
    if !ok { return Err(format!("Could not install library {name}: {}", if err.trim().is_empty() { out } else { err })); }
  }
  Ok(log)
}

pub fn compile(files: Vec<SketchFile>, fqbn: &str, props: &[String], custom: Option<&str>) -> Result<CompileResult, String> {
  let bin = find(custom).ok_or_else(not_found)?;
  let key: String = fqbn.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
  let root = std::env::temp_dir().join("spacebench-arduino").join(key);
  let sketch = root.join("sketch");
  let build = root.join("build");
  let _ = std::fs::remove_dir_all(&sketch);
  std::fs::create_dir_all(&sketch).map_err(|e| e.to_string())?;
  // the main .ino must be named after the folder
  let mut main_done = false;
  for f in &files {
    let name = std::path::Path::new(&f.name).file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let target = if !main_done && name.ends_with(".ino") { main_done = true; "sketch.ino".to_string() } else { name };
    std::fs::write(sketch.join(target), &f.content).map_err(|e| e.to_string())?;
  }
  if !main_done { return Err("The sketch has no .ino file".into()); }
  let out_dir = root.join("out");
  let _ = std::fs::remove_dir_all(&out_dir);
  let build_s = build.display().to_string(); let out_s = out_dir.display().to_string(); let sketch_s = sketch.display().to_string();
  let mut args: Vec<&str> = vec!["compile", "--fqbn", fqbn, "--build-path", &build_s, "--output-dir", &out_s, "--warnings", "default"];
  for p in props { args.push("--build-property"); args.push(p); }
  args.push(&sketch_s);
  let (ok, stdout, stderr) = run(&bin, &args)?;
  let hex = if ok { std::fs::read_to_string(out_dir.join("sketch.ino.hex")).ok() } else { None };
  // RP2040 and ESP32 builds produce a flash image instead of Intel HEX
  // ESP32: the merged 4 MB flash image (bootloader + partitions + app) — QEMU runs it from disk
  let merged = out_dir.join("sketch.ino.merged.bin");
  let image = (ok && merged.exists()).then(|| merged.display().to_string());
  let bin = if ok && image.is_none() { std::fs::read(out_dir.join("sketch.ino.bin")).ok().map(|b| base64(&b)) } else { None };
  // Renode boards boot the ELF (with its symbols) from disk
  let elf_path = out_dir.join("sketch.ino.elf");
  let elf = (ok && elf_path.exists()).then(|| elf_path.display().to_string());
  Ok(CompileResult { ok: ok && (hex.is_some() || bin.is_some() || image.is_some() || elf.is_some()), hex, bin, image, elf, stdout, stderr, sketch_dir: sketch.display().to_string() })
}

fn base64(data: &[u8]) -> String {
  const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
  for c in data.chunks(3) {
    let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
    out.push(T[(n >> 18) as usize & 63] as char);
    out.push(T[(n >> 12) as usize & 63] as char);
    out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
    out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
  }
  out
}
