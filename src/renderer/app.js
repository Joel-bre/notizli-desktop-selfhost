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
const listeningSel = $("listening");
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
const errorNote = $("error-note");
const retryBtn = $("error-retry-btn");
const saveCopyBtn = $("error-save-btn");
const backBtn = $("error-back-btn");
const stopBtn = $("stop-btn");
const discardBtn = $("discard-btn");
const unsentRow = $("unsent-row");
const unsentText = $("unsent-text");
const unsentUploadBtn = $("unsent-upload-btn");
const unsentShowBtn = $("unsent-show-btn");

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
let remoteHeard = false;
let platform = "";              // from the main process: "win32", "darwin", …
let defaultOutput = null;       // label of the default speaker when meeting audio was captured
let reconnectTimer = null;
let reconnecting = false;
let quietWhileTalkingMs = 0;    // see the meter loop
let lastTick = 0;
let meetingWarning = false;
let nativeFeeder = null;        // AudioWorkletNode fed by the Windows helper, when in use
let pcmCarry = null;            // bytes of a sample split across two IPC chunks
let hearing = "";               // what the helper reports it is capturing
let statusResetTimer = null;
const isWindows = () => platform === "win32";

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
function buildStereoMix(ctx, mic, sysNode) {
  const micMono = toMono(ctx, ctx.createMediaStreamSource(mic));
  // The meeting side goes through a fixed mono node so its source can be
  // swapped mid-recording (see reconnectMeetingAudio) without touching the
  // merger, the recorder or the channel order.
  const sysMono = ctx.createGain();
  sysMono.channelCount = 1;
  sysMono.channelCountMode = "explicit";
  sysMono.channelInterpretation = "speakers";
  let sysSource = sysNode;
  sysSource.connect(sysMono);

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
    replaceSystem: (next) => {
      next.connect(sysMono);
      sysSource.disconnect();
      sysSource = next;
    },
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
// How long the meeting side may stay silent while the microphone hears speech
// before the recording screen says so. A lone notification blip must not count
// as "the meeting is audible": it used to silence the only hint for a whole
// 80-minute call whose meeting side was dead after minute 4.
const QUIET_WARN_MS = 120_000;
const QUIET_CLEAR_MS = 60_000;

function updateMeetingWarning(mic, remote, dt) {
  if (channelLayout !== "mic_remote") return;
  if (remote >= 0.02) quietWhileTalkingMs = Math.max(0, quietWhileTalkingMs - dt * 4);
  else if (mic >= 0.05 && remote < 0.01) quietWhileTalkingMs += dt;
  if (!meetingWarning && quietWhileTalkingMs > QUIET_WARN_MS) {
    meetingWarning = true;
    recStatus.innerHTML = `<span class="warn-text">${meetingWarningText()}</span>`;
  } else if (meetingWarning && quietWhileTalkingMs < QUIET_CLEAR_MS) {
    meetingWarning = false;
    setBothSidesStatus();
  }
}

function meetingWarningText() {
  if (nativeFeeder) {
    return `Notizli can't hear the meeting — only your microphone. It is listening to ${hearing || "the computer's sound"}; check the call isn't muted in the meeting app.`;
  }
  return isWindows()
    ? "Notizli can't hear the meeting — only your microphone. Make sure the call plays through your Windows default speaker (Teams: Settings → Devices → Speaker: Default)."
    : "Notizli can't hear the meeting — only your microphone. Make sure the call plays through your Mac's current sound output.";
}

function setBothSidesStatus() {
  recStatus.textContent = hearing
    ? `Both sides captured — Hearing: ${hearing}. Uploads when you finish.`
    : "Both sides captured on separate channels. Uploads when you finish.";
  recStatus.className = "ok-text";
}

function startMeters() {
  lastTick = performance.now();
  const tick = () => {
    const { mic, remote } = mix.levels();
    const now = performance.now();
    const dt = Math.min(1000, now - lastTick);
    lastTick = now;
    micFill.style.width = `${Math.round(mic * 100)}%`;
    remFill.style.width = `${Math.round(remote * 100)}%`;
    updateMeetingWarning(mic, remote, dt);
    const elapsed = (Date.now() - timerStart) / 1000;
    if (remote >= 0.01) remoteHeard = true;
    // Only while meeting audio has never produced a sound. A pause later in
    // the conversation is normal and shouldn't look like a fault.
    remHint.textContent =
      channelLayout === "mic_remote" && !remoteHeard && elapsed > 12 ? "no sound yet" : "";
    meterRaf = requestAnimationFrame(tick);
  };
  meterRaf = requestAnimationFrame(tick);
}

// ---- following the default speaker -------------------------------------
//
// Meeting audio is captured from the output device that was the default when
// recording started, and Chromium does not follow a later switch. Unplugging a
// headset mid-call therefore left the meeting side silent until the end (while
// the default microphone did follow). On any device change we compare the
// default speaker and, if it moved, capture it again and swap it in; the
// recording itself keeps running, with a gap of about a second on that side.

async function currentDefaultOutput() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const d = devices.find((x) => x.kind === "audiooutput" && x.deviceId === "default");
    return d ? d.label : null;
  } catch {
    return null;
  }
}

