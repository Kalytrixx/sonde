// Connexion Internet : diagnostic, mesures (ping, DNS, débit) et
// optimisations proposées uniquement quand une mesure les justifie.

const ps = require("../../ps");

// Serveurs DNS publics proposés. La page ne peut choisir que parmi eux.
const DNS = {
  cloudflare: { label: "Cloudflare", servers: ["1.1.1.1", "1.0.0.1"] },
  google: { label: "Google", servers: ["8.8.8.8", "8.8.4.4"] },
  quad9: { label: "Quad9 (bloque les sites malveillants)", servers: ["9.9.9.9", "149.112.112.112"] },
};
const DOMAINS = ["wikipedia.org", "github.com", "reddit.com", "amazon.fr", "lemonde.fr", "twitch.tv", "steamcommunity.com", "youtube.com"];
// Réglages d'économie d'énergie Ethernet connus (Realtek, Intel…).
const EEE_KEYS = ["*EEE", "EEE", "EnableGreenEthernet", "AdvancedEEE", "GigaLite", "*GreenEthernet", "PowerSavingMode"];

const INFO = `
$ads = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up'
$adapters = foreach ($a in $ads) {
  $ip = (Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
  $dns = @((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses)
  $static = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($a.InterfaceGuid)" -ErrorAction SilentlyContinue).NameServer
  $eee = @(Get-NetAdapterAdvancedProperty -Name $a.Name -ErrorAction SilentlyContinue | Where-Object { $_.RegistryKeyword -in $A.eee } |
    ForEach-Object { @{ keyword = $_.RegistryKeyword; label = $_.DisplayName; display = $_.DisplayValue; value = "$($_.RegistryValue)" } })
  @{ name = $a.Name; desc = $a.InterfaceDescription; speed = [int64]$a.ReceiveLinkSpeed; media = "$($a.PhysicalMediaType)"
     ifIndex = $a.ifIndex; ip = $ip; dns = $dns; dnsStatic = [bool]$static; eee = $eee
     wifi = ("$($a.PhysicalMediaType)" -match '802.11') }
}
$wifi = $null
if ($adapters | Where-Object { $_.wifi }) {
  $w = netsh wlan show interfaces | Out-String
  $sig = [regex]::Match($w, 'Signal\\s*:\\s*(\\d+)').Groups[1].Value
  $ssid = [regex]::Match($w, '\\n\\s*SSID\\s*:\\s*(.+)').Groups[1].Value.Trim()
  $wifi = @{ signal = [int]$sig; ssid = $ssid }
}
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
$tcp = (Get-NetTCPSetting -SettingName Internet -ErrorAction SilentlyContinue).AutoTuningLevelLocal
$doPolicy = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization' -Name DODownloadMode -ErrorAction SilentlyContinue).DODownloadMode
$doUp = $null
try { $s = Get-DeliveryOptimizationPerfSnapThisMonth; $doUp = [int64]$s.UploadInternetBytes } catch {}
$names = @{}; $pubs = @{}; foreach ($p in Get-Process) { $names[$p.Id] = $p.ProcessName; $pubs[$p.Id] = $p.Company }
$apps = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
  Where-Object { $_.RemoteAddress -notmatch '^(127\\.|::1|0\\.)' } |
  Group-Object OwningProcess | ForEach-Object {
    @{ name = $names[[int]$_.Name]; pub = $pubs[[int]$_.Name]; pid = [int]$_.Name; conns = $_.Count; hosts = @($_.Group.RemoteAddress | Sort-Object -Unique).Count } } |
  Sort-Object { $_.conns } -Descending | Select-Object -First 15
@{ adapters = @($adapters); wifi = $wifi; gateway = $gw; autotuning = "$tcp"; doPolicy = $doPolicy; doUpload = $doUp; apps = @($apps) }`;

const PING = `
$r = @(Test-Connection -ComputerName $A.host -Count $A.count -ErrorAction SilentlyContinue)
$t = @($r | ForEach-Object { [int]$_.ResponseTime })
@{ host = $A.host; sent = $A.count; received = $t.Count; times = $t }`;

const DNS_BENCH = `
$out = foreach ($s in $A.servers) {
  $times = foreach ($d in $A.domains) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try { Resolve-DnsName -Name $d -Server $s -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop | Out-Null; [int]$sw.ElapsedMilliseconds }
    catch { 2000 }
  }
  @{ server = $s; times = @($times) }
}
@($out)`;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

