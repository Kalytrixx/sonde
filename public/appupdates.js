// Sonde — Applications › Mises à jour (Windows) : ce qui a une version plus
// récente d'après winget, et mise à jour d'un clic, en direct.
"use strict";

V.appupdates = async () => {
  const v = $("#view-appupdates");
  v.innerHTML = loading("Recherche des mises à jour (winget, jusqu'à une minute)");
  let d;
  try { d = await api("/api/appupdates"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  if (!d.winget) {
    v.append(head("Mises à jour des applications", "winget, l'outil de Microsoft qui connaît les nouvelles versions des programmes, n'est pas disponible sur ce PC."));
    v.append(el(`<div class="panel muted">Installe « Programme d'installation d'application » (App Installer) depuis le Microsoft Store, puis reviens ici.</div>`));
    return;
  }
  // Une nouvelle version « majeure » (premier numéro différent) peut changer le
  // fonctionnement du programme : elle n'est pas cochée d'office.
  // (Une version sans point, comme « 272 », n'a pas de numéro majeur.)
  const major = (a, b) => /\./.test(a) && /\./.test(b) && (String(a).match(/\d+/) || [])[0] !== (String(b).match(/\d+/) || [])[0];
  const items = d.items.map((i) => ({ ...i, major: major(i.version, i.available) }));
  const todo = items.filter((i) => !i.self);
  const picked = new Set(todo.filter((i) => !i.major).map((i) => i.id));
  const go = btn("", () => run(go), "primary");
  const label = () => { go.textContent = picked.size ? `Mettre à jour ${picked.size} application${picked.size > 1 ? "s" : ""}` : "Rien de coché"; go.disabled = !picked.size; };
  v.append(head("Mises à jour des applications",
    `${todo.length} programme${todo.length > 1 ? "s" : ""} ${todo.length > 1 ? "ont" : "a"} une version plus récente, d'après winget (l'outil de Microsoft). Les mises à jour se téléchargent depuis le site de chaque éditeur ; certaines demandent l'autorisation administrateur.`,
    go, btn("Actualiser", () => V.appupdates())));

  const live = el(`<div></div>`);
  v.append(live);
  const rows = {};
  const list = el(`<div class="opt-list"></div>`);
  for (const i of items) {
    const o = el(`<div class="opt chk"><button class="check ${picked.has(i.id) ? "on" : ""}" ${i.self ? "disabled" : ""}></button><div style="min-width:0"><div class="on-name"></div><div class="on-why"></div></div><span class="fromto"></span><span class="rsize"></span></div>`);
    $(".on-name", o).innerHTML = `${esc(i.name)} <small>${esc(i.id)}</small>${i.major && !i.self ? ` <span class="tag warn">nouvelle version majeure</span>` : ""}${i.self ? ` <span class="tag">${esc(i.self)}</span>` : ""}`;
    $(".on-why", o).textContent = i.major && !i.self ? "Le premier numéro de version change : nouveautés possibles, parfois des réglages à revoir. Coche-la si tu veux la faire maintenant." : "";
    $(".fromto", o).innerHTML = `<s>${esc(i.version)}</s><i>→</i><b>${esc(i.available)}</b>`;
    if (!i.self) o.onclick = () => { const on = !picked.has(i.id); on ? picked.add(i.id) : picked.delete(i.id); $(".check", o).classList.toggle("on", on); label(); };
    else o.style.opacity = ".55";
    rows[i.id] = o;
    list.append(o);
  }
  if (!items.length) list.append(el(`<div class="empty">✓ Toutes tes applications connues de winget sont à jour.</div>`));
  v.append(list);
  v.append(el(`<p class="hint" style="margin-top:12px">winget ne connaît que les programmes publiés dans son catalogue : les jeux, les pilotes et certains logiciels n'y figurent pas. Les applications du Microsoft Store se mettent à jour depuis le Store.</p>`));
  label();

  async function run(b) {
    const ids = [...picked];
    if (!ids.length) return;
    if (!await confirmBox({ title: `Mettre à jour ${ids.length} application${ids.length > 1 ? "s" : ""} ?`, ok: "Mettre à jour",
      body: `<p>Chaque programme est mis à jour à son tour, sans fenêtre. Ferme-les avant si possible : un programme ouvert peut empêcher sa mise à jour.</p><p>Certains demanderont l'autorisation administrateur (fenêtre de Windows).</p>` })) return;
    b.disabled = true;
    live.innerHTML = "";
    const p = el(`<div class="panel"><div class="panel-title"></div><div class="sprog-bar"><span style="width:2%"></span></div><div class="trash-now"></div></div>`);
    live.append(p);
    let total = ids.length, idx = 0, okN = 0, ko = [];
    try {
      await streamApi("/api/appupdates/run", { ids }, (e) => {
        if (e.type === "step") { idx = e.index; total = e.total; $(".panel-title", p).textContent = `${e.index + 1} / ${e.total} · ${e.label}`; $(".sprog-bar span", p).style.width = `${Math.max(2, (idx / total) * 100)}%`; }
        else if (e.type === "progress") $(".sprog-bar span", p).style.width = `${((idx + e.pct / 100) / total) * 100}%`;
        else if (e.type === "log") $(".trash-now", p).textContent = e.text;
        else if (e.type === "result") {
          const o = rows[e.id];
          if (o) $(".rsize", o).innerHTML = e.ok ? `<span class="tag good">à jour</span>` : `<span class="tag bad">échec</span>`;
          e.ok ? okN++ : ko.push(e.id);
        } else if (e.type === "error") toast(e.error, 8000);
      });
    } catch (err) { toast(err.message, 8000); }
    b.disabled = false;
    $(".panel-title", p).textContent = `${okN} application${okN > 1 ? "s" : ""} mise${okN > 1 ? "s" : ""} à jour${ko.length ? `, ${ko.length} échec${ko.length > 1 ? "s" : ""} (programme ouvert, ou mise à jour refusée)` : ""}.`;
    $(".sprog-bar", p).remove();
    toast(okN ? "Mises à jour terminées. Enregistré dans le journal." : "Aucune mise à jour n'a abouti.", 6000);
  }
};
