const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bentDesktop', {
  pickVideos: () => ipcRenderer.invoke('bent:pick-videos'),
  pickAudio: () => ipcRenderer.invoke('bent:pick-audio'),
  readAudioPath: (filePath) => ipcRenderer.invoke('bent:read-audio-path', filePath),
  saveProject: (payload) => ipcRenderer.invoke('bent:save-project', payload),
  openProject: () => ipcRenderer.invoke('bent:open-project'),
  toMediaUrl: (filePath) => `bent-media://local?path=${encodeURIComponent(filePath)}`
});
