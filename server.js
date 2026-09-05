'use strict';
// portboard — zero-dependency LAN dashboard of listening TCP ports.
// Node v22, CommonJS, built-in modules only. Never shells out (execFile only).

const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORTBOARD_PORT) || 7777;
const WORKSPACE = process.env.PORTBOARD_WORKSPACE || path.join(os.homedir(), 'workspace');

// -- helpers ----------------------------------------------------------------

// Run a command via execFile. lsof exits non-zero when PIDs vanish mid-scan;
// we tolerate that and use whatever stdout we got.
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && typeof err.stdout === 'string') return resolve(err.stdout);
      if (err && !stdout) return resolve('');
      resolve(stdout || '');
    });
  });
}

// Parse `lsof -F pcn` output: p<pid> / c<command> / n<addr:port> lines.
function parseListeners(text) {
  const rows = [];
  let pid = null;
  let command = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      command = null;
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n') {
      const idx = value.lastIndexOf(':');
      if (idx === -1) continue;
      const port = Number(value.slice(idx + 1));
      if (!Number.isFinite(port)) continue;
      let addr = value.slice(0, idx);
      if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
      rows.push({ pid, command, addr, port });
    }
  }
  return rows;
}

// Parse `lsof -a -p ... -d cwd -F pn` output into pid -> cwd path.
function parseCwds(text) {
  const map = new Map();
  let pid = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid !== null) map.set(pid, line.slice(1));
  }
  return map;
}