function pingStats(p) {
  const t = p.times || [];
  if (!t.length) return { host: p.host, loss: 100, avg: null, jitter: null };
  const avg = t.reduce((a, b) => a + b, 0) / t.length;
  let jit = 0;
  for (let i = 1; i < t.length; i++) jit += Math.abs(t[i] - t[i - 1]);
  return { host: p.host, loss: Math.round(100 * (1 - t.length / p.sent)), avg: Math.round(avg * 10) / 10,
    min: Math.min(...t), max: Math.max(...t), jitter: t.length > 1 ? Math.round((jit / (t.length - 1)) * 10) / 10 : 0 };
}

// Débit : plusieurs flux en parallèle pendant quelques secondes.
async function throughput(kind, seconds, emit) {
  const start = Date.now();
  let bytes = 0;
  const deadline = start + seconds * 1000;
  const worker = async () => {
    while (Date.now() < deadline) {
      if (kind === "down") {
        const r = await fetch("https://speed.cloudflare.com/__down?bytes=25000000", { signal: AbortSignal.timeout(seconds * 1000 + 5000) });
        if (!r.ok) throw new Error(`serveur de test indisponible (${r.status})`);
        for await (const chunk of r.body) {
          bytes += chunk.length;
          if (Date.now() > deadline) break;
        }
      } else {
        const body = Buffer.alloc(8 * 1024 * 1024);
        const r = await fetch("https://speed.cloudflare.com/__up", { method: "POST", body, signal: AbortSignal.timeout(seconds * 1000 + 10000) });
        if (!r.ok) throw new Error(`serveur de test indisponible (${r.status})`);
        bytes += body.length;
      }
      emit && emit({ type: "progress", step: kind, mbps: (bytes * 8) / ((Date.now() - start) / 1000) / 1e6 });
    }
  };
  const res = await Promise.allSettled(Array.from({ length: kind === "down" ? 4 : 2 }, worker));
  if (!bytes) throw res.find((x) => x.status === "rejected")?.reason || new Error("aucune donnée reçue");
  return (bytes * 8) / ((Date.now() - start) / 1000) / 1e6;
}

