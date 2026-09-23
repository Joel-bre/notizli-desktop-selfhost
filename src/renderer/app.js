/**
 * Notizli desktop recorder — renderer.
 *
 * Capture model mirrors the web recorder (src/lib/recorder/capture.ts):
 * mic and system audio are summed to true mono individually, then merged into
 * ONE two-channel track — channel 0 (left) = microphone / account holder,
 * channel 1 (right) = system audio / far end. That order is load-bearing: the
 * server folds per-channel speaker ids as ch0 -> speaker 0, ch1 -> 1 + n, so
 * swapping the channels inverts "me" vs "them" on every action item.
 *
 * The upload is tagged `channel_layout=mic_remote` so the pipeline transcribes
 * each side separately. If system audio is unavailable we fall back to a single
 * mono track tagged `mono`, which is the pre-existing behaviour.
 */

// ---- elements --------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const sections = {
  unpaired: $("s-unpaired"),
  idle: $("s-idle"),
  starting: $("s-starting"),
  recording: $("s-recording"),
  done: $("s-done"),
  error: $("s-error"),
};
const versionEl = $("version");
const pairedLabel = $("paired-label");
const nameInput = $("meeting-name");
const deviceSel = $("device");
const tokenInput = $("token-input");
const tokenMsg = $("token-msg");
const timerEl = $("timer");
const recLabel = $("rec-label");
const recPulse = $("rec-pulse");
const recStatus = $("rec-status");
const micFill = $("mic-fill");
const remFill = $("rem-fill");
const micHint = $("mic-hint");
const remHint = $("rem-hint");
const errorTitle = $("error-title");
const errorMsg = $("error-msg");

function show(name) {
  for (const [k, el] of Object.entries(sections)) el.hidden = k !== name;
}

// ---- recorder state -------------------------------------------------------
let paired = false;
let mediaRecorder = null;
let chunks = [];
let micStream = null;
let systemStream = null;
let audioCtx = null;
let mix = null;
let meterRaf = 0;
let timerHandle = null;
let timerStart = 0;
let startedAtIso = null;
let channelLayout = "mono";
let lastMeetingId = null;
let nameEdited = false;

function pad(n) { return String(n).padStart(2, "0"); }
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
function defaultName(d) { return `Desktop recording — ${d.toLocaleString()}`; }
function refreshDefaultName() { if (!nameEdited) nameInput.value = defaultName(new Date()); }
nameInput.addEventListener("input", () => { nameEdited = nameInput.value.trim().length > 0; });

// ---- device list --------------------------------------------------------
async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const current = deviceSel.value;
    deviceSel.innerHTML = "";
    const def = document.createElement("option");
    def.value = ""; def.textContent = "Default microphone";
    deviceSel.appendChild(def);
    inputs.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      deviceSel.appendChild(opt);
    });
    if (current) deviceSel.value = current;
  } catch { /* leave the Default option */ }
}

// ---- capture ------------------------------------------------------------
/** Sum any source to a true mono node (not just its left channel). */
function toMono(ctx, node) {
  const g = ctx.createGain();
  g.channelCount = 1;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  node.connect(g);
  return g;
}

/**
 * Capture the system / output audio (the far end) via the loopback source the
 * main process supplies to getDisplayMedia. Video is requested only because the
 * API demands it, then dropped. Returns a MediaStream of just the system audio,
 * or null if it is unavailable / denied.
 */
async function captureSystemAudio() {
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    display.getVideoTracks().forEach((t) => t.stop());
    const audio = display.getAudioTracks();
    if (audio.length === 0) return null;
    return new MediaStream(audio);
  } catch {
    return null;
  }
}

/**
 * mic -> mono -> merger input 0 (LEFT, channel 0)
 * sys -> mono -> merger input 1 (RIGHT, channel 1)
 * plus one analyser per side, read before the merge, for the level meters.
 */