function onDeviceChange() {
  void listDevices();
  // Proven on Windows (WASAPI loopback). macOS captures through ScreenCaptureKit,
  // which is not tied to an output device, so it is left alone there.
  // The native helper follows the meeting app on any device by itself.
  if (!isWindows() || nativeFeeder || !mix || !mix.replaceSystem) return;
  clearTimeout(reconnectTimer);
  // Windows fires several events while a device comes and goes; the new
  // default is only settled once they stop.
  reconnectTimer = setTimeout(async () => {
    if (!mix || !mix.replaceSystem) return;
    const label = await currentDefaultOutput();
    if (label !== null && label === defaultOutput) return;
    const ok = await window.notizli.reconnectMeetingAudio();
    if (ok && mix) flashStatus("Speaker changed — meeting audio reconnected.");
  }, 1500);
}

// Run by the main process with a user gesture (getDisplayMedia requires one).
window.__notizliReconnectMeetingAudio = async () => {
  if (!mix || !mix.replaceSystem || reconnecting) return false;
  reconnecting = true;
  try {
    const next = await captureSystemAudio();
    if (!next) return false;
    if (!mix || !mix.replaceSystem) {
      next.getTracks().forEach((t) => t.stop());
      return false;
    }
    const prev = systemStream;
    mix.replaceSystem(audioCtx.createMediaStreamSource(next));
    systemStream = next;
    if (prev) prev.getTracks().forEach((t) => t.stop());
    defaultOutput = await currentDefaultOutput();
    return true;
  } finally {
    reconnecting = false;
  }
};

// ---- Windows: the speaker the call plays on ------------------------------------
//
// native/win-audio-helper records the whole speaker that the call app (Teams,
// Zoom, Webex, Slack, WhatsApp, then browsers) is playing on, else the Windows
// default speaker — Electron's own loopback only ever records the default one.
// It is tried first on Windows; if it can't start, or dies mid-call, recording
// falls back to Electron's default-speaker loopback.

