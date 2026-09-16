const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notizli", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  openDashboard: () => ipcRenderer.invoke("open-dashboard"),
  openMeeting: (meetingId) => ipcRenderer.invoke("open-meeting", meetingId),
  unpair: () => ipcRenderer.invoke("unpair"),
  pairWithToken: (token) => ipcRenderer.invoke("pair-with-token", token),
  // buffer: ArrayBuffer of the recorded audio. The bearer token never
  // leaves the main process.
  uploadRecording: (payload) => ipcRenderer.invoke("upload-recording", payload),
  onPaired: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("paired", handler);
    return () => ipcRenderer.removeListener("paired", handler);
  },
});
