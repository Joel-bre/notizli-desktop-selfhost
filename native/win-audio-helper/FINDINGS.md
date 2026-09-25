# Windows capture: diagnose v3 result (25 Sep 2026)

Machine: the Windows 11 Pro laptop from the diagnostics handoff (Realtek
speakers, external LG monitor). Teams call heard on the laptop speakers, far
end talking the whole time. Artifact `notizli-audio-diagnose-2`.

## Measured

- Windows default speaker **and** default call speaker: `Speakers (Realtek(R) Audio)`.
- Teams plays from `ms-teams.exe(812)` (child of `ms-teams.exe(19760)`), two
  active sessions on the Realtek speakers, session peaks up to 0.9.
- Speaker meter showed sound in 15 of 15 two-second checks (peaks 0.45–0.99).

| Capture | Result over 30 s |
|---|---|
| Process loopback, `ms-teams.exe(812)` + tree | packets arrive, not flagged silent, every sample exactly 0 (−120 dB) |
| Process loopback, `ms-teams.exe(19760)` + tree | same: digital zero |
| Process loopback, everything except the helper (exclude mode) | same: digital zero |
| **Endpoint loopback of `Speakers (Realtek(R) Audio)`** | **heard in 15/15 checks, −10.6 … −22.6 dB** |

## Conclusions

- Process loopback delivers only zeros on this laptop **for every app**, not
  just Teams (exclude mode is zero too). That explains the per-app build's
  silent channel (handoff F8). The audio does pass through the Windows mixer:
  endpoint loopback of the same speaker hears it clearly.
- Exact cause of the zeros is unproven. Candidates: the laptop's audio path
  (e.g. hardware audio offload on newer power-efficient laptops, which keeps
  per-app streams out of the software engine while the driver still provides a
  loopback of the final mix), or an issue in the process-loopback code path.
  Not worth more tests: the fallback works.
- With the default speaker on the Realtek device, Electron's default-device
  loopback would also hear Teams. The earlier Electron failures (F1) most
  likely happened while the default was another device (the LG monitor), as
  the handoff suspected.

## Decision for the new recorder

On Windows, capture the other side with **endpoint loopback of the speaker the
meeting app is actually playing on** (found from the active audio sessions on
all render devices), re-checked every ~2 s and re-opened on device changes.
Use the session meters only to label what is heard ("Hearing: Microsoft Teams").
Per-app process loopback is not used in v1.
