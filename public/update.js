// Sonde — version en bas de la barre latérale et annonce d'une mise à jour.
// L'écran de mise à jour lui-même est dans settings.js.
"use strict";

let updToasted = null;

// La version en bas à gauche ouvre Paramètres › Mise à jour (settings.js).
function openUpdate() { show("set-update"); }

// Version en bas de la barre latérale, avec une pastille quand une mise à jour attend.
function syncVersion() {
  const u = state.status?.update;
  if (!u) return;
  $("#verText").textContent = `Sonde ${u.version}`;
  $("#verBtn").classList.toggle("has-update", !!u.available);
  $("#verBtn").title = u.available ? `Version ${u.available} disponible` : "Mises à jour de Sonde";
  if (u.available && updToasted !== u.available) {
    updToasted = u.available;
    toast(`Sonde ${u.available} est disponible : clique sur la version, en bas à gauche.`, 7000);
  }
}
setInterval(syncVersion, 5000);
window.addEventListener("DOMContentLoaded", () => setTimeout(syncVersion, 1500));

$("#verBtn").onclick = openUpdate;
