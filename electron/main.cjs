"use strict";

const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Dua instance akan memperebutkan database yang sama, jadi yang kedua cukup
// memunculkan jendela yang sudah ada lalu keluar.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const userData = app.getPath("userData");
migrateLegacyUserData(userData);
const dataDir = path.join(userData, "data");
fs.mkdirSync(dataDir, { recursive: true });

// Sampai setelah 1.0.1-beta aplikasi ini bernama The Architech, dan userData
// mengikuti productName — tanpa ini, pengguna lama membuka Undagi dan
// mendapati proyeknya hilang. Folder lama disalin, bukan dipindah, supaya
// kegagalan di tengah jalan tidak merusak apa pun; salinan hanya dibuat
// selama folder baru belum punya database. Berkas kunci Chromium dilewati
// karena instance ini sudah memegang kuncinya sendiri.
function migrateLegacyUserData(target) {
  const legacy = path.join(app.getPath("appData"), "The Architech");
  if (path.resolve(legacy) === path.resolve(target) || !fs.existsSync(legacy)) return;
  if (["undagi.db", "architech.db"].some((name) => fs.existsSync(path.join(target, "data", name)))) return;
  try {
    fs.cpSync(legacy, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (source) => !/^(Singleton|lockfile$)/.test(path.basename(source)),
    });
  } catch (error) {
    console.error("Could not copy data from The Architech:", error);
  }
}

// Server dan beberapa default-nya membaca cwd. Direktori instalasi sering
// read-only, jadi cwd dipindah ke folder data pengguna sebelum server dimuat:
// itu sekaligus membuat dotenv menemukan <userData>/.env.
process.chdir(userData);

process.env.NODE_ENV = "production";
process.env.UNDAGI_DATA_DIR = dataDir;
// Aset klien ikut di dalam paket, bukan di folder data.
const distDir = path.join(__dirname, "..", "dist").replace("app.asar", "app.asar.unpacked");
process.env.UNDAGI_DIST_DIR = distDir;
// Port 0 = OS memilih port bebas, supaya tidak bentrok dengan proses lain.
process.env.PORT = "0";
// Aplikasi desktop tidak perlu terekspos ke jaringan lokal.
process.env.HOST = "127.0.0.1";

let mainWindow = null;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: "#0b0b0c",
    show: false,
    autoHideMenuBar: true,
    // Tanpa ini jendela tidak membawa _NET_WM_ICON, dan desktop Linux jatuh ke
    // ikon aplikasi generiknya — sebuah gear — karena AppImage portable juga
    // tidak memasang entri .desktop yang bisa dicocokkan lewat WM_CLASS.
    icon: path.join(distDir, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Menampilkan jendela hanya setelah render pertama menghindari kedipan putih
  // di atas tema gelap.
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Tautan keluar dibuka di browser pengguna, bukan menggantikan aplikasi.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(async () => {
  try {
    const { serverReady } = require(path.join(__dirname, "..", "dist", "server.cjs"));
    const port = await serverReady;
    createWindow(port);
  } catch (error) {
    dialog.showErrorBox(
      "Undagi could not start",
      `The local server failed to start.\n\n${error && error.stack ? error.stack : String(error)}`
    );
    app.quit();
  }
});
