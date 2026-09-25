const { app, BrowserWindow, ipcMain, Menu, shell, dialog, safeStorage, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");

// Where this recorder uploads. Override at build/run time with
// NOTIZLI_BASE_URL=https://example.test so the next domain move is a rebuild
// rather than a code edit.
const NOTIZLI_BASE_URL = process.env.NOTIZLI_BASE_URL || "https://notizli.ch";
const PAIR_ENDPOINT = `${NOTIZLI_BASE_URL}/api/public/recorder/pair`;
const PAIR_PREVIEW_ENDPOINT = `${NOTIZLI_BASE_URL}/api/public/recorder/pair-preview`;
const UPLOAD_ENDPOINT = `${NOTIZLI_BASE_URL}/api/public/recorder/upload`;

// Hosts this app used to talk to. They still resolve, but only as a 301 to
// notizli.ch — and a 301 turns our POST into a bodyless GET and strips the
// bearer token, so a stored URL on one of these must be rewritten, not
// followed. See resolveUploadUrl().
const LEGACY_HOSTS = new Set(["callcap.quietly.ch"]);

const PROTOCOL = "notizli-sh";

// --- single-instance + protocol registration -----------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// --- config (device token) -----------------------------------------------
//
// The device token is the long-lived upload credential. It is stored
// encrypted with the OS keychain via safeStorage when available, and is
// never logged or exposed to the renderer.

const ENC_PREFIX = "enc:";

function encryptSecret(value) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(value).toString("base64");
    }
  } catch {
    /* fall through to plaintext */
  }
  return value;
}

function decryptSecret(stored) {
  if (typeof stored === "string" && stored.startsWith(ENC_PREFIX)) {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
  }
  return stored;
}

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
// The pairing response carries an absolute upload_url which we persist. A
// device paired before the notizli.ch move has one pointing at the old host;
// rewrite it onto the current origin, keeping whatever path the server chose.
function resolveUploadUrl(storedUrl) {
  if (!storedUrl) return UPLOAD_ENDPOINT;
  try {
    const u = new URL(storedUrl);
    if (LEGACY_HOSTS.has(u.hostname)) return `${NOTIZLI_BASE_URL}${u.pathname}${u.search}`;
    return storedUrl;
  } catch {
    return UPLOAD_ENDPOINT;
  }
}

function getDeviceToken() {
  const cfg = readConfig();
  if (!cfg.device_token) return null;
  try { return decryptSecret(cfg.device_token); } catch { return null; }
}

// --- unsent recordings ---------------------------------------------------
//
// Every recording is written to disk before it is uploaded and deleted only
// once the server has accepted it. A failed upload, a quit or a crash while
// uploading therefore never costs a meeting: whatever is still in this folder
// is offered for upload again from the idle screen.

const UNSENT_ID = /^\d{13}-[0-9a-f]{8}$/;
const uploadsInFlight = new Map(); // id -> Promise, so a retry can't post twice

function unsentDir() {
  return path.join(app.getPath("userData"), "unsent");
}
function unsentPaths(id) {
  // ids come back from the renderer; never let one name a path outside the folder
  if (!UNSENT_ID.test(String(id))) throw new Error("Unknown recording.");
  const dir = unsentDir();
  return { audio: path.join(dir, `${id}.webm`), meta: path.join(dir, `${id}.json`) };
}

