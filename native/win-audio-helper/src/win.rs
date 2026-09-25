use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::json;
use sysinfo::{Pid, ProcessesToUpdate, System};
use wasapi::{
    initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode,
    WaveFormat,
};

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;

/// Dedicated call apps, matched on the executable name of the process or any
/// ancestor. Their whole process tree is captured, so Teams' WebView2 children
/// and Chrome's audio service are included.
const MEETING_APPS: &[(&str, &str)] = &[
    ("ms-teams.exe", "Microsoft Teams"),
    ("teams.exe", "Microsoft Teams"),
    ("zoom.exe", "Zoom"),
    ("ciscocollabhost.exe", "Webex"),
    ("webex.exe", "Webex"),
    ("webexmta.exe", "Webex"),
    ("atmgr.exe", "Webex"),
    ("slack.exe", "Slack"),
    ("whatsapp.exe", "WhatsApp"),
    ("whatsapp.root.exe", "WhatsApp"),
];

/// Lower priority than call apps: a browser may be playing a video next to the
/// call, so it only wins when no call app is making sound.
const BROWSERS: &[(&str, &str)] = &[
    ("chrome.exe", "Google Chrome"),
    ("msedge.exe", "Microsoft Edge"),
    ("firefox.exe", "Firefox"),
    ("brave.exe", "Brave"),
    ("opera.exe", "Opera"),
    ("vivaldi.exe", "Vivaldi"),
    ("arc.exe", "Arc"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
enum Target {
    /// Capture this process tree only.
    App { pid: u32, name: String },
    /// Capture everything except this process tree (Notizli itself).
    AllExcept { pid: u32 },
}

impl Target {
    fn describe(&self) -> serde_json::Value {
        match self {
            Target::App { pid, name } => json!({ "event": "target", "mode": "app", "name": name, "pid": pid }),
            Target::AllExcept { .. } => json!({ "event": "target", "mode": "all", "name": "All computer sound" }),
        }
    }
}

struct Options {
    exclude_pid: u32,
    poll: Duration,
    level_test: bool,
    diagnose_secs: Option<u64>,
}

fn parse_args(args: Vec<String>) -> Options {
    let mut o = Options {
        exclude_pid: std::process::id(),
        poll: Duration::from_millis(2000),
        level_test: false,
        diagnose_secs: None,
    };
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--exclude-pid" => {
                if let Some(v) = it.next().and_then(|v| v.parse().ok()) {
                    o.exclude_pid = v;
                }
            }
            "--poll-ms" => {
                if let Some(v) = it.next().and_then(|v| v.parse::<u64>().ok()) {
                    o.poll = Duration::from_millis(v.clamp(250, 10_000));
                }
            }
            "--level-test" => o.level_test = true,
            "--diagnose" => o.diagnose_secs = Some(30),
            _ => {}
        }
    }
    o
}

fn event(v: serde_json::Value) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{v}");
    let _ = err.flush();
}

pub fn run(args: Vec<String>) -> i32 {
    let opts = parse_args(args);
    if initialize_mta().is_err() {
        event(json!({ "event": "error", "message": "COM initialization failed" }));
        return 1;
    }
    if let Some(secs) = opts.diagnose_secs {
        return diagnose(secs);
    }

    // The parent closing our stdin means Notizli quit or stopped recording.
    let quit = Arc::new(AtomicBool::new(false));
    {
        let quit = quit.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 64];
            let mut stdin = std::io::stdin();
            while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
            quit.store(true, Ordering::SeqCst);
        });
    }

    let level = Arc::new(Mutex::new(Level::default()));
    let mut system = System::new();
    let mut current: Option<(Target, Capture)> = None;
    let mut pending: Option<(Target, u8)> = None;
    let mut last_level = Instant::now();
    event(json!({ "event": "ready" }));

    while !quit.load(Ordering::SeqCst) {
        let wanted = choose_target(&mut system, opts.exclude_pid);

        // Switch only when the choice is stable for two polls, so a one-off
        // sound from another app does not bounce the capture back and forth.
        let switch = match &current {
            None => true,
            Some((t, cap)) if cap.finished() => {
                let _ = t;
                true
            }
            Some((t, _)) if *t == wanted => {
                pending = None;
                false
            }
            Some(_) => match &mut pending {
                Some((t, n)) if *t == wanted => {
                    *n += 1;
                    *n >= 2
                }
                _ => {
                    pending = Some((wanted.clone(), 1));
                    false
                }
            },
        };

        if switch {
            if let Some((_, cap)) = current.take() {
                cap.stop();
            }
            pending = None;
            match Capture::start(wanted.clone(), opts.level_test, level.clone(), quit.clone()) {
                Ok(cap) => {
                    event(wanted.describe());
                    current = Some((wanted, cap));
                }
                Err(e) => {
                    event(json!({ "event": "error", "message": format!("capture failed: {e}") }));
                    // Fall back to everything-but-us rather than nothing.
                    let fallback = Target::AllExcept { pid: opts.exclude_pid };
                    if wanted != fallback {
                        if let Ok(cap) = Capture::start(fallback.clone(), opts.level_test, level.clone(), quit.clone()) {
                            event(fallback.describe());
                            current = Some((fallback, cap));
                        }
                    }
                }
            }
        }

        if opts.level_test && last_level.elapsed() >= Duration::from_secs(1) {
            last_level = Instant::now();
            let l = std::mem::take(&mut *level.lock().unwrap());
            let db = if l.n == 0 { -120.0 } else { 10.0 * ((l.sum_sq / l.n as f64).max(1e-12)).log10() };
            let name = current.as_ref().map(|(t, _)| t.describe()["name"].clone()).unwrap_or_default();
            event(json!({ "event": "level", "target": name, "rms_db": (db * 10.0).round() / 10.0 }));
        }

        sleep_unless_quit(&quit, opts.poll);
    }

    if let Some((_, cap)) = current.take() {
        cap.stop();
    }
    0
}

