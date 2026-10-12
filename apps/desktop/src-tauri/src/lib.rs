mod arduino;
mod esp32;
mod linux;
mod renode;
mod claude_code;
mod ngspice;
mod ngspice_lib;

/// Run a simulation job (JSON in, JSON out) on the Space Bench Engine.
/// Runs on a blocking worker thread so the UI never freezes.
#[tauri::command]
async fn simulate(job: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || sb_engine::api::run_json(&job).map_err(|e| e.to_string()))
    .await
    .map_err(|e| e.to_string())?
}

/// Run a SPICE netlist on ngspice. `engine`: "library" (libngspice, see ngspice_lib.rs),
/// "program" (`ngspice -b`, see ngspice.rs) or "auto" (library when it loads, else program).
/// `run` names the run for progress events and Stop; `live` marks a Live re-run.
#[tauri::command]
async fn ngspice_run(app: tauri::AppHandle, netlist: String, bin: Option<String>, engine: Option<String>, run: Option<String>, live: Option<bool>) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let engine = engine.as_deref().unwrap_or("auto");
    let lib = if engine == "program" { Err(String::new()) } else { ngspice_lib::available(bin.as_deref()) };
    match lib {
      Ok(_) => ngspice_lib::run(&netlist, bin.as_deref(), Some(app), run, live.unwrap_or(false)),
      Err(e) if engine == "library" => Err(format!("{e}. Install ngspice's shared library or switch Settings → Simulation Engine to “Program”.")),
      Err(_) => ngspice::run(&netlist, bin.as_deref()),
    }
  }).await.map_err(|e| e.to_string())?
}

/// Stop a library run (`run`), or the current Live run when `run` is empty.
#[tauri::command]
fn ngspice_halt(run: Option<String>, bin: Option<String>) -> bool {
  ngspice_lib::halt(run.as_deref(), bin.as_deref())
}

/// Change a part of the running circuit and carry on (e.g. `r1 resistance=2k`).
#[tauri::command]
async fn ngspice_alter(command: String, bin: Option<String>) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || ngspice_lib::alter(&command, bin.as_deref())).await.map_err(|e| e.to_string())?
}

/// The libngspice that would be used, or why there is none (for Settings).
#[tauri::command]
async fn ngspice_lib_path(bin: Option<String>) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || ngspice_lib::available(bin.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn ngspice_version(bin: Option<String>) -> Result<String, String> {
  ngspice::version(bin.as_deref())
}

/// The ngspice executable that would be used (for Settings).
#[tauri::command]
fn ngspice_path(bin: Option<String>) -> Option<String> {
  ngspice::find_ngspice(bin.as_deref()).map(|p| p.display().to_string())
}

/// AI assistant through the Claude Code CLI (the user's own `claude` login).
#[tauri::command]
async fn claude_code_run(app: tauri::AppHandle, run: String, args: Vec<String>, stdin: String, bin: Option<String>) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || claude_code::run(app, run, args, stdin, bin)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn claude_code_cancel(run: String) -> bool {
  claude_code::cancel(&run)
}

#[tauri::command]
async fn claude_code_version(bin: Option<String>) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || claude_code::version(bin.as_deref())).await.map_err(|e| e.to_string())?
}

/// Arduino: compile a sketch with arduino-cli (returns the Intel HEX and the compiler output).
#[tauri::command]
async fn arduino_compile(files: Vec<arduino::SketchFile>, fqbn: String, libraries: Vec<String>, props: Option<Vec<String>>, bin: Option<String>) -> Result<arduino::CompileResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    arduino::install_libraries(&libraries, bin.as_deref())?;
    arduino::compile(files, &fqbn, &props.unwrap_or_default(), bin.as_deref())
  }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn arduino_status(bin: Option<String>) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || arduino::status(bin.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn arduino_install_core(core: String, url: Option<String>, bin: Option<String>) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || arduino::install_core(&core, url.as_deref(), bin.as_deref())).await.map_err(|e| e.to_string())?
}