function saveRecording({ buffer, mimeType, title, startedAt, channelLayout }) {
  fs.mkdirSync(unsentDir(), { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const p = unsentPaths(id);
  // Audio first, metadata second: the .json is what marks a recording as
  // complete, so a crash between the two can't list a half-written file.
  fs.writeFileSync(p.audio, Buffer.from(buffer));
  fs.writeFileSync(p.meta, JSON.stringify({ id, mimeType, title, startedAt, channelLayout }));
  return id;
}

function listUnsent() {
  let names;
  try { names = fs.readdirSync(unsentDir()); } catch { return []; }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(unsentDir(), n), "utf8"));
        const size = fs.statSync(unsentPaths(meta.id).audio).size;
        return {
          id: meta.id,
          title: meta.title || null,
          startedAt: meta.startedAt || null,
          size,
          uploading: uploadsInFlight.has(meta.id),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// POST a saved recording as multipart/form-data. The bearer token is attached
// here and never reaches the renderer. The server starts the transcription
// pipeline automatically on upload, so there is no separate /process call.
async function postRecording(id) {
  const p = unsentPaths(id);
  const token = getDeviceToken();
  if (!token) throw new Error("Not paired — pair this device first.");
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(p.audio)], { type: meta.mimeType || "audio/webm" });
  form.append("audio", blob, "recording.webm");
  if (meta.title) form.append("title", String(meta.title));
  if (meta.startedAt) form.append("started_at", String(meta.startedAt));
  // 'mic_remote' = two-channel (ch0 mic / ch1 far end); anything else the
  // server treats as 'mono'. See docs/Stereo-mono.md.
  form.append("channel_layout", meta.channelLayout === "mic_remote" ? "mic_remote" : "mono");

  const res = await fetch(resolveUploadUrl(readConfig().upload_url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const err = new Error(`Upload failed (${res.status}): ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  // Accepted. Drop the local copy before reading the body, so an unparseable
  // response can't leave it queued to be uploaded a second time.
  fs.rmSync(p.audio, { force: true });
  fs.rmSync(p.meta, { force: true });
  const json = await res.json().catch(() => ({}));
  return { meeting_id: json.meeting_id || null };
}

function uploadSaved(id) {
  if (!uploadsInFlight.has(id)) {
    uploadsInFlight.set(id, postRecording(id).finally(() => uploadsInFlight.delete(id)));
  }
  return uploadsInFlight.get(id);
}

// --- window --------------------------------------------------------------

let mainWindow = null;
// Set by the renderer while a recording exists only in memory. Pairing links
// are refused then, so a meeting can't switch accounts halfway through.
let recordingActive = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 600,
    title: "Notizli Self-Hosted",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Allow microphone + display capture for the recorder; deny everything else.
  const ses = mainWindow.webContents.session;
  const allow = (p) =>
    p === "media" || p === "audioCapture" || p === "microphone" || p === "display-capture";
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allow(permission));

  // The renderer calls getDisplayMedia() to capture system/output audio (the
  // remote participants). We intercept it here and hand Chromium the special
  // Electron 'loopback' audio source — a mix of everything the OS is playing.
  // This is what lets us record the other side of the call without a picker.
  // (Windows: WASAPI loopback; macOS 13+: ScreenCaptureKit, needs Screen
  // Recording permission.) A screen video source is required by the API even
  // though the renderer discards the video track.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          if (!sources.length) return callback({}); // no screen → renderer falls back to mic-only
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  // While a recording isn't on disk yet the renderer cancels unload in
  // beforeunload, which Electron does silently — so ask here. Closing the
  // window and quitting (Cmd+Q) both arrive in this handler.
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Discard and close"],
      defaultId: 0,
      cancelId: 0,
      message: "This recording hasn't been saved yet",
      detail: "Closing now throws it away. Finish the recording first — it's saved to this computer as soon as you do.",
    });
    if (choice === 1) event.preventDefault(); // let the unload go ahead
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; recordingActive = false; });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Window-modal on the recorder when it is open; free-standing otherwise (on
// macOS a pairing link can arrive while the window is closed).
function hasWindow() {
  return Boolean(mainWindow && !mainWindow.isDestroyed());
}
function showMessageBox(opts) {
  return hasWindow() ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);
}

// --- pairing flow --------------------------------------------------------

async function exchangePairingToken(pairingToken) {
  const res = await fetch(PAIR_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_token: pairingToken, device_label: `Desktop (${process.platform})` }),
  });
  if (!res.ok) throw new Error(`Pairing failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  const cfg = readConfig();
  cfg.device_token = encryptSecret(json.device_token);
  cfg.upload_url = resolveUploadUrl(json.upload_url);
  cfg.label = json.label;
  cfg.paired_at = new Date().toISOString();
  writeConfig(cfg);
  sendToRenderer("paired", { label: json.label });
  return { label: json.label };
}

// Which account a pairing token belongs to, without using it up. Throws a
// user-facing error for a dead token. `email` is null only when the server
// predates the preview endpoint (or can't be reached), so pairing still works
// against an older server, just without the address to check.
async function previewPairingToken(pairingToken) {
  let res;
  try {
    res = await fetch(PAIR_PREVIEW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_token: pairingToken }),
    });
  } catch {
    return { email: null };
  }
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const body = isJson ? await res.json().catch(() => ({})) : {};
  if (res.ok) return { email: typeof body.email === "string" ? body.email : null };
  if (isJson) throw new Error(body.error || "This pairing link can't be used. Start pairing again.");
  return { email: null };
}

