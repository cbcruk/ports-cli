import { execFile } from 'node:child_process'

export type Row = {
  port: number
  pid: number
  command: string
  framework: string
  project: string
  cpu: number | null // instantaneous %, null on first sample
  memMB: number
  uptimeSecs: number
}

// Injectable exec so parsers can be tested against canned output.
export type Exec = (cmd: string, args: string[]) => Promise<string>

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // lsof exits 1 when *some* pids yield nothing; stdout is still valid.
      if (err && !stdout) reject(err)
      else resolve(stdout)
    })
  })

// ── parsers (pure, unit-tested) ────────────────────────────────────────────

// "[[dd-]hh:]mm:ss[.frac]" → seconds
export function parseClock(s: string): number {
  s = s.trim()
  let days = 0
  const dash = s.indexOf('-')
  if (dash !== -1) {
    days = Number(s.slice(0, dash))
    s = s.slice(dash + 1)
  }
  const parts = s.split(':').map(Number)
  let secs = 0
  for (const p of parts) secs = secs * 60 + p
  return days * 86400 + secs
}

const RULES: [RegExp, string][] = [
  // `next dev` renames itself to "next-server (v15.3.6)" once booted, so match both argv and post-rename forms.
  [/(^|[/\s])next(-server|-router-worker)?(\/|\s|$)/, 'Next.js'],
  [/vite/, 'Vite'],
  [/nuxt/, 'Nuxt'],
  [/astro/, 'Astro'],
  [/webpack|react-scripts/, 'Webpack'],
  [/remix/, 'Remix'],
  [/\bworkerd\b|wrangler/, 'Workers'],
  [/\bbun\b/, 'Bun'],
  [/\bdeno\b/, 'Deno'],
  [/rails|puma|\bp[uma]{3}\b/, 'Rails'],
  [/uvicorn|gunicorn|flask|manage\.py runserver|http\.server/, 'Python'],
  [/\/go-build\/|\bgo run\b/, 'Go'],
  [/\bnode\b/, 'Node'],
]

export function detectFramework(command: string): string {
  for (const [re, name] of RULES) if (re.test(command)) return name
  return '—'
}

// Most localhost listeners are OS daemons and GUI apps, not dev servers. Hidden unless --all.
const SYSTEM_RULES: RegExp[] = [
  /^\/System\//,
  /^\/usr\/(sbin|libexec)\//,
  /^\/Library\//,
  /\.app\/Contents\//,
  /\/Library\/Application Support\//,
]

export function isSystemProcess(command: string): boolean {
  return SYSTEM_RULES.some((re) => re.test(command))
}

// lsof -F pcn  →  pid → { command, ports }
export function parseListeners(out: string): Map<number, { command: string; ports: Set<number> }> {
  const procs = new Map<number, { command: string; ports: Set<number> }>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (!line) continue
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') procs.set((pid = Number(val)), { command: '', ports: new Set() })
    else if (tag === 'c') procs.get(pid)!.command = val
    else if (tag === 'n') {
      const m = val.match(/:(\d+)$/) // 127.0.0.1:3000 · [::1]:3000 · *:8080
      if (m) procs.get(pid)!.ports.add(Number(m[1]))
    }
  }
  return procs
}

// ps -o pid=,rss=,etime=,time=,command=  →  pid → stats
export function parsePs(out: string): Map<number, { rss: number; etime: number; cpuSecs: number; command: string }> {
  const map = new Map<number, { rss: number; etime: number; cpuSecs: number; command: string }>()
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(/\s+/)
    if (parts.length < 5) continue
    const [pid, rss, etime, time, ...rest] = parts
    map.set(Number(pid), {
      rss: Number(rss),
      etime: parseClock(etime),
      cpuSecs: parseClock(time),
      command: rest.join(' '),
    })
  }
  return map
}

// lsof -p <pids> -a -d cwd -Fn  →  pid → cwd basename
export function parseCwd(out: string): Map<number, string> {
  const map = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (!line) continue
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n') map.set(pid, line.slice(1).split('/').filter(Boolean).pop() ?? '')
  }
  return map
}

// ── collector (stateful: holds prev CPU sample + cwd cache) ─────────────────

export function createCollector(exec: Exec = defaultExec) {
  let prev = new Map<number, { cpuSecs: number; wallMs: number }>()
  const cwdCache = new Map<number, string>()

  async function collect(): Promise<Row[]> {
    const listenersOut = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    const listeners = parseListeners(listenersOut)
    const pids = [...listeners.keys()]
    if (pids.length === 0) {
      prev = new Map()
      return []
    }

    const psOut = await exec('ps', ['-p', pids.join(','), '-o', 'pid=,rss=,etime=,time=,command='])
    const stats = parsePs(psOut)

    const uncached = pids.filter((p) => !cwdCache.has(p))
    if (uncached.length) {
      const cwdOut = await exec('lsof', ['-p', uncached.join(','), '-a', '-d', 'cwd', '-Fn'])
      for (const [p, name] of parseCwd(cwdOut)) cwdCache.set(p, name)
    }

    const wallMs = Date.now()
    const next = new Map<number, { cpuSecs: number; wallMs: number }>()
    const rows: Row[] = []

    for (const [pid, { command, ports }] of listeners) {
      const st = stats.get(pid)
      if (!st) continue
      const cmd = st.command || command
      next.set(pid, { cpuSecs: st.cpuSecs, wallMs })
      const p = prev.get(pid)
      const dt = p ? (wallMs - p.wallMs) / 1000 : 0
      const cpu = p && dt > 0 ? Math.max(0, ((st.cpuSecs - p.cpuSecs) / dt) * 100) : null

      for (const port of ports) {
        rows.push({
          port,
          pid,
          command: cmd,
          framework: detectFramework(cmd),
          project: cwdCache.get(pid) ?? '',
          cpu,
          memMB: st.rss / 1024,
          uptimeSecs: st.etime,
        })
      }
    }
    prev = next
    return rows.sort((a, b) => a.port - b.port)
  }

  return { collect }
}

// ── actions ─────────────────────────────────────────────────────────────────

export function killPid(pid: number, force = false): boolean {
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    return true
  } catch {
    return false
  }
}

export function openPort(port: number, exec: Exec = defaultExec): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  void exec(opener, [`http://localhost:${port}`]).catch(() => {})
}

// ── formatters ───────────────────────────────────────────────────────────────

export function fmtUptime(s: number): string {
  if (s < 60) return `${s | 0}s`
  if (s < 3600) return `${(s / 60) | 0}m`
  if (s < 86400) return `${(s / 3600) | 0}h${((s % 3600) / 60) | 0}m`
  return `${(s / 86400) | 0}d${((s % 86400) / 3600) | 0}h`
}

export function fmtCpu(c: number | null): string {
  return c == null ? '·' : c.toFixed(c >= 10 ? 0 : 1)
}