// Parse `ps -o pid=,command= -p ...` output into pid -> full command line.
function parseCommands(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

const FRAMEWORKS = [
  [/(?:\bnext\s+(?:dev|start)\b|next-server|node_modules\/next\b)/, 'Next.js'],
  [/\bvite\b/, 'Vite'],
  [/\bastro\b/, 'Astro'],
  [/\bnuxt\b/, 'Nuxt'],
  [/\bremix\b/, 'Remix'],
  [/react-scripts/, 'Create React App'],
  [/\bexpress\b/, 'Express'],
  [/\bflask\b/, 'Flask'],
  [/\buvicorn\b|\bfastapi\b/, 'FastAPI'],
  [/\bdjango\b|manage\.py\s+runserver/, 'Django'],
];

function detectFramework(commandLine) {
  if (!commandLine) return null;
  for (const [re, name] of FRAMEWORKS) {
    if (re.test(commandLine)) return name;
  }
  return null;
}

// The owner's apps, by the port each one lives on. A curated name beats a
// directory name ("brain", not "AIA2ndBrain") and it is what the phone reads
// first. A port that isn't here falls back to its project folder, then to the
// process name — the row still tells you what is holding the port.
const APP_NAMES = new Map([
  [3000, 'Autojob'],
  [3002, 'Brain'],
  [4321, 'Dossier'],
  [4400, 'OpenWiki'],
  [4747, 'Taste'],
  [7717, 'Termdeck'],
  [7777, 'Portboard'],
  [7788, 'Assistant'],
  [7789, 'Deckhand'],
  [7790, 'Algo tracker'],
]);

function sentenceCase(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function displayName(entry) {
  if (APP_NAMES.has(entry.port)) return APP_NAMES.get(entry.port);
  return sentenceCase(entry.project || entry.process) || 'Port ' + entry.port;
}

function projectFromCwd(cwd) {
  if (!cwd || !cwd.startsWith(WORKSPACE + '/')) return null;
  const rest = cwd.slice(WORKSPACE.length + 1);
  const seg = rest.split('/')[0];
  return seg || null;
}

function isWildcardAddr(addr) {
  return addr === '*' || addr === '0.0.0.0' || addr === '::';
}

// Anything not bound to loopback is reachable from the LAN/Tailscale —
// including specific interface binds like 192.168.1.5 or a Tailscale IP.
function isReachableAddr(addr) {
  if (isWildcardAddr(addr)) return true;
  return !(addr.startsWith('127.') || addr === '::1');
}

// -- scan -------------------------------------------------------------------

async function scanPorts() {
  const lsofOut = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn']);
  const rows = parseListeners(lsofOut);

  // Group rows by port (IPv4 + IPv6 duplicates merge). When distinct
  // processes share a port (e.g. one on [::1], another on 0.0.0.0), the
  // reachable row supplies pid/command so the identity shown matches the
  // process the link actually reaches. `addr` is set only for specific
  // (non-wildcard) reachable binds, so the link can target that address.
  const byPort = new Map();
  for (const row of rows) {
    if (row.port === PORT) continue; // exclude the dashboard itself
    const reachable = isReachableAddr(row.addr);
    const boundAddr = reachable && !isWildcardAddr(row.addr) ? row.addr : null;
    let entry = byPort.get(row.port);
    if (!entry) {
      entry = { port: row.port, pid: row.pid, process: row.command, reachable, addr: boundAddr };
      byPort.set(row.port, entry);
      continue;
    }
    if (!reachable) continue;
    if (!entry.reachable) {
      entry.pid = row.pid;
      entry.process = row.command;
      entry.reachable = true;
      entry.addr = boundAddr;
    } else if (entry.addr && !boundAddr) {
      entry.addr = null; // a wildcard bind exists; the dashboard hostname works
    }
  }

  const pids = [...new Set([...byPort.values()].map((e) => e.pid))].filter((p) => Number.isFinite(p));
  let cwds = new Map();
  let commands = new Map();
  if (pids.length > 0) {
    const pidList = pids.join(',');
    const [cwdOut, psOut] = await Promise.all([
      run('lsof', ['-a', '-p', pidList, '-d', 'cwd', '-F', 'pn']),
      run('ps', ['-o', 'pid=,command=', '-p', pidList]),
    ]);
    cwds = parseCwds(cwdOut);
    commands = parseCommands(psOut);
  }

  const entries = [...byPort.values()]
    .sort((a, b) => a.port - b.port)
    .map((e) => {
      const cwd = cwds.get(e.pid) || null;
      const fullCommand = commands.get(e.pid) || e.process || '';
      const row = {
        port: e.port,
        pid: e.pid,
        process: e.process || null,
        command: fullCommand.slice(0, 300),
        cwd,
        project: projectFromCwd(cwd),
        framework: detectFramework(fullCommand),
        reachable: e.reachable,
        addr: e.addr || null,
      };
      row.name = displayName(row);
      row.named = APP_NAMES.has(row.port);
      row.mine = row.project !== null || APP_NAMES.has(row.port);
      return row;
    });

  return {
    host: os.hostname(),
    scannedAt: new Date().toISOString(),
    projects: entries.filter((e) => e.mine),
    other: entries.filter((e) => !e.mine),
  };
}

// -- UI ---------------------------------------------------------------------

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="apple-mobile-web-app-title" content="Portboard">
<title>Portboard</title>
<style>
/* Nocturne, the estate's palette. Dark is the default; "Nocturne Day" follows
   the device preference with the same tokens and the same semantics. */
:root {
  --bg-1: #0e1124;
  --surface: #141a2e;
  --veil-soft: #1a2037;
  --text-hi: #ecebf4;
  --text-mid: #a7acc4;
  --text-lo: #7d83a1;
  --now: #e3a866;
  --now-line: rgba(227, 168, 102, 0.18);
  --dur-fast: 90ms;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg-1: #f5f2e9;
    --surface: #fbf9f2;
    --veil-soft: #e2dccb;
    --text-hi: #2b2a35;
    --text-mid: #565567;
    --text-lo: #6b697f;
    --now: #a06a24;
    --now-line: rgba(160, 106, 36, 0.28);
    color-scheme: light;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
html { background: var(--bg-1); }
body {
  background: var(--bg-1);
  color: var(--text-hi);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
main {
  max-width: 520px;
  margin: 0 auto;
  padding-top: max(20px, env(safe-area-inset-top));
  padding-bottom: max(28px, env(safe-area-inset-bottom));
}
/* One vertical rule: 16px, plus whatever the notch asks for. */
.pad {
  padding-left: max(16px, env(safe-area-inset-left));
  padding-right: max(16px, env(safe-area-inset-right));
}
.head { padding-bottom: 14px; }
.ctx {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-lo);
  font-variant-numeric: tabular-nums;
}
h1 {
  font-family: ui-serif, "New York", Georgia, serif;
  font-size: 26px;
  line-height: 1.1;
  font-weight: 500;
  letter-spacing: 0.005em;
  margin-top: 2px;
}

/* the filter — only mounted when there are more rows than a screen holds */
.filterbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--veil-soft);
}
.filterbar input {
  flex: 1;
  min-width: 0;
  height: 44px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-hi);
  font: inherit;
  font-size: 16px;
  caret-color: var(--now);
}
.filterbar input::placeholder { color: var(--text-lo); }
.filterbar input:focus { outline: none; }
.filterbar:focus-within { border-bottom-color: var(--now-line); }
.clear {
  flex: none;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--text-mid);
  cursor: pointer;
}
.clear:active { color: var(--text-hi); }