fn sleep_unless_quit(quit: &AtomicBool, total: Duration) {
    let step = Duration::from_millis(100);
    let mut slept = Duration::ZERO;
    while slept < total && !quit.load(Ordering::SeqCst) {
        thread::sleep(step);
        slept += step;
    }
}

// ---- target selection ------------------------------------------------------

/// Pick the process tree to capture from the audio sessions that are active
/// right now, on any output device.
fn choose_target(system: &mut System, exclude_pid: u32) -> Target {
    system.refresh_processes(ProcessesToUpdate::All, true);
    let mut best: Option<(u8, f32, u32, String)> = None; // (priority, peak, root pid, name)

    for (pid, peak) in active_render_sessions() {
        if pid == 0 || in_tree(system, pid, exclude_pid) {
            continue;
        }
        let Some((priority, root, name)) = classify(system, pid) else { continue };
        let better = match &best {
            None => true,
            Some((p, pk, _, _)) => priority < *p || (priority == *p && peak > *pk),
        };
        if better {
            best = Some((priority, peak, root, name));
        }
    }

    match best {
        Some((_, _, pid, name)) => Target::App { pid, name },
        None => Target::AllExcept { pid: exclude_pid },
    }
}

/// (pid, current peak) for every active playback session on every device.
fn active_render_sessions() -> Vec<(u32, f32)> {
    active_render_sessions_on_devices().into_iter().map(|(_, pid, peak)| (pid, peak)).collect()
}

/// (device name, pid, current peak) for every active playback session.
fn active_render_sessions_on_devices() -> Vec<(String, u32, f32)> {
    let mut out = Vec::new();
    let Ok(enumerator) = DeviceEnumerator::new() else { return out };
    let Ok(devices) = enumerator.get_device_collection(&Direction::Render) else { return out };
    for device in &devices {
        let Ok(device) = device else { continue };
        let device_name = device.get_friendlyname().unwrap_or_else(|_| "?".into());
        let Ok(manager) = device.get_iaudiosessionmanager() else { continue };
        let Ok(sessions) = manager.get_audiosessionenumerator() else { continue };
        let Ok(count) = sessions.get_count() else { continue };
        for i in 0..count {
            let Ok(control) = sessions.get_session(i) else { continue };
            if control.get_state().ok() != Some(SessionState::Active) {
                continue;
            }
            let Ok(pid) = control.get_process_id() else { continue };
            let peak = control
                .get_audiometerinformation()
                .and_then(|m| m.get_peak_value())
                .unwrap_or(0.0);
            out.push((device_name.clone(), pid, peak));
        }
    }
    out
}

fn exe_name(system: &System, pid: u32) -> Option<String> {
    system
        .process(Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().to_ascii_lowercase())
}

fn parent_of(system: &System, pid: u32) -> Option<u32> {
    system.process(Pid::from_u32(pid)).and_then(|p| p.parent()).map(|p| p.as_u32())
}

fn in_tree(system: &System, pid: u32, root: u32) -> bool {
    let mut cur = Some(pid);
    for _ in 0..32 {
        match cur {
            Some(p) if p == root => return true,
            Some(p) => cur = parent_of(system, p),
            None => return false,
        }
    }
    false
}