// Any web page can open a notizli-sh://pair link, not only notizli.ch/pair,
// and anyone can talk someone into pasting a token, so pairing never happens
// silently. The dialog names the account the recordings would go to, and
// defaults to Cancel: otherwise someone else's link could route your next
// meetings to their account.
async function confirmPairing(email, source) {
  if (recordingActive) {
    await showMessageBox({
      type: "info",
      buttons: ["OK"],
      message: "Finish the recording first",
      detail: "This recorder can't be paired while a recording is in progress. Finish it, then open the pairing link again.",
    });
    return false;
  }
  const cfg = readConfig();
  const account = email ? `\u201c${email}\u201d` : "a Notizli account";
  const onlyIf = email
    ? "Only continue if that is your own account."
    : source === "link"
      ? "Only continue if you just clicked \u201cPair this device\u201d on notizli.ch yourself."
      : "Only continue if you generated this token on notizli.ch yourself.";
  if (cfg.device_token) {
    const { response } = await showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Switch account"],
      defaultId: 0,
      cancelId: 0,
      message: email ? `Switch this recorder to ${email}?` : "Switch this recorder to another account?",
      detail:
        `It is paired${cfg.label ? ` as \u201c${cfg.label}\u201d` : ""}. Recordings made after this ` +
        `would upload to ${account}.\n\n${onlyIf}`,
    });
    return response === 1;
  }
  const { response } = await showMessageBox({
    type: "question",
    buttons: ["Cancel", "Pair"],
    defaultId: 0,
    cancelId: 0,
    message: email ? `Pair this recorder with ${email}?` : "Pair this recorder with your Notizli account?",
    detail: `Recordings made on this computer will upload to ${account}.\n\n${onlyIf}`,
  });
  return response === 1;
}

async function handleProtocolUrl(url) {
  let token = null;
  try {
    const u = new URL(url);
    if (u.host === "pair") token = u.searchParams.get("token");
  } catch {
    console.error("Bad protocol URL"); // not the URL itself: it carries the token
    return;
  }
  if (!token) return;
  // On a cold start macOS delivers open-url before the app is ready, and no
  // dialog can be shown until it is.
  await app.whenReady();
  try {
    const { email } = await previewPairingToken(token);
    if (!(await confirmPairing(email, "link"))) return;
    await exchangePairingToken(token);
  } catch (err) {
    dialog.showErrorBox("Pairing failed", String((err && err.message) || err));
  }
}

// --- protocol handlers (mac vs win/linux differ) -------------------------

app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleProtocolUrl(url);
});

app.on("second-instance", (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const protoArg = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (protoArg) void handleProtocolUrl(protoArg);
});

// --- IPC -----------------------------------------------------------------

ipcMain.handle("get-status", () => {
  const cfg = readConfig();
  return {
    paired: Boolean(cfg.device_token),
    label: cfg.label || null,
    pairedAt: cfg.paired_at || null,
    version: app.getVersion(),
    platform: process.platform,
  };
});

// --- Windows meeting-audio helper -------------------------------------------
//
// native/win-audio-helper: records the meeting app's own sound (Windows
// process loopback) wherever it plays. Electron's "loopback" below can only
// record the default speaker's mix, and on laptops that came back silent for
// Teams on the built-in speakers. The helper streams mono f32 PCM at 48 kHz on
// stdout and JSON events on stderr; closing its stdin stops it.

let audioHelper = null;

function audioHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "notizli-audio-helper.exe")
    : path.join(__dirname, "..", "native", "win-audio-helper", "target", "release", "notizli-audio-helper.exe");
}

function stopAudioHelper() {
  const child = audioHelper;
  audioHelper = null;
  if (!child) return;
  try { child.stdin.end(); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 1500);
}