/* section heads */
.sect {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  font-size: 13px;
  font-weight: 590;
  color: var(--text-mid);
  text-align: left;
  background: transparent;
  border: 0;
  font-family: inherit;
  padding-top: 14px;
  padding-bottom: 6px;
}
button.sect { cursor: pointer; }
.sect .count {
  margin-left: auto;
  font-weight: 400;
  color: var(--text-lo);
  font-variant-numeric: tabular-nums;
}
.sect .chev {
  flex: none;
  color: var(--text-lo);
  transition: transform var(--dur-fast) linear;
}
.sect[aria-expanded="true"] .chev { transform: rotate(90deg); }

/* the ledger row: 56px, a hairline, name then a quiet figure */
.row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding-top: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--veil-soft);
  color: inherit;
  text-decoration: none;
}
.row__text { min-width: 0; }
.row__name {
  display: block;
  font-size: 15px;
  line-height: 1.25;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row__meta {
  display: block;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-lo);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row__port {
  font-size: 13px;
  color: var(--text-lo);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
/* Down, or up but out of reach from this phone: a luminance step, not a badge. */
.row--dim .row__name { color: var(--text-mid); font-weight: 400; }
a.row:active { background: var(--surface); }
a.row:focus-visible { outline: 1px solid var(--text-mid); outline-offset: -1px; }
@media (hover: hover) {
  a.row:hover { background: var(--surface); }
}
.empty {
  font-size: 13px;
  color: var(--text-lo);
  padding-top: 4px;
  padding-bottom: 12px;
}
.status {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-lo);
  font-variant-numeric: tabular-nums;
  padding-top: 18px;
}
.status.is-lost { color: var(--now); }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
</style>
</head>
<body>
<main>
  <header class="head pad">
    <p class="ctx" id="host">&nbsp;</p>
    <h1>Portboard</h1>
  </header>

  <div class="filterbar pad" id="filterbar" hidden>
    <input id="filter" type="text" inputmode="search" autocomplete="off" autocorrect="off"
           autocapitalize="none" spellcheck="false" placeholder="Filter" aria-label="Filter ports">
    <button class="clear" id="clear" type="button" aria-label="Clear filter" hidden>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  <section>
    <h2 class="sect pad" id="mine-head">Your apps</h2>
    <div id="mine"></div>
  </section>

  <section>
    <button class="sect pad" id="other-toggle" type="button" aria-expanded="false" aria-controls="other">
      <svg class="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5.5 3.5L10.5 8l-5 4.5" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Everything else</span>
      <span class="count" id="other-count"></span>
    </button>
    <div id="other" hidden></div>
  </section>

  <p class="status pad" id="status">Reading ports</p>
</main>
<script>
(function () {
  'use strict';

  var FILTER_AT = 12; // a filter earns its place only past a screenful
  var el = function (id) { return document.getElementById(id); };
  var data = { host: '', projects: [], other: [] };
  var query = '';
  var open = false;

  function hrefFor(entry) {
    var host = location.hostname;
    if (entry.addr) host = entry.addr.indexOf(':') !== -1 ? '[' + entry.addr + ']' : entry.addr;
    return 'http://' + host + ':' + entry.port;
  }

  function metaFor(entry) {
    if (!entry.reachable) return 'Local only';
    if (entry.framework) return entry.framework;
    // An app you named needs no second line; an unknown port is named by the
    // process holding it, so there the process IS the information.
    if (!entry.named && entry.process &&
        entry.process.toLowerCase() !== entry.name.toLowerCase()) return entry.process;
    return '';
  }

  function makeRow(entry) {
    var row;
    if (entry.reachable) {
      row = document.createElement('a');
      row.href = hrefFor(entry);
    } else {
      row = document.createElement('div');
    }
    row.className = 'row pad' + (entry.reachable ? '' : ' row--dim');

    var text = document.createElement('span');
    text.className = 'row__text';

    var name = document.createElement('span');
    name.className = 'row__name';
    name.textContent = entry.name;
    text.appendChild(name);

    var metaText = metaFor(entry);
    if (metaText) {
      var meta = document.createElement('span');
      meta.className = 'row__meta';
      meta.textContent = metaText;
      text.appendChild(meta);
    }
    row.appendChild(text);

    var port = document.createElement('span');
    port.className = 'row__port';
    port.textContent = String(entry.port);
    row.appendChild(port);
    return row;
  }

  function matches(entry) {
    if (!query) return true;
    var hay = [entry.name, entry.process, entry.project, entry.framework, entry.port]
      .join(' ').toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function fill(node, entries, emptyText) {
    node.textContent = '';
    if (!entries.length) {
      var p = document.createElement('p');
      p.className = 'empty pad';
      p.textContent = emptyText;
      node.appendChild(p);
      return;
    }
    for (var i = 0; i < entries.length; i++) node.appendChild(makeRow(entries[i]));
  }

  function render() {
    el('host').textContent = data.host;

    var total = data.projects.length + data.other.length;
    el('filterbar').hidden = total <= FILTER_AT;
    el('clear').hidden = !query;

    var mine = data.projects.filter(matches);
    var rest = data.other.filter(matches);

    fill(el('mine'), mine, query ? 'No app matches that.' : 'Nothing of yours is listening.');
    fill(el('other'), rest, 'Nothing matches that.');

    el('other-count').textContent = String(rest.length);
    // A query opens the drawer, because what you are looking for may be in it.
    var expanded = open || (query.length > 0 && rest.length > 0);
    el('other-toggle').setAttribute('aria-expanded', expanded ? 'true' : 'false');
    el('other').hidden = !expanded;
  }

  function stamp(d) {
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return t.replace('AM', 'am').replace('PM', 'pm');
  }

  function refresh() {
    fetch('/api/ports')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        data = payload;
        render();
        var s = el('status');
        s.className = 'status pad';
        s.textContent = 'Updated ' + stamp(new Date());
      })
      .catch(function () {
        var s = el('status');
        s.className = 'status pad is-lost';
        s.textContent = 'Portboard stopped answering, retrying every five seconds';
      });
  }

  el('filter').addEventListener('input', function (e) {
    query = e.target.value.trim().toLowerCase();
    render();
  });
  el('clear').addEventListener('click', function () {
    var input = el('filter');
    input.value = '';
    query = '';
    render();
    input.focus();
  });
  el('other-toggle').addEventListener('click', function () {
    open = el('other-toggle').getAttribute('aria-expanded') !== 'true';
    render();
  });

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;

// -- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (url === '/api/ports') {
    try {
      const data = await scanPorts();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`portboard listening on http://0.0.0.0:${PORT}`);
});