async function startNativeMeetingAudio(ctx) {
  if (!isWindows() || !window.notizli.startNativeMeetingAudio) return null;
  try {
    await ctx.audioWorklet.addModule("./pcm-feeder.js");
  } catch {
    return null;
  }
  const node = new AudioWorkletNode(ctx, "pcm-feeder", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  nativeFeeder = node;
  pcmCarry = null;
  hearing = "";
  const r = await window.notizli.startNativeMeetingAudio().catch(() => ({ ok: false }));
  if (!r || !r.ok) {
    nativeFeeder = null;
    node.disconnect();
    return null;
  }
  return node;
}

function onNativePcm(bytes) {
  if (!nativeFeeder) return;
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (pcmCarry) {
    const joined = new Uint8Array(pcmCarry.length + u8.length);
    joined.set(pcmCarry, 0);
    joined.set(u8, pcmCarry.length);
    u8 = joined;
    pcmCarry = null;
  }
  const whole = u8.length - (u8.length % 4);
  if (whole < u8.length) pcmCarry = u8.slice(whole);
  if (!whole) return;
  const samples = new Float32Array(u8.slice(0, whole).buffer);
  nativeFeeder.port.postMessage(samples, [samples.buffer]);
}

function onNativeEvent(msg) {
  if (!msg || !nativeFeeder) return;
  if (msg.event === "target") {
    // mode "device": the speaker being recorded, and the call app heard on it.
    hearing = msg.app ? `${msg.app} on ${msg.name}` : msg.name || "";
    if (!meetingWarning) setBothSidesStatus();
  } else if (msg.event === "exit" && mix && mix.replaceSystem) {
    // Helper died mid-call: continue on Electron's loopback rather than lose
    // the meeting side for the rest of the recording.
    const dead = nativeFeeder;
    nativeFeeder = null;
    hearing = "";
    void window.notizli.reconnectMeetingAudio().then((ok) => {
      if (dead) dead.disconnect();
      flashStatus(ok ? "Meeting audio switched to the default speaker." : "Meeting audio lost — recording your microphone.");
    });
  }
}

if (window.notizli.onNativeMeetingAudio) window.notizli.onNativeMeetingAudio(onNativePcm, onNativeEvent);

function flashStatus(text) {
  if (meetingWarning) return;
  recStatus.textContent = text;
  recStatus.className = "ok-text";
  clearTimeout(statusResetTimer);
  statusResetTimer = setTimeout(() => { if (!meetingWarning && mix) setBothSidesStatus(); }, 6000);
}

// ---- record flow -----------------------------------------------------
async function startRecording() {
  show("starting");
  refreshDefaultName();

  const deviceId = deviceSel.value;
  // On speakers the microphone's echo canceller must stay OFF: with it on,
  // Chromium/Windows treats the meeting audio as echo and the loopback channel
  // goes silent (the Lovable-era recorder had it off for exactly this reason;
  // turning it on in the self-host port is what broke Teams-on-speakers).
  // On headphones there is no echo, so the cleanup only helps the mic.
  const onHeadphones = listeningSel.value === "headphones";
  const micConstraints = {
    echoCancellation: onHeadphones,
    noiseSuppression: onHeadphones,
    autoGainControl: onHeadphones,
  };
  if (deviceId) micConstraints.deviceId = { exact: deviceId };

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
  } catch {
    return fail(
      "Microphone unavailable",
      isWindows()
        ? "Notizli couldn't open the microphone. Check Windows Settings → Privacy & security → Microphone (and \"Let desktop apps access your microphone\"), then try again."
        : "Notizli couldn't open the microphone. Check macOS → Privacy & Security → Microphone, then try again.",
    );
  }
  void listDevices();

  quietWhileTalkingMs = 0;
  meetingWarning = false;
  // 48 kHz to match the helper's PCM (and Opus); Chromium resamples the mic.
  audioCtx = new AudioContext({ sampleRate: 48000 });

  let sysNode = await startNativeMeetingAudio(audioCtx);
  if (!sysNode) {
    systemStream = await captureSystemAudio();
    if (systemStream) sysNode = audioCtx.createMediaStreamSource(systemStream);
  }
  defaultOutput = await currentDefaultOutput();

  if (sysNode) {
    channelLayout = "mic_remote";
    mix = buildStereoMix(audioCtx, micStream, sysNode);
    setBothSidesStatus();
    recLabel.textContent = "Recording — both sides";
  } else {
    channelLayout = "mono";
    mix = buildMonoMic(audioCtx, micStream);
    recStatus.innerHTML = isWindows()
      ? '<span class="warn-text">Meeting audio unavailable — recording your microphone only.</span>'
      : '<span class="warn-text">Meeting audio unavailable — recording your microphone only. Grant Screen&nbsp;Recording and relaunch to capture the other side.</span>';
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
  setUnsafeToClose(true);

  remoteHeard = false;
  stopBtn.hidden = false;
  discardBtn.hidden = false;
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
  clearTimeout(reconnectTimer);
  clearTimeout(statusResetTimer);
  [micStream, systemStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  micStream = systemStream = null;
  if (nativeFeeder) {
    nativeFeeder = null;
    hearing = "";
    void window.notizli.stopNativeMeetingAudio();
  }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  mix = null;
}

// ---- close guard -----------------------------------------------------
//
// True from the moment audio is captured until it is on disk. While it is,
// closing the window or quitting asks first (main.cjs, will-prevent-unload),
// and pairing links are refused.
let unsafeToClose = false;
function setUnsafeToClose(v) {
  unsafeToClose = v;
  window.notizli.setRecordingActive(v);
}
window.addEventListener("beforeunload", (e) => {
  if (unsafeToClose) e.returnValue = false;
});

// ---- saving + upload --------------------------------------------------
//
// A finished recording is written to disk by the main process first and
// uploaded from there. It is deleted only once the server accepts it; until
// then the idle screen offers it for upload again, so nothing is lost to a
// failed upload, a quit or a crash.

let currentId = null; // saved recording the upload / error screens are about
let unsaved = null;   // a recording that could not be written to disk — still only in memory
let uploadGen = 0;    // bumped whenever the upload screen is abandoned

function errText(err) {
  // ipcRenderer.invoke wraps errors as "Error invoking remote method '…': Error: …"
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

function showBusy(text) {
  show("recording");
  recPulse.style.visibility = "hidden";
  recLabel.textContent = text;
  recStatus.textContent = text;
  recStatus.className = "";
  // The recording is over: Stop and Discard must not be reachable while it
  // saves and uploads, or a stale upload result lands on top of the next one.
  stopBtn.hidden = true;
  discardBtn.hidden = true;
}

async function onRecordingStop() {
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
  const blob = new Blob(chunks, { type: mimeType });
  chunks = [];
  teardownAudio();

  if (blob.size === 0) {
    setUnsafeToClose(false);
    return fail("Nothing was recorded", "The recording came back empty. Try again.");
  }
  await saveAndUpload({
    buffer: await blob.arrayBuffer(),
    mimeType,
    title: nameInput.value.trim() || defaultName(new Date(startedAtIso)),
    startedAt: startedAtIso,
    channelLayout,
  });
}

async function saveAndUpload(rec) {
  showBusy("Saving…");
  try {
    currentId = await window.notizli.saveRecording(rec);
  } catch (err) {
    unsaved = rec;
    return fail("Couldn't save the recording", errText(err), {
      retry: "Try again",
      note: "It is still held in memory, so don't quit the app. If the disk is full, free up some space, then try again.",
    });
  }
  unsaved = null;
  setUnsafeToClose(false);
  await uploadCurrent();
}

async function uploadCurrent() {
  const gen = ++uploadGen;
  showBusy("Uploading…");
  let r;
  try {
    r = await window.notizli.uploadSaved(currentId);
  } catch (err) {
    // This screen has no buttons, so a throw here must still land on the
    // error screen rather than leave "Uploading…" up forever.
    r = { ok: false, error: errText(err) };
  }
  if (gen !== uploadGen) return; // the user moved on while it ran
  if (r.ok) {
    lastMeetingId = r.meeting_id;
    currentId = null;
    show("done");
    $("open-meeting-btn").style.display = lastMeetingId ? "" : "none";
  } else {
    fail("Upload failed", r.error, {
      retry: "Try upload again",
      saveCopy: true,
      note:
        "The recording is saved on this computer, so nothing is lost. If you go back, it stays queued " +
        "and you can upload it later from the start screen.",
    });
  }
}

function fail(title, msg, { retry = null, saveCopy = false, note = "" } = {}) {
  errorTitle.textContent = title;
  errorMsg.textContent = msg;
  errorNote.textContent = note;
  errorNote.hidden = !note;
  retryBtn.hidden = !retry;
  if (retry) retryBtn.textContent = retry;
  saveCopyBtn.hidden = !saveCopy;
  show("error");
}

// ---- recordings waiting to upload ------------------------------------------
let unsentBusy = false;
let unsentLastError = "";

async function renderUnsent() {
  if (unsentBusy) return;
  let list;
  try {
    list = await window.notizli.listUnsent();
  } catch {
    return; // keep whatever the banner showed; the next poll tries again
  }
  unsentRow.hidden = list.length === 0;
  if (!list.length) { unsentLastError = ""; return; }
  const n = list.length;
  const uploading = list.some((r) => r.uploading);
  unsentText.textContent = uploading
    ? `Uploading ${n === 1 ? "a recording" : `${n} recordings`}…`
    : `${n === 1 ? "1 recording hasn't" : `${n} recordings haven't`} uploaded yet.` +
      (unsentLastError ? ` Last try failed: ${unsentLastError}.` : "");
  unsentUploadBtn.hidden = uploading;
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
$("discard-btn").addEventListener("click", async () => {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  if (!(await window.notizli.confirmDiscard())) return;
  if (mediaRecorder.state !== "recording") return; // finished while the dialog was open
  mediaRecorder.onstop = null;
  mediaRecorder.stop();
  teardownAudio();
  chunks = [];
  nameEdited = false;
  setUnsafeToClose(false);
  void refresh({ force: true });
});
$("open-meeting-btn").addEventListener("click", () => { if (lastMeetingId) window.notizli.openMeeting(lastMeetingId); });
$("record-another-btn").addEventListener("click", () => { nameEdited = false; void refresh({ force: true }); });
retryBtn.addEventListener("click", () => {
  if (unsaved) void saveAndUpload(unsaved);
  else if (currentId) void uploadCurrent();
});
saveCopyBtn.addEventListener("click", async () => {
  if (!currentId) return;
  try {
    const r = await window.notizli.saveCopy(currentId);
    if (r && r.ok) { errorNote.textContent = `Saved a copy to ${r.path}`; errorNote.hidden = false; }
  } catch (err) {
    errorNote.textContent = `Couldn't save a copy: ${errText(err)}`;
    errorNote.hidden = false;
  }
});
backBtn.addEventListener("click", async () => {
  if (unsaved) {
    // Only case where Back loses audio: it never made it to disk.
    if (!(await window.notizli.confirmDiscard())) return;
    unsaved = null;
    setUnsafeToClose(false);
  }
  uploadGen++;
  currentId = null; // a saved one stays queued on disk
  void refresh({ force: true });
});
unsentUploadBtn.addEventListener("click", async () => {
  unsentBusy = true;
  unsentUploadBtn.hidden = true;
  unsentLastError = "";
  try {
    const list = await window.notizli.listUnsent();
    for (let i = 0; i < list.length; i++) {
      unsentText.textContent = `Uploading ${i + 1} of ${list.length}…`;
      const r = await window.notizli.uploadSaved(list[i].id);
      if (!r.ok) unsentLastError = r.status ? `the server answered ${r.status}` : r.error;
    }
  } catch (err) {
    unsentLastError = errText(err);
  } finally {
    unsentBusy = false; // never leave the banner frozen
  }
  await renderUnsent();
});
unsentShowBtn.addEventListener("click", () => void window.notizli.showUnsent());

// ---- status poll ---------------------------------------------------
//
// force=true means the user asked to go back to the idle screen (Record
// another / Discard / Back). Without it we only land on idle when nothing
// else is on screen, so a background poll can't yank anyone out of a
// recording, an upload, or an error they haven't read yet.
async function refresh({ force = false } = {}) {
  const s = await window.notizli.getStatus();
  versionEl.textContent = "v" + s.version;
  if (s.platform && s.platform !== platform) {
    platform = s.platform;
    applyPlatformCopy();
  }
  paired = Boolean(s.paired);
  if (!paired) { show("unpaired"); return; }
  pairedLabel.textContent = s.label ? `Paired — ${s.label}` : "Paired";
  const active = ["s-recording", "s-starting", "s-done", "s-error"].some((id) => !$(id).hidden);
  if (force || !active) { refreshDefaultName(); show("idle"); }
  if (!sections.idle.hidden) void renderUnsent();
}

// The static copy is written for macOS; Windows has no Screen Recording grant
// and hears the meeting through the default speaker instead.
function applyPlatformCopy() {
  if (!isWindows()) return;
  $("perm-note").textContent =
    "Notizli records your microphone and whatever plays through your Windows default speaker — that is how it hears the other side. Keep the call on the default speaker (Teams: Speaker → Default).";
  $("starting-title").textContent = "Starting…";
  $("starting-note").textContent = "Opening your microphone and the meeting audio.";
}

try {
  const saved = localStorage.getItem("notizli.listening");
  if (saved === "headphones" || saved === "speakers") listeningSel.value = saved;
} catch { /* storage unavailable — keep the default */ }
listeningSel.addEventListener("change", () => {
  try { localStorage.setItem("notizli.listening", listeningSel.value); } catch { /* ignore */ }
});

window.notizli.onPaired(() => { void refresh(); void listDevices(); });
void refresh();
void listDevices();
navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
setInterval(() => void refresh(), 3000);
