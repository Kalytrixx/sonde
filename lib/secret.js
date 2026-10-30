// Chiffrement des clés d'API. Dans l'application installée, Electron confie
// la clé au système : DPAPI sous Windows, trousseau GNOME (libsecret) sous
// Linux. Depuis les sources (node seul), ce n'est pas possible : la clé est
// alors gardée en clair dans les réglages, et l'interface le signale.

let safe = null;
try {
  if (process.versions.electron) safe = require("electron").safeStorage;
} catch {}

// La clé est-elle vraiment protégée par le système ? Sous Linux sans
// trousseau, Electron se rabat sur un chiffrement factice (« basic_text »).
function protectedStorage() {
  try {
    if (!safe || !safe.isEncryptionAvailable()) return false;
    if (process.platform === "linux" && typeof safe.getSelectedStorageBackend === "function") {
      return !["basic_text", "unknown"].includes(safe.getSelectedStorageBackend());
    }
    return true;
  } catch { return false; }
}

function seal(text) {
  if (!text) return null;
  if (protectedStorage()) return { enc: safe.encryptString(text).toString("base64") };
  return { plain: text };
}

function open(box) {
  if (!box) return null;
  if (box.plain) return box.plain;
  if (box.enc) {
    try { return safe ? safe.decryptString(Buffer.from(box.enc, "base64")) : null; } catch { return null; }
  }
  return null;
}

module.exports = { seal, open, protectedStorage };
