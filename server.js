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
// directory name, and it is the word the phone reads first. A port that isn't
// here falls back to its project folder, then to the process holding it, so a
// tile always says what it is.
const APP_NAMES = new Map([
  [3000, 'autojob'],
  [3002, 'brain'],
  [4321, 'dossier'],
  [4400, 'openwiki'],
  [4747, 'taste'],
  [7717, 'termdeck'],
  [7777, 'portboard'],
  [7788, 'assistant'],
  [7789, 'deckhand'],
  [7790, 'algo-tracker'],
]);

function displayName(entry) {
  return APP_NAMES.get(entry.port) || entry.project || entry.process || 'pid ' + entry.pid;
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

// Demo mode (PORTBOARD_DEMO=1): a fixed fictional list instead of a real scan,
// so screenshots and docs never show a real machine.
function demoScan() {
  const mk = (port, name, process, reachable = true) => ({
    port, pid: 1000 + port % 997, process, project: name, reachable, addr: null, name, mine: true,
  });
  const apps = [
    mk(3000, 'notes', 'node'), mk(3100, 'photos', 'node'), mk(4000, 'budget', 'python'),
    mk(5173, 'recipes', 'node'), mk(7000, 'garden-cam', 'python', false), mk(7100, 'music', 'node'),
    mk(7300, 'reading', 'node'), mk(8080, 'home', 'node'), mk(8443, 'backups', 'ruby', false),
  ];
  const other = [
    { ...mk(5432, 'postgres', 'postgres'), project: null, name: 'postgres', mine: false },
    { ...mk(6379, 'redis-server', 'redis-server'), project: null, name: 'redis-server', mine: false },
    { ...mk(11434, 'ollama', 'ollama', false), project: null, name: 'ollama', mine: false },
  ];
  return { host: 'studio-mac', scannedAt: new Date().toISOString(), apps, other };
}

async function scanPorts() {
  if (process.env.PORTBOARD_DEMO) return demoScan();
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
      row.mine = APP_NAMES.has(row.port) || row.project !== null;
      return row;
    });

  return {
    host: os.hostname(),
    scannedAt: new Date().toISOString(),
    apps: entries.filter((e) => e.mine),
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
<meta name="apple-mobile-web-app-title" content="portboard">
<title>portboard</title>
<style>
/* A patch panel. Numbered jacks in a strip, a silkscreened label engraved
   under each one, and a lamp that is lit or unlit — never a second colour. */
:root {
  color-scheme: dark light;
  --ground: #171819;
  --panel: #232528;
  --rule: #3b3e44;
  --rule-soft: #31343a;
  --ink: #e8e5df;
  --ink-dim: #9a968e;
  --lamp: #4fbf7f;
  --lamp-off: #4c4f54;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --label: "Avenir Next Condensed", "Avenir Next", "Helvetica Neue", system-ui, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --ground: #e5e3dc;
    --panel: #f7f5f1;
    --rule: #cbc8bf;
    --rule-soft: #d9d6ce;
    --ink: #26262a;
    --ink-dim: #6d6a64;
    --lamp: #1d8b53;
    --lamp-off: #c2bfb7;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: var(--ground); }
body {
  background: var(--ground);
  color: var(--ink);
  font-family: var(--label);
  font-size: 15px;
  line-height: 1.35;
  -webkit-text-size-adjust: 100%;
  padding:
    calc(18px + env(safe-area-inset-top))
    calc(16px + env(safe-area-inset-right))
    calc(26px + env(safe-area-inset-bottom))
    calc(16px + env(safe-area-inset-left));
}
main { max-width: 720px; margin: 0 auto; }

/* nameplate ------------------------------------------------------------- */
.plate {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  font-family: var(--mono);
  padding-bottom: 9px;
  border-bottom: 1px solid var(--rule);
}
.plate b { font-size: 13.5px; font-weight: 600; letter-spacing: 0.01em; }
.plate span {
  font-size: 12px;
  color: var(--ink-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.readout {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-dim);
  margin: 9px 0 14px;
}

/* the jacks -------------------------------------------------------------- */
.panel {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 9px;
}
.jack {
  position: relative;
  display: block;
  min-height: 78px;
  padding: 8px 11px 9px;
  background: var(--panel);
  border: 1px solid var(--rule-soft);
  border-radius: 4px;
  color: inherit;
  text-decoration: none;
}
.jack .num {
  display: block;
  font-family: var(--mono);
  font-size: 26px;
  line-height: 30px;
  font-weight: 500;
  letter-spacing: -0.015em;
  font-variant-numeric: tabular-nums;
}
.jack .lamp {
  position: absolute;
  top: 18px;
  right: 11px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--lamp);
}
.jack .engrave {
  display: block;
  height: 0;
  margin: 7px -11px 0;
  border-top: 1px solid var(--rule);
}
.jack .label {
  display: block;
  margin-top: 7px;
  font-size: 14.5px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jack.off .num, .jack.off .label { color: var(--ink-dim); }
.jack.off .lamp { background: var(--lamp-off); }
a.jack:active { background: var(--rule-soft); }
@media (hover: hover) {
  a.jack:hover { border-color: var(--ink-dim); }
}
a.jack:focus-visible, summary:focus-visible, a.row:focus-visible {
  outline: 2px solid var(--lamp);
  outline-offset: 2px;
}

/* everything else -------------------------------------------------------- */
details { margin-top: 18px; }
summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  list-style: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--ink-dim);
  border-top: 1px solid var(--rule);
}
summary::-webkit-details-marker { display: none; }
summary::before { content: "\\25B8"; font-size: 9px; }
details[open] summary::before { content: "\\25BE"; }
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 1px;
  color: inherit;
  text-decoration: none;
  border-top: 1px solid var(--rule-soft);
}
.row .lamp {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--lamp);
}
.row.off .lamp { background: var(--lamp-off); }
.row .num {
  flex: none;
  min-width: 5ch;
  font-family: var(--mono);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.row .label {
  min-width: 0;
  font-size: 14px;
  color: var(--ink-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row.off .num { color: var(--ink-dim); }
a.row:active { background: var(--rule-soft); }

.empty {
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--ink-dim);
  padding: 12px 0;
}
footer {
  margin-top: 18px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink-dim);
}
</style>
</head>
<body>
<main>
  <div class="plate"><b>portboard</b><span id="host"></span></div>
  <p class="readout" id="readout">Scanning the machine</p>
  <div class="panel" id="apps"></div>
  <details>
    <summary id="othersummary">Everything else</summary>
    <div id="other"></div>
  </details>
  <footer id="status"></footer>
</main>
<script>
(function () {
  'use strict';

  function hrefFor(entry) {
    var host = location.hostname;
    if (entry.addr) {
      host = entry.addr.indexOf(':') !== -1 ? '[' + entry.addr + ']' : entry.addr;
    }
    return 'http://' + host + ':' + entry.port;
  }

  // A jack: the port silkscreened big, its lamp, an engraved rule, the name.
  function makeJack(entry) {
    var el = document.createElement(entry.reachable ? 'a' : 'div');
    el.className = 'jack' + (entry.reachable ? '' : ' off');
    if (entry.reachable) el.href = hrefFor(entry);

    var lamp = document.createElement('span');
    lamp.className = 'lamp';
    el.appendChild(lamp);

    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(entry.port);
    el.appendChild(num);

    var rule = document.createElement('span');
    rule.className = 'engrave';
    el.appendChild(rule);

    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.name;
    el.appendChild(label);

    if (!entry.reachable) el.title = entry.name + ' listens on localhost only';
    return el;
  }

  function makeRow(entry) {
    var el = document.createElement(entry.reachable ? 'a' : 'div');
    el.className = 'row' + (entry.reachable ? '' : ' off');
    if (entry.reachable) el.href = hrefFor(entry);

    var lamp = document.createElement('span');
    lamp.className = 'lamp';
    el.appendChild(lamp);

    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(entry.port);
    el.appendChild(num);

    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.name;
    el.appendChild(label);

    return el;
  }

  function render(el, entries, make, emptyText) {
    el.textContent = '';
    if (!entries.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = emptyText;
      el.appendChild(empty);
      return;
    }
    for (var i = 0; i < entries.length; i++) el.appendChild(make(entries[i]));
  }

  function readout(apps) {
    if (!apps.length) return 'Nothing of yours is listening right now';
    var dark = 0;
    for (var i = 0; i < apps.length; i++) if (!apps[i].reachable) dark++;
    var head = apps.length + (apps.length === 1 ? ' app up' : ' apps up');
    if (!dark) return head;
    return head + ', ' + dark + (dark === 1 ? ' only opens on the Mac' : ' only open on the Mac');
  }

  function refresh() {
    fetch('/api/ports')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        document.getElementById('host').textContent = data.host.replace(/\\.local$/, '');
        document.getElementById('readout').textContent = readout(data.apps);
        render(document.getElementById('apps'), data.apps, makeJack,
          'Nothing of yours is listening right now.');
        render(document.getElementById('other'), data.other, makeRow,
          'Nothing else is listening.');
        document.getElementById('othersummary').textContent =
          'Everything else (' + data.other.length + ')';
        document.getElementById('status').textContent =
          'Updated ' + new Date().toLocaleTimeString();
      })
      .catch(function () {
        document.getElementById('status').textContent =
          'No answer from portboard on the Mac. Retrying every five seconds.';
      });
  }

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
