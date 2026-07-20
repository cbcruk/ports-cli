import { execFile } from 'node:child_process'

export type Row = {
  port: number // primary (lowest) listening port
  ports: number[] // every port this pid listens on, ascending
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

// IANA ephemeral range. workerd/Vite open transient control sockets here; a process
// listening *only* on such ports is plumbing, not something you'd browse to.
export const EPHEMERAL_MIN = 49152

export function isEphemeralOnly(ports: number[]): boolean {
  return ports.length > 0 && ports.every((p) => p >= EPHEMERAL_MIN)
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

      const sorted = [...ports].sort((a, b) => a - b)
      if (!sorted.length) continue
      rows.push({
        port: sorted[0],
        ports: sorted,
        pid,
        command: cmd,
        framework: detectFramework(cmd),
        project: cwdCache.get(pid) ?? '',
        cpu,
        memMB: st.rss / 1024,
        uptimeSecs: st.etime,
      })
    }
    prev = next
    return rows.sort((a, b) => a.port - b.port)
  }

  return { collect }
}

// ── actions ─────────────────────────────────────────────────────────────────

// Injectable so the wait loop can be tested without real processes.
export type Signal = (pid: number, sig: NodeJS.Signals | 0) => void
const defaultSignal: Signal = (pid, sig) => void process.kill(pid, sig)

export type KillOutcome = {
  sent: boolean
  exited: boolean
  reason?: 'not-permitted' | 'no-such-process' | 'ignored' | 'unknown'
}

// EPERM means the process exists but isn't ours — still alive.
export function isAlive(pid: number, signal: Signal = defaultSignal): boolean {
  try {
    signal(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const errReason = (e: unknown): KillOutcome['reason'] => {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'EPERM') return 'not-permitted'
  if (code === 'ESRCH') return 'no-such-process'
  return 'unknown'
}

// Sending a signal only means it was delivered — SIGTERM handlers may ignore it.
// Poll until the pid is actually gone so callers can report the truth.
export async function killPid(
  pid: number,
  force = false,
  opts: { waitMs?: number; pollMs?: number; signal?: Signal } = {},
): Promise<KillOutcome> {
  const { waitMs = 2000, pollMs = 50, signal = defaultSignal } = opts
  try {
    signal(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch (e) {
    return { sent: false, exited: false, reason: errReason(e) }
  }
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    if (!isAlive(pid, signal)) return { sent: true, exited: true }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  if (!isAlive(pid, signal)) return { sent: true, exited: true }
  return { sent: true, exited: false, reason: 'ignored' }
}

export function fmtKill(o: KillOutcome, port: number, pid: number, force: boolean): string {
  if (o.exited) return `${force ? 'SIGKILL' : 'SIGTERM'} → :${port} (pid ${pid}) exited`
  switch (o.reason) {
    case 'not-permitted': return `:${port} (pid ${pid}) not yours — try sudo`
    case 'no-such-process': return `:${port} already gone`
    case 'ignored':
      return force
        ? `:${port} (pid ${pid}) survived SIGKILL — stuck in the kernel`
        : `:${port} (pid ${pid}) ignored SIGTERM — force with -9`
    default: return `:${port} (pid ${pid}) failed`
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