async function httpLatency() {
  const t = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    const r = await fetch("https://speed.cloudflare.com/__down?bytes=0", { signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    t.push(performance.now() - s);
  }
  return Math.round(median(t.slice(1)));   // la première inclut la connexion TLS
}

module.exports = (ctx) => {
  let info = null;
  let lastTest = null;

  async function getInfo() {
    info = await ps.run(INFO, { args: { eee: EEE_KEYS }, timeout: 60000 });
    info.adapters = [].concat(info.adapters || []);
    // Un programme a souvent plusieurs processus : on les regroupe par nom.
    const byName = new Map();
    for (const a of [].concat(info.apps || [])) {
      const k = (a.name || "?").toLowerCase();
      const g = byName.get(k) || { name: a.name || "?", pub: a.pub || null, conns: 0, hosts: 0 };
      g.conns += a.conns; g.hosts += a.hosts;
      byName.set(k, g);
    }
    info.apps = [...byName.values()].sort((a, b) => b.conns - a.conns);
    return info;
  }

  // Optimisations proposées, chacune justifiée par ce qui a été mesuré.
  function optimizations(inf, test) {
    const out = [];
    const main = inf.adapters.find((a) => a.ip) || inf.adapters[0];
    if (test?.dns && main) {
      const cur = test.dns.find((d) => d.current);
      const best = test.dns.filter((d) => !d.current && d.provider).sort((a, b) => a.median - b.median)[0];
      if (cur && best && best.median + 5 < cur.median) {
        out.push({ id: "dns", admin: true, title: `Passer au DNS ${DNS[best.provider].label}`,
          why: `Chez toi, il répond en ${best.median} ms contre ${cur.median} ms pour le DNS actuel (${cur.server}). Chaque nouveau site s'ouvre un peu plus vite.`,
          params: { provider: best.provider, ifIndex: main.ifIndex } });
      }
    }
    for (const a of inf.adapters) {
      for (const e of a.eee || []) {
        if (e.value !== "0") out.push({ id: "eee", admin: true, title: `Désactiver « ${e.label} » sur ${a.name}`,
          why: "L'économie d'énergie Ethernet met la carte en veille entre deux paquets : ça peut ajouter de la latence ou des micro-coupures en jeu. Le gain d'énergie est négligeable sur un PC fixe.",
          params: { adapter: a.name, keyword: e.keyword, previous: e.value } });
      }
      if (!a.wifi && /2\.5G|2,5G|2500/i.test(a.desc) && a.speed && a.speed < 2.5e9) {
        out.push({ id: "info", title: `Carte 2,5 Gb/s connectée à ${a.speed / 1e9} Gb/s`,
          why: "Ta carte réseau gère 2,5 Gb/s mais le lien négocié est plus lent : c'est la box, le switch ou le câble (catégorie 5e minimum) qui limite. Sans importance si ton abonnement est sous 1 Gb/s." });
      }
    }
    if (inf.autotuning && inf.autotuning !== "Normal") {
      out.push({ id: "autotuning", admin: true, title: "Rétablir l'autoréglage TCP",
        why: `Il est réglé sur « ${inf.autotuning} », ce qui peut brider les gros téléchargements. « Normal » est la valeur par défaut de Windows.`,
        params: { previous: inf.autotuning } });
    }
    if (inf.doPolicy == null && inf.doUpload > 50 * 1024 ** 2) {
      out.push({ id: "dolan", admin: true, title: "Arrêter d'envoyer des mises à jour à des inconnus",
        why: `Ce mois-ci, ton PC a envoyé ${(inf.doUpload / 1024 ** 3).toFixed(1)} Go de mises à jour Windows à d'autres PC sur Internet. On peut limiter ce partage à ton réseau local.` });
    }
    if (inf.wifi && inf.wifi.signal < 60) {
      out.push({ id: "info", title: `Signal Wi-Fi faible (${inf.wifi.signal} %)`,
        why: "Rapproche le PC de la box, ou passe en Ethernet : aucun réglage logiciel ne compense un mauvais signal." });
    }
    if (test?.ping) {
      const gw = test.ping.find((p) => p.host === inf.gateway);
      if (gw && (gw.loss > 0 || (gw.avg ?? 0) > 5)) out.push({ id: "info", title: "Réseau local instable",
        why: `Le ping vers ta box est de ${gw.avg} ms avec ${gw.loss} % de pertes : en Ethernet il devrait être sous 2 ms sans perte. Vérifie le câble ou le port.` });
    }
    return out;
  }

  ctx.reverters.dns = ({ ifIndex, servers }) => ps.runElevated(servers?.length
    ? "Set-DnsClientServerAddress -InterfaceIndex $A.i -ServerAddresses $A.s; $true"
    : "Set-DnsClientServerAddress -InterfaceIndex $A.i -ResetServerAddresses; $true", { args: { i: ifIndex, s: servers } });
  ctx.reverters.eee = ({ adapter, keyword, value }) => ps.runElevated(
    "Set-NetAdapterAdvancedProperty -Name $A.a -RegistryKeyword $A.k -RegistryValue $A.v -NoRestart; Restart-NetAdapter -Name $A.a; $true",
    { args: { a: adapter, k: keyword, v: value } });
  ctx.reverters.autotuning = ({ level }) => ps.runElevated("Set-NetTCPSetting -SettingName Internet -AutoTuningLevelLocal $A.l; $true", { args: { l: level } });
  ctx.reverters.dolan = () => ps.runElevated("Remove-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization' -Name DODownloadMode -ErrorAction SilentlyContinue; $true");

  return {
    "GET /api/network": async () => {
      const inf = await getInfo();
      return { ...inf, dnsProviders: DNS, test: lastTest, optimizations: optimizations(inf, lastTest) };
    },

    // Test complet, en flux : ping, DNS, latence HTTP, débit.
    "POST /api/network/test": async (req, res) => {
      const emit = ctx.stream(res);
      try {
        const inf = await getInfo();
        emit({ type: "step", step: "ping", label: "Ping de la box et d'Internet" });
        const targets = [inf.gateway, "1.1.1.1", "8.8.8.8"].filter(Boolean);
        const ping = (await Promise.all(targets.map((h) => ps.run(PING, { args: { host: h, count: 8 } }).catch(() => ({ host: h, sent: 8, times: [] }))))).map(pingStats);
        emit({ type: "ping", ping });

        emit({ type: "step", step: "dns", label: "Comparaison des serveurs DNS" });
        const current = inf.adapters.find((a) => a.ip)?.dns || [];
        const servers = [...new Set([...current.slice(0, 1), ...Object.values(DNS).map((d) => d.servers[0])])];
        const bench = [].concat(await ps.run(DNS_BENCH, { args: { servers, domains: DOMAINS }, timeout: 120000 }) || []);
        const dns = bench.map((b) => ({ server: b.server, median: median(b.times), fails: b.times.filter((t) => t >= 2000).length,
          current: current.includes(b.server), provider: Object.keys(DNS).find((k) => DNS[k].servers.includes(b.server)) || null }))
          .sort((a, b) => a.median - b.median);
        emit({ type: "dns", dns });

        emit({ type: "step", step: "latency", label: "Latence vers Internet" });
        const http = await httpLatency().catch(() => null);
        emit({ type: "step", step: "down", label: "Débit descendant" });
        const down = await throughput("down", 8, emit).catch(() => null);
        emit({ type: "step", step: "up", label: "Débit montant" });
        const up = await throughput("up", 6, emit).catch(() => null);

        lastTest = { at: Date.now(), ping, dns, http, down: down && Math.round(down), up: up && Math.round(up) };
        emit({ type: "done", test: lastTest, optimizations: optimizations(inf, lastTest) });
      } catch (e) {
        emit({ type: "error", error: e.message });
      } finally {
        res.end();
      }
    },

    "POST /api/network/flushdns": async () => {
      await ps.run("& ipconfig.exe /flushdns | Out-Null; $true");
      ctx.journal.add({ kind: "system", title: "Cache DNS vidé" });
      return { ok: true };
    },

    // Applique une optimisation. Tout paramètre est revérifié ici.
    "POST /api/network/apply": async (req) => {
      const { id, params = {} } = await ctx.body(req);
      const inf = info || await getInfo();
      if (id === "dns") {
        const prov = DNS[params.provider];
        const ad = inf.adapters.find((a) => a.ifIndex === params.ifIndex);
        if (!prov || !ad) throw new Error("Paramètres refusés.");
        await ps.runElevated("Set-DnsClientServerAddress -InterfaceIndex $A.i -ServerAddresses $A.s; $true", { args: { i: ad.ifIndex, s: prov.servers } });
        ctx.journal.add({ kind: "system", title: `DNS changé pour ${prov.label} sur ${ad.name}`,
          revert: { type: "dns", args: { ifIndex: ad.ifIndex, servers: ad.dnsStatic ? ad.dns : [] } } });
      } else if (id === "eee") {
        const ad = inf.adapters.find((a) => a.name === params.adapter);
        const e = ad?.eee.find((x) => x.keyword === params.keyword);
        if (!e) throw new Error("Paramètres refusés.");
        await ps.runElevated("Set-NetAdapterAdvancedProperty -Name $A.a -RegistryKeyword $A.k -RegistryValue 0 -NoRestart; Restart-NetAdapter -Name $A.a; $true",
          { args: { a: ad.name, k: e.keyword } });
        ctx.journal.add({ kind: "system", title: `« ${e.label} » désactivé sur ${ad.name}`,
          revert: { type: "eee", args: { adapter: ad.name, keyword: e.keyword, value: e.value } } });
      } else if (id === "autotuning") {
        await ps.runElevated("Set-NetTCPSetting -SettingName Internet -AutoTuningLevelLocal Normal; $true");
        ctx.journal.add({ kind: "system", title: "Autoréglage TCP rétabli sur Normal",
          revert: { type: "autotuning", args: { level: inf.autotuning } } });
      } else if (id === "dolan") {
        await ps.runElevated(`
          $k = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization'
          if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
          Set-ItemProperty -Path $k -Name DODownloadMode -Value 1 -Type DWord
          $true`);
        ctx.journal.add({ kind: "system", title: "Partage des mises à jour limité au réseau local", revert: { type: "dolan", args: {} } });
      } else {
        throw new Error("Optimisation inconnue.");
      }
      info = null;
      return { ok: true };
    },
  };
};