/// Walk from the session's process up to the top-most ancestor that is a known
/// app (the browser's main process, ms-teams.exe above its WebView2 children).
fn classify(system: &System, pid: u32) -> Option<(u8, u32, String)> {
    let mut found: Option<(u8, u32, String)> = None;
    let mut cur = Some(pid);
    for _ in 0..32 {
        let Some(p) = cur else { break };
        if let Some(exe) = exe_name(system, p) {
            if let Some((_, name)) = MEETING_APPS.iter().find(|(e, _)| *e == exe) {
                found = Some((0, p, (*name).to_string()));
            } else if let Some((_, name)) = BROWSERS.iter().find(|(e, _)| *e == exe) {
                // Never let a browser ancestor demote a call app found lower down.
                if found.as_ref().map_or(true, |(prio, _, _)| *prio == 1) {
                    found = Some((1, p, (*name).to_string()));
                }
            }
        }
        cur = parent_of(system, p);
    }
    found
}

// ---- capture ---------------------------------------------------------------

#[derive(Default)]
struct Level {
    sum_sq: f64,
    n: u64,
}

struct Capture {
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Capture {
    fn start(target: Target, level_test: bool, level: Arc<Mutex<Level>>, quit: Arc<AtomicBool>) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let handle = {
            let (stop, done) = (stop.clone(), done.clone());
            thread::spawn(move || {
                let r = capture_loop(&target, &stop, &ready_tx, level_test, &level, &quit);
                if let Err(e) = r {
                    let _ = ready_tx.send(Err(e.clone()));
                    event(json!({ "event": "error", "message": e }));
                }
                done.store(true, Ordering::SeqCst);
            })
        };
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Capture { stop, done, handle: Some(handle) }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err("timed out starting capture".into())
            }
        }
    }

    fn finished(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }

    fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn capture_loop(
    target: &Target,
    stop: &AtomicBool,
    ready: &std::sync::mpsc::Sender<Result<(), String>>,
    level_test: bool,
    level: &Mutex<Level>,
    quit: &AtomicBool,
) -> Result<(), String> {
    initialize_mta().ok().map_err(|e| format!("COM: {e}"))?;
    let (pid, include_tree) = match target {
        Target::App { pid, .. } => (*pid, true),
        Target::AllExcept { pid } => (*pid, false),
    };
    // Process loopback has no mix format of its own: ask for ours and let the
    // engine convert.
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
    let block_align = format.get_blockalign() as usize;
    let mut client = AudioClient::new_application_loopback_client(pid, include_tree).map_err(|e| e.to_string())?;
    client
        .initialize_client(&format, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })
        .map_err(|e| e.to_string())?;
    let h_event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;
    let _ = ready.send(Ok(()));

    let mut raw: VecDeque<u8> = VecDeque::new();
    let mut mono_bytes: Vec<u8> = Vec::with_capacity(48_000);

    while !stop.load(Ordering::SeqCst) {
        // A silent target may deliver no packets at all; the timeout only
        // keeps the stop flag responsive.
        let _ = h_event.wait_for_event(200);
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => {
                    capture.read_from_device_to_deque(&mut raw).map_err(|e| e.to_string())?;
                }
                Ok(_) => break,
                Err(e) => return Err(e.to_string()),
            }
        }

        mono_bytes.clear();
        let mut sum_sq = 0.0f64;
        let mut n = 0u64;
        while raw.len() >= block_align {
            let mut frame = [0u8; 8];
            for b in frame.iter_mut() {
                *b = raw.pop_front().unwrap_or(0);
            }
            let l = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
            let r = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
            let m = 0.5 * (l + r);
            sum_sq += (m as f64) * (m as f64);
            n += 1;
            mono_bytes.extend_from_slice(&m.to_le_bytes());
        }
        if n > 0 {
            if level_test {
                let mut lv = level.lock().unwrap();
                lv.sum_sq += sum_sq;
                lv.n += n;
            } else if {
                // Lock per write, never for the whole loop: diagnose prints to
                // stdout from the main thread and would deadlock on a held lock.
                let mut out = std::io::stdout().lock();
                out.write_all(&mono_bytes).and_then(|_| out.flush()).is_err()
            } {
                // Parent stopped reading: we're done.
                quit.store(true, Ordering::SeqCst);
                break;
            }
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

// ---- diagnose --------------------------------------------------------------

fn chain(system: &System, pid: u32) -> String {
    let mut parts = Vec::new();
    let mut cur = Some(pid);
    for _ in 0..12 {
        let Some(p) = cur else { break };
        parts.push(format!("{}({})", exe_name(system, p).unwrap_or_else(|| "?".into()), p));
        cur = parent_of(system, p);
    }
    parts.join(" <- ")
}

/// Every playback device with its output peak, and every session on it (any
/// state) with its own peak. A device that is loud while none of its sessions
/// are points at audio bypassing the shared mixer (hardware offload).
fn meter_snapshot(system: &System) -> Vec<String> {
    let mut lines = Vec::new();
    let Ok(enumerator) = DeviceEnumerator::new() else { return lines };
    let Ok(devices) = enumerator.get_device_collection(&Direction::Render) else { return lines };
    for device in &devices {
        let Ok(device) = device else { continue };
        let name = device.get_friendlyname().unwrap_or_else(|_| "?".into());
        let dev_peak = device.get_audiometerinformation().and_then(|m| m.get_peak_value()).unwrap_or(-1.0);
        let mut parts = Vec::new();
        if let Ok(manager) = device.get_iaudiosessionmanager() {
            if let Ok(sessions) = manager.get_audiosessionenumerator() {
                for i in 0..sessions.get_count().unwrap_or(0) {
                    let Ok(c) = sessions.get_session(i) else { continue };
                    let state = match c.get_state() {
                        Ok(SessionState::Active) => "active",
                        Ok(SessionState::Inactive) => "inactive",
                        Ok(_) => "expired",
                        Err(_) => "?",
                    };
                    let pid = c.get_process_id().unwrap_or(0);
                    let pk = c.get_audiometerinformation().and_then(|m| m.get_peak_value()).unwrap_or(-1.0);
                    let exe = if pid == 0 { "system-sounds".into() } else { exe_name(system, pid).unwrap_or_else(|| "?".into()) };
                    parts.push(format!("{exe}({pid}) {state} {pk:.3}"));
                }
            }
        }
        lines.push(format!("\"{name}\" OUTPUT {dev_peak:.3} | sessions: {}", if parts.is_empty() { "none".into() } else { parts.join(", ") }));
    }
    lines
}

/// Human-readable report for a call in progress: which processes play sound on
/// which device, and what process loopback actually gets from each of them.
fn diagnose(secs: u64) -> i32 {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let own = std::process::id();
    println!("Notizli audio diagnose v2. Keep the call going and let the other person talk.");
    println!("Windows: {}", System::long_os_version().unwrap_or_default());
    println!("Chosen by the recorder right now: {}", choose_target(&mut system, own).describe());
    println!();

    println!("PART 1 - output level of every speaker vs. level of each app on it, every second for 10 s:");
    for t in 1..=10 {
        for line in meter_snapshot(&system) {
            println!("  t={t:>2}s {line}");
        }
        thread::sleep(Duration::from_secs(1));
    }
    println!();

    let sessions = active_render_sessions_on_devices();
    println!("Active playback sessions ({}):", sessions.len());
    let mut candidates: Vec<(u32, String)> = Vec::new();
    for (device, pid, peak) in &sessions {
        println!("  device \"{device}\"  peak {peak:.3}  process {}", chain(&system, *pid));
        if *pid != 0 && !candidates.iter().any(|(p, _)| p == pid) {
            candidates.push((*pid, format!("{}({pid})", exe_name(&system, *pid).unwrap_or_else(|| "?".into()))));
        }
        if let Some((_, root, name)) = classify(&system, *pid) {
            if !candidates.iter().any(|(p, _)| *p == root) {
                candidates.push((root, format!("{name} root({root})")));
            }
        }
    }
    println!();

    println!("PART 2 - starting a capture of each source:");
    let never = Arc::new(AtomicBool::new(false));
    let mut captures: Vec<(String, Arc<Mutex<Level>>, Option<Capture>)> = Vec::new();
    let mut targets: Vec<(String, Target)> = candidates
        .into_iter()
        .map(|(pid, label)| (label.clone(), Target::App { pid, name: label }))
        .collect();
    targets.push(("ALL except this helper".into(), Target::AllExcept { pid: own }));
    for (label, target) in targets {
        println!("  starting {label} ...");
        let level = Arc::new(Mutex::new(Level::default()));
        let cap = match Capture::start(target, true, level.clone(), never.clone()) {
            Ok(c) => {
                println!("    ok");
                Some(c)
            }
            Err(e) => {
                println!("    FAILED: {e}");
                None
            }
        };
        captures.push((label, level, cap));
    }
    println!();

    println!("PART 3 - level captured from each source, every 2 s (dB; -120 = nothing):");
    let rounds = (secs / 2).max(1);
    for round in 0..rounds {
        thread::sleep(Duration::from_secs(2));
        let mut line = format!("  t={:>3}s ", (round + 1) * 2);
        for (label, level, cap) in &captures {
            if cap.is_none() {
                continue;
            }
            let l = std::mem::take(&mut *level.lock().unwrap());
            let db = if l.n == 0 { -120.0 } else { 10.0 * ((l.sum_sq / l.n as f64).max(1e-12)).log10() };
            line.push_str(&format!(" | {label}: {db:.1}"));
        }
        println!("{line}");
    }

    for (_, _, cap) in captures {
        if let Some(c) = cap {
            c.stop();
        }
    }
    println!();
    println!("Done. Send this file to the Notizli team.");
    0
}
