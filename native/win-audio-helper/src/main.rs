//! Notizli meeting-audio helper (Windows only).
//!
//! Records the far end of a call by capturing the WHOLE SPEAKER (endpoint
//! loopback) that the meeting app is playing on — not just the Windows default
//! speaker, which is all Electron's own `"loopback"` can record. Per-app
//! process loopback is used only by `--diagnose`: on the affected laptop it
//! returned digital zeros while the speaker's loopback heard the call
//! (see FINDINGS.md).
//!
//! Speaker choice, re-checked every `--poll-ms` (default 1 s), switched only
//! when the new speaker holds for two checks:
//!   1. the speaker where a known meeting app (Teams, Zoom, Webex…) has its
//!      loudest active audio session
//!   2. otherwise the speaker where a browser (Chrome, Edge…) is playing
//!   3. otherwise the Windows default speaker
//! The app found is only a label ("hearing Microsoft Teams"); the capture is
//! everything that speaker plays.
//!
//! Protocol with the Electron main process:
//!   stdout  raw PCM, f32 little-endian, mono, 48 000 Hz, continuous while captured
//!   stderr  one JSON object per line: ready | target {mode:"device",name,app} | level | error
//!           (exit code 3 when no speaker can be captured: the app falls back)
//!   stdin   closed by the parent → exit (so the helper never outlives the app)
//!
//! `--level-test` writes no PCM and prints the captured level once a second,
//! for checking a machine by hand from a terminal.

#[cfg(windows)]
mod win;

fn main() {
    #[cfg(windows)]
    {
        std::process::exit(win::run(std::env::args().skip(1).collect()));
    }
    #[cfg(not(windows))]
    {
        eprintln!("{}", serde_json::json!({ "event": "error", "message": "Windows only" }));
        std::process::exit(2);
    }
}
