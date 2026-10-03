"use strict";

const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");

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

// Aplikasi yang dibuka dari Finder, Dock, atau menu desktop Linux tidak
// mendapat PATH terminal pengguna. macOS memberi PATH launchd
// (/usr/bin:/bin:/usr/sbin:/sbin); desktop Linux memberi PATH sesi, tanpa
// tambahan dari .bashrc seperti nvm. Akibatnya codex, claude, atau agy tidak
// ditemukan, begitu pula node yang dibutuhkan skrip codex dari npm. PATH
// diambil dari login shell pengguna. Kalau gagal atau lewat 5 detik, PATH
// bawaan tetap dipakai, dan path runtime masih bisa diisi sendiri di
// Connections. Windows membaca PATH dari registry, jadi tidak perlu.
//
// Login shell interaktif butuh ~2 detik di mesin dengan nvm atau conda, dan
// dulu dijalankan sinkron sebelum jendela dibuat, jadi tiap peluncuran menunggu
// sebanyak itu. Sekarang PATH hasil peluncuran sebelumnya dipakai langsung dan
// shell dibaca di latar belakang. Hanya peluncuran pertama, yang belum punya
// salinan, masih menunggu.
const shellPathCache = path.join(userData, "shell-path.txt");

function readCachedShellPath() {
  try {
    return fs.readFileSync(shellPathCache, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readLoginShellPath() {
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
      ["-ilc", 'printf "\\n__UNDAGI_PATH__%s__UNDAGI_PATH__" "$PATH"'],
      { encoding: "utf8", timeout: 5000 },
      (error, stdout) => {
        if (error) console.error("Could not read PATH from the login shell:", error);
        resolve(/__UNDAGI_PATH__(.*)__UNDAGI_PATH__/.exec(String(stdout || ""))?.[1] || null);
      }
    );
  });
}

const cachedShellPath = process.platform === "win32" ? null : readCachedShellPath();
if (cachedShellPath) process.env.PATH = cachedShellPath;

// Resolves true when the login shell's PATH differs from the one already in use.
const shellPathRefreshed = process.platform === "win32"
  ? Promise.resolve(false)
  : readLoginShellPath().then((fresh) => {
      if (!fresh || fresh === process.env.PATH) return false;
      process.env.PATH = fresh;
      try {
        fs.writeFileSync(shellPathCache, fresh);
      } catch (error) {
        console.error("Could not save the shell PATH:", error);
      }
      return true;
    });

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
    // Without a saved PATH (the first launch) the server would look for the CLIs
    // on the bare session PATH, so wait for the shell. Afterwards, do not.
    if (!cachedShellPath) await shellPathRefreshed;
    const { serverReady } = require(path.join(__dirname, "..", "dist", "server.cjs"));
    const port = await serverReady;
    createWindow(port);
    // The PATH changed since the last launch, such as a new nvm node version:
    // what the server detected with the saved one may be out of date.
    if (cachedShellPath) {
      void shellPathRefreshed.then((changed) => {
        if (changed) fetch(`http://127.0.0.1:${port}/api/runtimes/discover`, { method: "POST" }).catch(() => undefined);
      });
    }
  } catch (error) {
    dialog.showErrorBox(
      "Undagi could not start",
      `The local server failed to start.\n\n${error && error.stack ? error.stack : String(error)}`
    );
    app.quit();
  }
});
