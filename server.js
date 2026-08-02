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
      return {
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
    });

  return {
    host: os.hostname(),
    scannedAt: new Date().toISOString(),
    projects: entries.filter((e) => e.project !== null),
    other: entries.filter((e) => e.project === null),
  };
}

// -- UI ---------------------------------------------------------------------

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>portboard</title>
<style>
:root {
  color-scheme: dark light;
  --bg: #101214;
  --panel: #16191c;
  --border: #2a2e33;
  --text: #d7dade;
  --muted: #8a9098;
  --accent: #4caf7d;
  --amber: #c9973f;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f6f4;
    --panel: #fdfdfc;
    --border: #dcdcd7;
    --text: #23262a;
    --muted: #71767d;
    --accent: #2e8b5f;
    --amber: #a87828;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.4;
  padding: 1.25rem 1rem 2rem;
}
main { max-width: 560px; margin: 0 auto; }
h1 {
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.host {
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  color: var(--muted);
  margin-bottom: 1.25rem;
}
.section-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 1.25rem 0 0.5rem;
}
details > summary.section-label {
  cursor: pointer;
  list-style: none;
}
details > summary.section-label::before { content: "\\25B8\\00A0"; }
details[open] > summary.section-label::before { content: "\\25BE\\00A0"; }
.card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  margin-bottom: 0.5rem;
  color: inherit;
  text-decoration: none;
}
a.card:hover { border-color: var(--muted); }
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot.reachable { background: var(--accent); }
.dot.local { background: transparent; border: 1.5px solid var(--amber); }
.port {
  flex: none;
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  font-size: 1.15rem;
  font-weight: 600;
  min-width: 3.2em;
}
.meta { min-width: 0; flex: 1; }
.name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty { color: var(--muted); font-size: 0.85rem; padding: 0.25rem 0; }
footer {
  margin-top: 1.5rem;
  font-size: 0.75rem;
  color: var(--muted);
}
</style>
</head>
<body>
<main>
  <h1>portboard</h1>
  <div class="host" id="host"></div>
  <div class="section-label">Your projects</div>
  <div id="projects"></div>
  <details>
    <summary class="section-label">Other listeners</summary>
    <div id="other"></div>
  </details>
  <footer id="status">Loading…</footer>
</main>
<script>
(function () {
  'use strict';

  function makeCard(entry) {
    var card;
    if (entry.reachable) {
      card = document.createElement('a');
      var host = location.hostname;
      if (entry.addr) {
        host = entry.addr.indexOf(':') !== -1 ? '[' + entry.addr + ']' : entry.addr;
      }
      card.href = 'http://' + host + ':' + entry.port;
    } else {
      card = document.createElement('div');
    }
    card.className = 'card';

    var dot = document.createElement('span');
    dot.className = 'dot ' + (entry.reachable ? 'reachable' : 'local');
    card.appendChild(dot);

    var port = document.createElement('span');
    port.className = 'port';
    port.textContent = String(entry.port);
    card.appendChild(port);

    var meta = document.createElement('span');
    meta.className = 'meta';

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.project || entry.process || 'pid ' + entry.pid;
    meta.appendChild(name);

    var sub = document.createElement('span');
    sub.className = 'sub';
    var subText = entry.framework || entry.process || entry.cwd || '';
    if (!entry.reachable) {
      subText = subText ? subText + ' \\u00b7 localhost only' : 'localhost only';
    }
    sub.textContent = subText;
    if (subText) meta.appendChild(sub);

    card.appendChild(meta);
    return card;
  }

  function renderList(el, entries) {
    el.textContent = '';
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'None';
      el.appendChild(empty);
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      el.appendChild(makeCard(entries[i]));
    }
  }

  function refresh() {
    fetch('/api/ports')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        document.getElementById('host').textContent = data.host;
        renderList(document.getElementById('projects'), data.projects);
        renderList(document.getElementById('other'), data.other);
        document.getElementById('status').textContent =
          'Updated ' + new Date().toLocaleTimeString();
      })
      .catch(function () {
        document.getElementById('status').textContent =
          'Lost connection to portboard \\u2014 retrying\\u2026';
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
