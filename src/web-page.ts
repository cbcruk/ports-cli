/**
 * The single-page client for `ports --web`.
 *
 * Served as one self-contained document — no bundler, no build step, no CDN.
 * The auth token is not baked in: the page reads it from its own query string,
 * so the HTML itself is not a secret and a reload keeps working.
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
    <span class="count" id="count">connecting…</span>
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
const token = new URLSearchParams(location.search).get('t') || ''
const $ = (id) => document.getElementById(id)
let rows = []
let sortKey = 'port'

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
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = r.display.ports
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
    const res = await fetch('/api/kill', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ pid: r.pid, port: r.port, force }),
    })
    const out = await res.json()
    $('status').textContent = out.message || ('kill failed (' + res.status + ')')
  } catch (e) {
    $('status').textContent = 'kill failed: ' + e.message
  }
}

function connect() {
  const es = new EventSource('/api/events?t=' + encodeURIComponent(token))
  es.addEventListener('rows', (e) => {
    $('dot').className = 'dot live'
    rows = JSON.parse(e.data)
    render()
  })
  es.addEventListener('fail', (e) => { $('status').textContent = e.data })
  es.onerror = () => {
    $('dot').className = 'dot down'
    $('count').textContent = 'disconnected'
  }
}

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.onclick = () => { sortKey = th.dataset.sort; render() }
}
$('filter').oninput = render
$('all').onchange = render
connect()
</script>
</body>
</html>
`