function buildStereoMix(ctx, mic, sys) {
  const micMono = toMono(ctx, ctx.createMediaStreamSource(mic));
  const sysMono = toMono(ctx, ctx.createMediaStreamSource(sys));

  const micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 256;
  const sysAnalyser = ctx.createAnalyser(); sysAnalyser.fftSize = 256;
  micMono.connect(micAnalyser);
  sysMono.connect(sysAnalyser);

  const merger = ctx.createChannelMerger(2);
  micMono.connect(merger, 0, 0);
  sysMono.connect(merger, 0, 1);

  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  dest.channelCountMode = "explicit";
  dest.channelInterpretation = "speakers";
  merger.connect(dest);

  const micBuf = new Uint8Array(micAnalyser.frequencyBinCount);
  const sysBuf = new Uint8Array(sysAnalyser.frequencyBinCount);
  const rms = (an, buf) => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / buf.length) * 3);
  };
  return {
    stream: dest.stream,
    levels: () => ({ mic: rms(micAnalyser, micBuf), remote: rms(sysAnalyser, sysBuf) }),
  };
}

/** Mic-only fallback: one analyser, one mono track. */
function buildMonoMic(ctx, mic) {
  const src = toMono(ctx, ctx.createMediaStreamSource(mic));
  const an = ctx.createAnalyser(); an.fftSize = 256;
  src.connect(an);
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  src.connect(dest);
  const buf = new Uint8Array(an.frequencyBinCount);
  const rms = () => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / buf.length) * 3);
  };
  return { stream: dest.stream, levels: () => ({ mic: rms(), remote: 0 }) };
}

function pickMimeType() {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const m of c) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

// ---- meter loop -------------------------------------------------------
function startMeters() {
  const tick = () => {
    const { mic, remote } = mix.levels();
    micFill.style.width = `${Math.round(mic * 100)}%`;
    remFill.style.width = `${Math.round(remote * 100)}%`;
    const elapsed = (Date.now() - timerStart) / 1000;
    if (channelLayout === "mic_remote" && remote < 0.01 && elapsed > 12) {
      remHint.textContent = "no sound yet";
    } else {
      remHint.textContent = "";
    }
    meterRaf = requestAnimationFrame(tick);
  };
  meterRaf = requestAnimationFrame(tick);
}

// ---- record flow -----------------------------------------------------
async function startRecording() {
  show("starting");
  refreshDefaultName();

  const deviceId = deviceSel.value;
  const micConstraints = {
    // Match the web recorder: cancel the far end back out of the mic so a user
    // on speakers doesn't capture the other side twice. The clean copy of the
    // far end comes from the loopback channel, not the room.
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) micConstraints.deviceId = { exact: deviceId };

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
  } catch {
    return fail("Microphone unavailable", "Notizli couldn't open the microphone. Check macOS → Privacy & Security → Microphone, then try again.");
  }
  void listDevices();

  systemStream = await captureSystemAudio();

  audioCtx = new AudioContext();
  if (systemStream) {
    channelLayout = "mic_remote";
    mix = buildStereoMix(audioCtx, micStream, systemStream);
    recStatus.textContent = "Both sides captured on separate channels. Uploads when you finish.";
    recStatus.className = "ok-text";
    recLabel.textContent = "Recording — both sides";
  } else {
    channelLayout = "mono";
    mix = buildMonoMic(audioCtx, micStream);
    recStatus.innerHTML = '<span class="warn-text">Meeting audio unavailable — recording your microphone only. Grant Screen&nbsp;Recording and relaunch to capture the other side.</span>';
    recLabel.textContent = "Recording — mic only";
  }

  const mimeType = pickMimeType();
  chunks = [];
  mediaRecorder = new MediaRecorder(
    mix.stream,
    Object.assign({ audioBitsPerSecond: 128000 }, mimeType ? { mimeType } : {}),
  );
  startedAtIso = new Date().toISOString();
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start(1000);

  show("recording");
  micFill.style.width = "0%";
  remFill.style.width = "0%";
  remHint.textContent = "";
  recPulse.style.visibility = "visible";
  timerStart = Date.now();
  timerEl.textContent = "00:00";
  timerHandle = setInterval(() => { timerEl.textContent = fmtClock(Date.now() - timerStart); }, 500);
  startMeters();
}

