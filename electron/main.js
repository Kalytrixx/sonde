// Sonde — application de bureau. Le serveur tourne dans ce même processus,
// sur un port local libre ; la fenêtre affiche son interface.

const { app, BrowserWindow, shell, Menu, dialog } = require("electron");
const path = require("path");
const net = require("net");

// Données de l'utilisateur : %APPDATA%\Sonde\data sous Windows,
// ~/.config/Sonde/data sous Linux (le dossier du programme est en lecture
// seule une fois installé).
process.env.SONDE_DATA = path.join(app.getPath("userData"), "data");

// Scan planifié (« Sonde.exe --scan C:/ ») : pas de fenêtre, le serveur
// scanne, enregistre l'historique, notifie si besoin et quitte. Sous Linux,
// la minuterie systemd lance directement server.js (ELECTRON_RUN_AS_NODE).
if (process.argv.includes("--scan")) {
  require("../server.js");
  return;
}

// Une seule fenêtre Sonde à la fois : un second lancement ramène la première.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let win = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitServer(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Le serveur interne de Sonde n'a pas démarré.");
}

async function start() {
  const port = await freePort();
  process.env.SONDE_PORT = String(port);
  require("../server.js");
  await waitServer(port);

  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    title: "Sonde", backgroundColor: "#0b0a17", show: false,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    // Barre de titre intégrée à l'interface ; les trois boutons du système restent à droite.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0b0a17", symbolColor: "#d9d4ff", height: 44 },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(null);
  win.once("ready-to-show", () => win.show());

  // Les liens externes (site AMD…) s'ouvrent dans le navigateur, jamais dans
  // la fenêtre de Sonde ; et la fenêtre ne quitte jamais le serveur local.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); shell.openExternal(url); }
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(start).catch((e) => {
  dialog.showErrorBox("Sonde", `Sonde n'a pas pu démarrer :\n\n${e.message}`);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
