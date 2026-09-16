const { app, BrowserWindow, ipcMain, Menu, shell, dialog, safeStorage, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

// Where this recorder uploads. Override at build/run time with
// NOTIZLI_BASE_URL=https://example.test so the next domain move is a rebuild
// rather than a code edit.
const NOTIZLI_BASE_URL = process.env.NOTIZLI_BASE_URL || "https://notizli.ch";
const PAIR_ENDPOINT = `${NOTIZLI_BASE_URL}/api/public/recorder/pair`;
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

// --- window --------------------------------------------------------------

let mainWindow = null;

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

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
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

function handleProtocolUrl(url) {
  try {
    const u = new URL(url);
    if (u.host !== "pair") return;
    const token = u.searchParams.get("token");
    if (!token) return;
    exchangePairingToken(token).catch((err) => {
      dialog.showErrorBox("Pairing failed", err.message);
    });
  } catch (err) {
    console.error("Bad protocol URL", url);
  }
}

// --- protocol handlers (mac vs win/linux differ) -------------------------

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

app.on("second-instance", (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const protoArg = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (protoArg) handleProtocolUrl(protoArg);
});

// --- IPC -----------------------------------------------------------------

ipcMain.handle("get-status", () => {
  const cfg = readConfig();
  return {
    paired: Boolean(cfg.device_token),
    label: cfg.label || null,
    pairedAt: cfg.paired_at || null,
    version: app.getVersion(),
  };
});

ipcMain.handle("open-dashboard", () => shell.openExternal(`${NOTIZLI_BASE_URL}/pair`));
ipcMain.handle("open-meeting", (_e, meetingId) => {
  if (typeof meetingId === "string" && meetingId) {
    return shell.openExternal(`${NOTIZLI_BASE_URL}/meetings/${encodeURIComponent(meetingId)}`);
  }
});
ipcMain.handle("unpair", () => { writeConfig({}); return true; });
ipcMain.handle("pair-with-token", async (_e, token) => {
  try {
    const r = await exchangePairingToken(String(token || "").trim());
    return { ok: true, label: r.label };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Upload a recording. The renderer captures audio and hands us the raw
// bytes; we attach the bearer token (kept out of the renderer) and POST
// multipart/form-data to the upload endpoint. The server starts the
// transcription pipeline automatically on upload, so there is no separate
// /process call to make here.
ipcMain.handle("upload-recording", async (_e, { buffer, mimeType, title, startedAt, channelLayout }) => {
  const token = getDeviceToken();
  if (!token) throw new Error("Not paired — pair this device first.");

  const cfg = readConfig();
  const uploadUrl = resolveUploadUrl(cfg.upload_url);

  const form = new FormData();
  const blob = new Blob([Buffer.from(buffer)], { type: mimeType || "audio/webm" });
  form.append("audio", blob, "recording.webm");
  if (title) form.append("title", String(title));
  if (startedAt) form.append("started_at", String(startedAt));
  // 'mic_remote' = two-channel (ch0 mic / ch1 far end); anything else the
  // server treats as 'mono'. See docs/Stereo-mono.md.
  form.append("channel_layout", channelLayout === "mic_remote" ? "mic_remote" : "mono");

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return { meeting_id: json.meeting_id };
});

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
  if (cold) handleProtocolUrl(cold);

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
