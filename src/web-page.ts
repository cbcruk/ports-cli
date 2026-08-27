/**
 * The single page shown in the app window.
 *
 * Served as one self-contained document — no bundler, no build step, no CDN —
 * and embedded in the binary as a string, which is what lets it survive
 * `bun build --compile` (a compiled binary has no folder to serve from).
 *
 * There is no HTTP API behind it. Killing a process and opening a port go over
 * barlo's RPC bridge (`window.__kill`, `window.__openPort`), which is installed
 * by CDP into this window's execution context only — so neither is reachable by
 * another local process, another origin, or a rebound DNS name. Rows are
 * pushed the other way, into `window.__ports`.
 *
 * Rows are rendered with DOM APIs rather than `innerHTML`, because a process
 * command line is attacker-influenced text that must never be parsed as markup.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ports</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfd; --fg: #1c1c1e; --muted: #6b6b70; --line: #e3e3e8;
    --card: #fff; --accent: #0a68d8; --danger: #c8322b; --sel: #eef4fd;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17171a; --fg: #e9e9ec; --muted: #97979e; --line: #2c2c31;
      --card: #1e1e22; --accent: #63a4ff; --danger: #ff6b62; --sel: #232a35;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; }
  .count { color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.live { background: #2ea043; }
  .dot.down { background: var(--danger); }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  input[type=search] {
    flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid var(--line);
    border-radius: 8px; background: var(--card); color: inherit; font: inherit;
  }
  label { color: var(--muted); display: flex; align-items: center; gap: 6px; user-select: none; }
  .table { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 9px 12px; text-align: left; white-space: nowrap; }
  th {
    font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
    border-bottom: 1px solid var(--line); cursor: pointer; font-weight: 600;
  }
  th.num, td.num { text-align: right; }
  tbody tr { border-top: 1px solid var(--line); }
  tbody tr:hover { background: var(--sel); }
  td.cmd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    color: var(--muted); max-width: 380px; overflow: hidden; text-overflow: ellipsis;
  }
  .fw { font-weight: 600; }
  a.port { color: var(--accent); text-decoration: none; font-weight: 600; font-variant-numeric: tabular-nums; }
  a.port:hover { text-decoration: underline; }
  .num { font-variant-numeric: tabular-nums; }
  button {
    font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--danger); color: var(--danger); }
  button.force:hover { background: var(--danger); color: #fff; }
  .empty, .status { padding: 16px; color: var(--muted); }
  .status { padding: 10px 0 0; min-height: 22px; }
  .noise td { opacity: .55; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🔌 ports</h1>
    <span class="count" id="count">starting…</span>
    <span class="dot" id="dot"></span>
  </header>

  <div class="controls">
    <input type="search" id="filter" placeholder="filter by port, framework, project, command…" autofocus>
    <label><input type="checkbox" id="all"> show system &amp; ephemeral</label>
  </div>

  <div class="table">
    <table>
      <thead><tr>
        <th data-sort="port">Port</th>
        <th data-sort="framework">Framework</th>
        <th data-sort="project">Project</th>
        <th class="num" data-sort="pid">PID</th>
        <th class="num" data-sort="cpu">CPU%</th>
        <th class="num" data-sort="mem">Mem MB</th>
        <th class="num" data-sort="uptime">Up</th>
        <th>Command</th>
        <th></th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" hidden>no dev servers listening on localhost</div>
  </div>

  <div class="status" id="status"></div>
</div>

<script>
// Wrapped, because a classic script's top-level declarations land on \`window\`
// — which is where the runtime installs its bridge. An unwrapped
// \`function kill\` silently replaced \`window.kill\` with itself.
;(() => {
const $ = (id) => document.getElementById(id)
let rows = []
let sortKey = 'port'
let lastPush = 0

const cmp = {
  port: (a, b) => a.port - b.port,
  pid: (a, b) => a.pid - b.pid,
  framework: (a, b) => a.framework.localeCompare(b.framework),
  project: (a, b) => a.project.localeCompare(b.project),
  // busiest first; a null CPU (no baseline yet) sorts last
  cpu: (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1),
  mem: (a, b) => b.memMB - a.memMB,
  uptime: (a, b) => b.uptimeSecs - a.uptimeSecs,
}

function visible() {
  const q = $('filter').value.trim().toLowerCase()
  const showAll = $('all').checked
  return rows
    .filter((r) => showAll || !r.noise)
    .filter((r) => !q
      || r.ports.some((p) => String(p).includes(q))
      || r.framework.toLowerCase().includes(q)
      || r.project.toLowerCase().includes(q)
      || r.command.toLowerCase().includes(q))
    .sort(cmp[sortKey])
}

function cell(text, cls) {
  const td = document.createElement('td')
  if (cls) td.className = cls
  td.textContent = text
  return td
}

function render() {
  const list = visible()
  $('count').textContent = list.length + ' listening'
  $('empty').hidden = list.length > 0
  const body = $('rows')
  body.replaceChildren()

  for (const r of list) {
    const tr = document.createElement('tr')
    if (r.noise) tr.className = 'noise'

    const portTd = document.createElement('td')
    const link = document.createElement('a')
    link.className = 'port'
    link.href = 'http://localhost:' + r.port
    link.textContent = r.display.ports
    // This is an app window with no tab strip to open into, so hand the URL to
    // the platform opener instead — the same thing the TUI's \`o\` key does.
    link.onclick = (e) => { e.preventDefault(); window.__openPort(r.port) }
    portTd.append(link)
    tr.append(portTd)

    tr.append(cell(r.framework, 'fw'), cell(r.project || '—'))
    tr.append(cell(String(r.pid), 'num'), cell(r.display.cpu, 'num'))
    tr.append(cell(r.display.mem, 'num'), cell(r.display.up, 'num'))

    const cmd = cell(r.command, 'cmd')
    cmd.title = r.command
    tr.append(cmd)

    const actions = document.createElement('td')
    actions.append(killButton(r, false), killButton(r, true))
    tr.append(actions)

    body.append(tr)
  }
}

function killButton(r, force) {
  const b = document.createElement('button')
  b.textContent = force ? 'force' : 'kill'
  if (force) b.className = 'force'
  b.title = (force ? 'SIGKILL' : 'SIGTERM') + ' pid ' + r.pid
  b.onclick = () => {
    const sig = force ? 'SIGKILL' : 'SIGTERM'
    if (!confirm(sig + ' :' + r.port + ' (pid ' + r.pid + ')?')) return
    kill(r, force)
  }
  return b
}

async function kill(r, force) {
  $('status').textContent = (force ? 'SIGKILL' : 'SIGTERM') + ' → :' + r.port + ' …'
  try {
    $('status').textContent = await window.__kill(r.pid, force)
  } catch (e) {
    $('status').textContent = 'kill failed: ' + e.message
  }
}

// Pushed from the runtime once per poll. Defined before the first push can
// land, since the page is loaded after the bridge is installed.
window.__ports = (payload) => {
  lastPush = Date.now()
  $('dot').className = 'dot live'
  if (payload.error) {
    $('status').textContent = payload.error
    return
  }
  rows = payload.rows
  render()
}

// Nothing reconnects here — the window and the runtime live and die together —
// so a stalled feed means the runtime is wedged, and saying so beats a table
// that silently stops moving.
setInterval(() => {
  if (lastPush && Date.now() - lastPush > 8000) {
    $('dot').className = 'dot down'
    $('count').textContent = 'not responding'
  }
}, 2000)

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.onclick = () => { sortKey = th.dataset.sort; render() }
}
$('filter').oninput = render
$('all').onchange = render
})()
</script>
</body>
</html>
`