function teardownAudio() {
  cancelAnimationFrame(meterRaf);
  clearInterval(timerHandle);
  [micStream, systemStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  micStream = systemStream = null;
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  mix = null;
}

let pendingUpload = null; // { blob, mimeType } kept across an upload retry

async function onRecordingStop() {
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
  const blob = new Blob(chunks, { type: mimeType });
  chunks = [];
  teardownAudio();

  if (blob.size === 0) {
    return fail("Nothing was recorded", "The recording came back empty. Try again.", false);
  }
  pendingUpload = { blob, mimeType };
  await uploadPending();
}

async function uploadPending() {
  if (!pendingUpload) return;
  recPulse.style.visibility = "hidden";
  show("recording");
  recLabel.textContent = "Uploading…";
  recStatus.textContent = "Uploading…";
  recStatus.className = "";
  try {
    const buffer = await pendingUpload.blob.arrayBuffer();
    const title = nameInput.value.trim() || defaultName(new Date(startedAtIso));
    const res = await window.notizli.uploadRecording({
      buffer,
      mimeType: pendingUpload.mimeType,
      title,
      startedAt: startedAtIso,
      channelLayout,
    });
    lastMeetingId = res && res.meeting_id;
    pendingUpload = null;
    show("done");
    $("open-meeting-btn").style.display = lastMeetingId ? "" : "none";
  } catch (err) {
    fail("Upload failed", (err && err.message) || "The recording is still held — try uploading again.", true);
  }
}

function fail(title, msg, retryUpload) {
  errorTitle.textContent = title;
  errorMsg.textContent = msg;
  $("error-retry-btn").textContent = retryUpload ? "Try upload again" : "Back";
  show("error");
}

// ---- pairing ---------------------------------------------------------
async function submitToken() {
  const t = tokenInput.value.trim();
  if (!t) { tokenMsg.textContent = "Paste a token first."; tokenMsg.hidden = false; return; }
  const btn = $("submit-token-btn");
  btn.disabled = true; btn.textContent = "Pairing…";
  const r = await window.notizli.pairWithToken(t);
  btn.disabled = false; btn.textContent = "Pair with token";
  tokenMsg.hidden = false;
  if (r && r.ok) {
    tokenInput.value = "";
    tokenMsg.textContent = "Paired.";
    tokenMsg.className = "ok-text";
    void refresh();
  } else {
    tokenMsg.textContent = (r && r.error) || "Pairing failed.";
    tokenMsg.className = "warn-text";
  }
}

// ---- wiring ---------------------------------------------------------
$("pair-btn").addEventListener("click", () => window.notizli.openDashboard());
$("submit-token-btn").addEventListener("click", () => void submitToken());
$("unpair-btn").addEventListener("click", async () => { await window.notizli.unpair(); void refresh({ force: true }); });
$("record-btn").addEventListener("click", () => void startRecording());
$("stop-btn").addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    recLabel.textContent = "Finishing…";
    mediaRecorder.stop();
  }
});
$("discard-btn").addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  teardownAudio();
  chunks = [];
  pendingUpload = null;
  nameEdited = false;
  void refresh({ force: true });
});
$("open-meeting-btn").addEventListener("click", () => { if (lastMeetingId) window.notizli.openMeeting(lastMeetingId); });
$("record-another-btn").addEventListener("click", () => { nameEdited = false; void refresh({ force: true }); });
$("error-retry-btn").addEventListener("click", () => {
  if (pendingUpload) void uploadPending();
  else void refresh({ force: true });
});

// ---- status poll ---------------------------------------------------
//
// force=true means the user asked to go back to the idle screen (Record
// another / Discard / Back). Without it we only land on idle when nothing
// else is on screen, so a background poll can't yank anyone out of a
// recording, an upload, or an error they haven't read yet.
async function refresh({ force = false } = {}) {
  const s = await window.notizli.getStatus();
  versionEl.textContent = "v" + s.version;
  paired = Boolean(s.paired);
  if (!paired) { show("unpaired"); return; }
  pairedLabel.textContent = s.label ? `Paired — ${s.label}` : "Paired";
  const active = ["s-recording", "s-starting", "s-done", "s-error"].some((id) => !$(id).hidden);
  if (force || !active) { refreshDefaultName(); show("idle"); }
}

window.notizli.onPaired(() => { void refresh(); void listDevices(); });
void refresh();
void listDevices();
navigator.mediaDevices.addEventListener("devicechange", listDevices);
setInterval(() => void refresh(), 3000);
