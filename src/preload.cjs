const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notizli", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  openDashboard: () => ipcRenderer.invoke("open-dashboard"),
  openMeeting: (meetingId) => ipcRenderer.invoke("open-meeting", meetingId),
  unpair: () => ipcRenderer.invoke("unpair"),
  pairWithToken: (token) => ipcRenderer.invoke("pair-with-token", token),
  // buffer: ArrayBuffer of the recorded audio, written to disk by the main
  // process. Resolves with the saved recording's id. The bearer token never
  // leaves the main process.
  saveRecording: (payload) => ipcRenderer.invoke("save-recording", payload),
  uploadSaved: (id) => ipcRenderer.invoke("upload-saved", id),
  listUnsent: () => ipcRenderer.invoke("list-unsent"),
  showUnsent: () => ipcRenderer.invoke("show-unsent"),
  saveCopy: (id) => ipcRenderer.invoke("save-copy", id),
  confirmDiscard: () => ipcRenderer.invoke("confirm-discard"),
  setRecordingActive: (active) => ipcRenderer.send("recording-active", Boolean(active)),
  // Re-captures meeting audio from the current default output; resolves true on success.
  reconnectMeetingAudio: () => ipcRenderer.invoke("reconnect-meeting-audio"),
  // Windows: the meeting app's own sound via native/win-audio-helper.
  startNativeMeetingAudio: () => ipcRenderer.invoke("native-audio-start"),
  stopNativeMeetingAudio: () => ipcRenderer.invoke("native-audio-stop"),
  onNativeMeetingAudio: (onPcm, onEvent) => {
    const pcm = (_e, bytes) => onPcm(bytes);
    const ev = (_e, msg) => onEvent(msg);
    ipcRenderer.on("native-audio-pcm", pcm);
    ipcRenderer.on("native-audio-event", ev);
    return () => {
      ipcRenderer.removeListener("native-audio-pcm", pcm);
      ipcRenderer.removeListener("native-audio-event", ev);
    };
  },
  onPaired: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("paired", handler);
    return () => ipcRenderer.removeListener("paired", handler);
  },
});
