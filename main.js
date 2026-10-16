const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.tubegrab');
}

const PORT = process.env.PORT || 3000;
let mainWindow = null;

function checkServerReady(port, retries = 30, interval = 200) {
  return new Promise(resolve => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(`http://localhost:${port}/health`, res => {
        if (res.statusCode === 200) return resolve(true);
        if (attempts >= retries) return resolve(false);
        setTimeout(check, interval);
      });
      req.on('error', () => {
        if (attempts >= retries) return resolve(false);
        setTimeout(check, interval);
      });
      req.end();
    };
    check();
  });
}

function startBackendServer() {
  try {
    require('./server.js');
  } catch (err) {
    console.error('Failed to start server:', err);
  }
}

async function createWindow() {
  const logoFile = path.join(__dirname, 'public', 'logo.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 460,
    minHeight: 560,
    title: 'TubeGrab',
    icon: logoFile,
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Ensure backend is running
  const isReady = await checkServerReady(PORT, 3, 100);
  if (!isReady) {
    startBackendServer();
    await checkServerReady(PORT, 40, 150);
  }

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Automatically save downloads directly to the user's native system Downloads folder
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const downloadsFolder = app.getPath('downloads');
    const targetFile = path.join(downloadsFolder, item.getFilename());
    item.setSavePath(targetFile);
  });

  // Open external links (like github/docs) in system default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