/// ESP32 on Espressif's QEMU (see esp32.rs).
#[tauri::command]
async fn esp32_status(bin: Option<String>) -> Result<String, String> { tauri::async_runtime::spawn_blocking(move || esp32::status(bin.as_deref())).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn esp32_install() -> Result<String, String> { tauri::async_runtime::spawn_blocking(esp32::install).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn esp32_start(image: String, bin: Option<String>, machine: Option<String>) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || esp32::start(&image, bin.as_deref(), machine.as_deref().unwrap_or("esp32"))).await.map_err(|e| e.to_string())? }
#[tauri::command]
fn esp32_poll() -> esp32::Poll { esp32::poll() }
#[tauri::command]
fn esp32_send(serial: Option<String>, bridge: Option<Vec<u8>>) -> Result<(), String> { esp32::send(serial, bridge) }
#[tauri::command]
fn esp32_stop() { esp32::stop() }
#[tauri::command]
fn esp32_qmp(cmd: String) -> Result<(), String> { esp32::qmp_cmd(&cmd) }

/// Linux boards (Raspberry Pi) in a QEMU VM (see linux.rs).
#[tauri::command]
async fn linux_status() -> linux::Status { tauri::async_runtime::spawn_blocking(linux::status).await.unwrap() }
#[tauri::command]
async fn linux_fetch(url: String, name: String) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || linux::fetch(&url, &name)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn linux_disk(base: String, name: String, size: String) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || linux::disk(&base, &name, &size)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn linux_save(name: String, data: String, append: bool) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || linux::save(&name, &data, append)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn linux_start(opts: linux::StartOptions) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || linux::start(opts)).await.map_err(|e| e.to_string())? }
#[tauri::command]
fn linux_poll() -> linux::Poll { linux::poll() }
#[tauri::command]
fn linux_send(console: Option<String>, agent: Option<String>) -> Result<(), String> { linux::send(console, agent) }
#[tauri::command]
fn linux_qmp(cmd: String) -> Result<(), String> { linux::qmp_cmd(&cmd) }
#[tauri::command]
fn linux_stop() { linux::stop() }
#[tauri::command]
async fn brew_install(pkg: String) -> Result<String, String> { tauri::async_runtime::spawn_blocking(move || linux::brew_install(&pkg)).await.map_err(|e| e.to_string())? }

/// Renode boards (STM32 / nRF52) — see renode.rs.
#[tauri::command]
async fn renode_status() -> Option<String> { tauri::async_runtime::spawn_blocking(renode::status).await.unwrap_or(None) }
#[tauri::command]
async fn renode_install() -> Result<Option<String>, String> { tauri::async_runtime::spawn_blocking(renode::install).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn renode_start(helper: String) -> Result<String, String> { tauri::async_runtime::spawn_blocking(move || renode::start(&helper)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn renode_cmd(line: String) -> Result<String, String> { tauri::async_runtime::spawn_blocking(move || renode::cmd(&line)).await.map_err(|e| e.to_string())? }
#[tauri::command]
fn renode_stage(elf: String) -> Result<String, String> { renode::stage(&elf) }
#[tauri::command]
fn renode_stop() { renode::stop() }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      use tauri::Manager;
      // Open on the primary display, in front (macOS can otherwise pick another screen).
      if let Some(w) = app.get_webview_window("main") {
        if let Ok(Some(m)) = w.primary_monitor() {
          let _ = w.set_position(*m.position());
        }
        let _ = w.maximize();
        let _ = w.set_focus();
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![simulate, ngspice_run, ngspice_halt, ngspice_alter, ngspice_lib_path, ngspice_version, ngspice_path, claude_code_run, claude_code_cancel, claude_code_version, arduino_compile, arduino_status, arduino_install_core, esp32_status, esp32_install, esp32_start, esp32_poll, esp32_send, esp32_stop, esp32_qmp, linux_status, linux_fetch, linux_disk, linux_save, linux_start, linux_poll, linux_send, linux_qmp, linux_stop, brew_install, renode_status, renode_install, renode_start, renode_cmd, renode_stage, renode_stop])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    // the emulators are separate processes: stop them with the app (a VM left running keeps its disk locked)
    .run(|_, e| if let tauri::RunEvent::Exit = e { linux::sync_and_stop(); esp32::stop(); renode::stop(); });
}
