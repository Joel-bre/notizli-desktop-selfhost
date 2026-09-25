//! Notizli meeting-audio helper (Windows only).
//!
//! Captures the far end of a call straight from the meeting app's process tree
//! (Windows process loopback, 10 2004+), whichever speaker it plays on and
//! before driver "call enhancement" processing. Electron's own `"loopback"`
//! can only record the default speaker's mix, which on a laptop with Teams on
//! its speakers came back as digital silence.
//!
//! Target choice, re-checked every `--poll-ms`:
//!   1. a known meeting app with an active audio session (Teams, Zoom, Webex…)
//!   2. otherwise a browser with an active session (Chrome, Edge…)
//!   3. otherwise everything the computer plays except Notizli (`--exclude-pid`)
//!
//! Protocol with the Electron main process:
//!   stdout  raw PCM, f32 little-endian, mono, 48 000 Hz, continuous while captured
//!   stderr  one JSON object per line: ready | target | level | error
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
