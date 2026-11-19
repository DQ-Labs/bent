import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Native Instruments Traktor Kontrol F1 USB IDs
const NI_VENDOR_ID = 0x17cc;
const F1_PRODUCT_ID = 0x1120;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bent-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#090a0f',
    title: 'BENT // Video Bending & Traktor F1 Workstation',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  const ses = mainWindow.webContents.session;

  // Automatically grant WebMIDI & WebHID permissions for the Traktor Kontrol F1
  ses.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'midi' || permission === 'midiSysex' || permission === 'hid') {
      return true;
    }
    return true;
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'midi' || permission === 'midiSysex' || permission === 'hid') {
      callback(true);
      return;
    }
    callback(true);
  });

  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'hid') {
      return true;
    }
    return true;
  });

  // When navigator.hid.requestDevice() is called, automatically pick the Traktor Kontrol F1
  // (or the first matched device in the filter list) without blocking on a browser popup.
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (!details.deviceList || details.deviceList.length === 0) {
      callback('');
      return;
    }
    const f1 = details.deviceList.find(
      (d) => d.vendorId === NI_VENDOR_ID && d.productId === F1_PRODUCT_ID
    ) || details.deviceList.find(
      (d) => d.vendorId === NI_VENDOR_ID
    ) || details.deviceList[0];

    callback(f1 ? f1.deviceId : '');
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  if (process.argv.includes('--smoke-test')) {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        await new Promise((r) => setTimeout(r, 900));
        const check = await mainWindow.webContents.executeJavaScript(`
          (() => {
            const app = window.bentApp;
            if (!app || !app.bender || !app.f1 || !app.pianoRoll) {
              throw new Error('Bent app modules did not initialize');
            }
            // Exercise Mode 1 (Edit), Mode 2 (Perform + Recording), Mode 3 (Playback Piano Roll)
            app.handleF1PadDown(2);
            app.handleF1PadUp(2);
            app.setMode('perform');
            app.startRecordingTake();
            app.handleF1PadDown(5);
            app.handleF1MacroChange(0, 0.72);
            app.handleF1MacroChange(4, 0.65);
            app.handleF1PadDown(12); // FX Punch
            app.handleF1PadUp(12);
            app.stopRecordingTake();
            // stopRecordingTake automatically transitions to Playback Mode
            return {
              mode: app.mode,
              takesCount: app.project.takes.length,
              activePad: app.activeClipPadIndex,
              glWidth: app.bender.canvas.width
            };
          })()
        `);
        console.log('SMOKE_TEST_OK:', JSON.stringify(check));
        app.exit(0);
      } catch (err) {
        console.error('SMOKE_TEST_FAIL:', err);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  // Stream local video & audio files cleanly via bent-media://local?path=...
  protocol.handle('bent-media', (request) => {
    const reqUrl = new URL(request.url);
    const filePath = reqUrl.searchParams.get('path');
    if (!filePath) {
      return new Response('Missing file path', { status: 400 });
    }
    const fileUrl = pathToFileURL(filePath).toString();
    return net.fetch(fileUrl, {
      headers: request.headers
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers for local media & project persistence
ipcMain.handle('bent:pick-videos', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Video Clips into Clip Pool',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) {
    return [];
  }
  return result.filePaths.map((fp) => ({
    path: fp,
    name: path.basename(fp),
    mediaUrl: `bent-media://local?path=${encodeURIComponent(fp)}`
  }));
});

ipcMain.handle('bent:pick-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Music Track for Performance & Timeline',
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) {
    return null;
  }
  const fp = result.filePaths[0];
  const buffer = await fs.readFile(fp);
  return {
    path: fp,
    name: path.basename(fp),
    mediaUrl: `bent-media://local?path=${encodeURIComponent(fp)}`,
    arrayBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
});

ipcMain.handle('bent:read-audio-path', async (_event, fp) => {
  try {
    const buffer = await fs.readFile(fp);
    return {
      path: fp,
      name: path.basename(fp),
      mediaUrl: `bent-media://local?path=${encodeURIComponent(fp)}`,
      arrayBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('bent:save-project', async (_event, { jsonString, currentPath }) => {
  let targetPath = currentPath;
  if (!targetPath) {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Bent Project',
      defaultPath: 'session.bent',
      filters: [{ name: 'Bent Project', extensions: ['bent', 'json'] }]
    });
    if (res.canceled || !res.filePath) {
      return { canceled: true };
    }
    targetPath = res.filePath;
  }
  await fs.writeFile(targetPath, jsonString, 'utf8');
  return { canceled: false, filePath: targetPath };
});

ipcMain.handle('bent:open-project', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Bent Project',
    properties: ['openFile'],
    filters: [{ name: 'Bent Project', extensions: ['bent', 'json'] }]
  });
  if (res.canceled || !res.filePaths.length) {
    return { canceled: true };
  }
  const filePath = res.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  return { canceled: false, filePath, content };
});