ipcMain.handle("native-audio-start", (e) => new Promise((resolve) => {
  if (process.platform !== "win32") return resolve({ ok: false, reason: "not-windows" });
  const exe = audioHelperPath();
  if (!fs.existsSync(exe)) return resolve({ ok: false, reason: "helper missing" });
  stopAudioHelper();

  const wc = e.sender;
  let settled = false;
  let child;
  const settle = (r) => {
    if (settled) return;
    settled = true;
    if (!r.ok && audioHelper === child) stopAudioHelper();
    resolve(r);
  };
  try {
    child = spawn(exe, ["--exclude-pid", String(process.pid)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    return settle({ ok: false, reason: String(err) });
  }
  audioHelper = child;

  child.stdout.on("data", (buf) => { if (!wc.isDestroyed()) wc.send("native-audio-pcm", buf); });
  let pending = "";
  child.stderr.on("data", (d) => {
    pending += d.toString("utf8");
    let i;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i).trim();
      pending = pending.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event === "ready") settle({ ok: true });
      if (!wc.isDestroyed()) wc.send("native-audio-event", msg);
    }
  });
  child.on("error", (err) => settle({ ok: false, reason: String(err) }));
  child.on("exit", (code) => {
    const wasCurrent = audioHelper === child;
    if (wasCurrent) audioHelper = null;
    settle({ ok: false, reason: `exited with ${code}` });
    // Only an unexpected exit matters to the renderer: it falls back.
    if (wasCurrent && !wc.isDestroyed()) wc.send("native-audio-event", { event: "exit", code });
  });
  setTimeout(() => settle({ ok: false, reason: "timeout" }), 4000);
}));

ipcMain.handle("native-audio-stop", () => stopAudioHelper());
app.on("will-quit", stopAudioHelper);

// The loopback source is bound to whichever output device was the default when
// it was captured, and does not follow a later switch (headset unplugged,
// Bluetooth dropped, dock or screen disconnected): the meeting side then goes
// silent for the rest of the call. The renderer re-captures on a device change,
// but getDisplayMedia needs a user gesture it doesn't have at that moment, so
// it asks us to run the reconnect as one.
ipcMain.handle("reconnect-meeting-audio", (e) =>
  e.sender
    .executeJavaScript("window.__notizliReconnectMeetingAudio ? window.__notizliReconnectMeetingAudio() : false", true)
    .catch(() => false),
);

ipcMain.handle("open-dashboard", () => shell.openExternal(`${NOTIZLI_BASE_URL}/pair`));
ipcMain.handle("open-meeting", (_e, meetingId) => {
  if (typeof meetingId === "string" && meetingId) {
    return shell.openExternal(`${NOTIZLI_BASE_URL}/meetings/${encodeURIComponent(meetingId)}`);
  }
});
ipcMain.handle("unpair", () => { writeConfig({}); return true; });
ipcMain.handle("pair-with-token", async (_e, token) => {
  try {
    const t = String(token || "").trim();
    const { email } = await previewPairingToken(t);
    if (!(await confirmPairing(email, "paste"))) return { ok: false, error: "Pairing cancelled." };
    const r = await exchangePairingToken(t);
    return { ok: true, label: r.label };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// A finished recording arrives here as raw bytes and goes to disk before
// anything else happens; the renderer then asks for it to be uploaded by id.
ipcMain.handle("save-recording", (_e, payload) => saveRecording(payload || {}));

ipcMain.handle("upload-saved", async (_e, id) => {
  try {
    return { ok: true, ...(await uploadSaved(String(id))) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), status: (err && err.status) || null };
  }
});

ipcMain.handle("list-unsent", () => listUnsent());

ipcMain.handle("show-unsent", () => {
  fs.mkdirSync(unsentDir(), { recursive: true });
  return shell.openPath(unsentDir());
});

ipcMain.handle("save-copy", async (_e, id) => {
  const p = unsentPaths(String(id));
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  const name = String(meta.title || "Notizli recording").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").slice(0, 120);
  const opts = {
    defaultPath: path.join(app.getPath("documents"), `${name}.webm`),
    filters: [{ name: "Audio", extensions: ["webm"] }],
  };
  const r = hasWindow() ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { ok: false };
  fs.copyFileSync(p.audio, r.filePath);
  return { ok: true, path: r.filePath };
});

ipcMain.handle("confirm-discard", async () => {
  const { response } = await showMessageBox({
    type: "warning",
    buttons: ["Keep it", "Discard"],
    defaultId: 0,
    cancelId: 0,
    message: "Discard this recording?",
    detail: "The audio is deleted and nothing is uploaded. This can't be undone.",
  });
  return response === 1;
});

ipcMain.on("recording-active", (_e, active) => { recordingActive = Boolean(active); });

// --- lifecycle -----------------------------------------------------------

app.whenReady().then(() => {
  createWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ]},
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ]},
  ]));

  // Handle protocol URL passed at cold start (Windows/Linux)
  const cold = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (cold) void handleProtocolUrl(cold);

  // Auto-updates (no-op in dev)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error("update check failed", e));
    setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
