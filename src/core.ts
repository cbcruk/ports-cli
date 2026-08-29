/**
 * Enumerates localhost listeners and the actions that operate on them.
 *
 * The data layer both front ends share: pure parsers for `lsof`/`ps` output, a
 * stateful collector that turns them into {@link Row}s, the kill/open actions,
 * and the formatters the TUI and the app window both render with.
 *
 * @example List every listening dev server once
 * ```ts
 * import { createCollector } from './core.ts'
 *
 * const { collect } = createCollector()
 * for (const row of await collect()) console.log(row.port, row.framework)
 * ```
 *
 * @module
 */
import { execFile } from 'node:child_process'

/**
 * One localhost listener, collapsed to a single process.
 *
 * A process listening on several ports yields one row rather than several: the
 * lowest port is the one you would browse to, and the rest stay in
 * {@link Row.ports}.
 */
export type Row = {
  /** Primary port — the lowest one the process listens on. */
  port: number
  /** Every port this pid listens on, ascending. */
  ports: number[]
  /** Process id of the listener. */
  pid: number
  /** Full argv / command string, as reported by `ps`. */
  command: string
  /** Framework name from {@link detectFramework}, or `'—'` when unrecognised. */
  framework: string
  /** Basename of the process's working directory, or `''` when unknown. */
  project: string
  /** Instantaneous %CPU, or `null` on the first sample — there is no baseline to diff against yet. */
  cpu: number | null
  /** Resident set size in MB. */
  memMB: number
  /** Seconds elapsed since the process started. */
  uptimeSecs: number
}

/**
 * Runs an external command and resolves with its stdout.
 *
 * Injectable so parsers can be tested against canned output instead of
 * spawning real `lsof`/`ps` subprocesses.
 */
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

/**
 * Converts a `ps`-style clock string to seconds.
 *
 * Handles the `[[dd-]hh:]mm:ss[.frac]` shape emitted by `etime` and `time`,
 * where the leading day and hour fields are optional.
 *
 * @param s clock string, e.g. `"11-23:04:05"`, `"01:30"`, or `"5.42"`
 * @returns total elapsed seconds
 *
 * @example Every field width `ps` can emit
 * ```ts
 * import { parseClock } from './core.ts'
 *
 * parseClock('5.42') // 5.42
 * parseClock('01:30') // 90
 * parseClock('11-23:04:05') // 1033445
 * ```
 */
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
  // SvelteKit / Gatsby / Angular / Storybook run *on* Vite or Webpack, so match
  // their own signatures before the generic bundler rules below.
  [/svelte-kit|@sveltejs\//, 'SvelteKit'],
  [/vite/, 'Vite'],
  [/nuxt/, 'Nuxt'],
  [/astro/, 'Astro'],
  [/\bgatsby\b/, 'Gatsby'],
  [/@angular\/|\bng serve\b/, 'Angular'],
  [/storybook/, 'Storybook'],
  [/webpack|react-scripts/, 'Webpack'],
  [/remix/, 'Remix'],
  // Expo/Metro bundlers run on node — match before the bare-node fallback.
  [/\bexpo\b|\bmetro\b/, 'Expo'],
  [/\bworkerd\b|wrangler/, 'Workers'],
  [/\bbun\b/, 'Bun'],
  [/\bdeno\b/, 'Deno'],
  [/rails|puma/, 'Rails'],
  [/uvicorn|gunicorn|flask|manage\.py runserver|http\.server/, 'Python'],
  [/\/go-build\/|\bgo run\b/, 'Go'],
  [/\bnode\b/, 'Node'],
]

/**
 * Identifies the dev-server framework behind a process from its command line.
 *
 * Rules are matched in order, specific before generic (e.g. Next.js before a
 * bare Node match), so the first hit wins.
 *
 * @param command full argv / command string of the process
 * @returns the framework name, or `'—'` when nothing matches
 *
 * @example Specific rules win over the bare-runtime fallback
 * ```ts
 * import { detectFramework } from './core.ts'
 *
 * detectFramework('node /p/web/node_modules/.bin/next dev') // 'Next.js'
 * detectFramework('/usr/local/bin/node server.js') // 'Node'
 * detectFramework('/usr/sbin/cupsd -l') // '—'
 * ```
 */
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

/**
 * Reports whether a command belongs to an OS daemon or GUI app rather than a
 * dev server — matched by its executable path (`/System`, `/Library`, `.app`
 * bundles, …). Used to hide noise unless `--all` is set.
 *
 * @param command full argv / command string of the process
 * @returns `true` if the process looks like system/GUI noise
 */
export function isSystemProcess(command: string): boolean {
  return SYSTEM_RULES.some((re) => re.test(command))
}

/**
 * First port of the IANA ephemeral range.
 *
 * workerd and Vite open transient control sockets here; a process listening
 * *only* on such ports is plumbing, not something you would browse to.
 */
export const EPHEMERAL_MIN = 49152

/**
 * Reports whether a process listens *only* on ports in the IANA ephemeral
 * range (≥ {@link EPHEMERAL_MIN}). Such listeners are transient control
 * sockets (workerd/Vite), never something you'd browse to, so they are hidden
 * unless `--all` is set.
 *
 * @param ports every port the process listens on
 * @returns `true` when the set is non-empty and entirely ephemeral
 */
export function isEphemeralOnly(ports: number[]): boolean {
  return ports.length > 0 && ports.every((p) => p >= EPHEMERAL_MIN)
}

/**
 * Parses `lsof -F pcn` field output into per-pid command and listening ports.
 *
 * Field output (`-F`) is keyed by a leading tag per line: `p` pid, `c` command,
 * `n` network address — chosen over column output because it parses robustly.
 *
 * @param out raw stdout from `lsof -nP -iTCP -sTCP:LISTEN -F pcn`
 * @returns map of pid → `{ command, ports }`
 */
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

/**
 * Parses whitespace-delimited `ps` output into per-pid stats.
 *
 * Expects columns `pid rss etime time command…`; the command may contain
 * spaces, so everything past the fourth field is rejoined. Lines with fewer
 * than five fields are skipped.
 *
 * @param out raw stdout from `ps -o pid=,rss=,etime=,time=,command=`
 * @returns map of pid → `{ rss, etime, cpuSecs, command }`
 */
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

/**
 * Parses `lsof … -d cwd -Fn` output into each pid's working-directory basename,
 * which the UI shows as the project name.
 *
 * @param out raw stdout from `lsof -p <pids> -a -d cwd -Fn`
 * @returns map of pid → last path segment of its cwd
 */
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

/** A stateful snapshotter of localhost listeners, built by {@link createCollector}. */
export type Collector = {
  /** Takes one snapshot, reusing the previous call's CPU sample and cwd cache. */
  collect: () => Promise<Row[]>
}

/**
 * Builds a stateful collector that snapshots current localhost listeners.
 *
 * The returned `collect` is stateful across calls: it retains the previous CPU
 * sample so it can report an instantaneous %CPU as a delta, and caches each
 * pid's cwd so the project name is resolved only once.
 *
 * @param exec command runner (defaults to a real `execFile`); inject to test
 * @returns a collector whose `collect()` shares one CPU baseline across calls
 *
 * @example Two ticks, one baseline
 * ```ts
 * import { createCollector } from './core.ts'
 *
 * const { collect } = createCollector()
 * await collect() // every row's `cpu` is null — nothing to diff against yet
 * await new Promise((r) => setTimeout(r, 1500))
 * await collect() // `cpu` is now a real percentage
 * ```
 */
export function createCollector(exec: Exec = defaultExec): Collector {
  let prev = new Map<number, { cpuSecs: number; wallMs: number }>()
  const cwdCache = new Map<number, string>()

  /**
   * Enumerates and enriches every localhost listener into a {@link Row}[].
   *
   * Runs `lsof` for listeners, one batched `ps` for stats, and `lsof -d cwd`
   * for uncached pids, then diffs CPU-time against the prior call for a live
   * %CPU (`null` on the first sample). Rows are collapsed one-per-pid and
   * sorted ascending by primary port.
   *
   * @returns the current rows, or `[]` when nothing is listening
   */
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

/**
 * Sends a signal to a pid, or probes it with signal `0`.
 *
 * Injectable so the kill wait loop can be tested without real processes.
 */
export type Signal = (pid: number, sig: NodeJS.Signals | 0) => void
const defaultSignal: Signal = (pid, sig) => void process.kill(pid, sig)

/**
 * The result of a {@link killPid} attempt.
 *
 * Delivering a signal and the process actually dying are separate facts, so
 * they are separate fields — a SIGTERM handler may swallow the signal.
 */
export type KillOutcome = {
  /** Whether the signal was delivered at all. */
  sent: boolean
  /** Whether the process was confirmed gone before the wait budget ran out. */
  exited: boolean
  /** Why it did not exit: `EPERM`, `ESRCH`, a swallowed signal, or an unclassified error. */
  reason?: 'not-permitted' | 'no-such-process' | 'ignored' | 'unknown'
}

/**
 * Reports whether a pid is still alive by sending it signal `0` (a
 * permission/existence probe that delivers nothing).
 *
 * `EPERM` means the process exists but isn't ours — so it counts as alive;
 * `ESRCH` means it's gone.
 *
 * @param pid process id to probe
 * @param signal signal sender (injectable for tests)
 * @returns `true` if the process still exists
 */
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

/**
 * Signals a process and waits until it has actually exited.
 *
 * Sending a signal only means it was delivered — a SIGTERM handler may ignore
 * it — so this polls with signal `0` until the pid is gone or `waitMs`
 * elapses, letting callers report the truth (exited vs. ignored vs. EPERM).
 *
 * @param pid process id to kill
 * @param force send `SIGKILL` instead of `SIGTERM`
 * @param opts `waitMs` total budget, `pollMs` poll interval, injectable `signal`
 * @returns the resolved {@link KillOutcome}
 *
 * @example Escalate to SIGKILL only when SIGTERM is ignored
 * ```ts
 * import { createCollector, killPid, fmtKill } from './core.ts'
 *
 * const [row] = await createCollector().collect()
 * let outcome = await killPid(row.pid)
 * if (outcome.reason === 'ignored') outcome = await killPid(row.pid, true)
 * console.log(fmtKill(outcome, row.port, row.pid, true))
 * ```
 */
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

/**
 * Renders a {@link KillOutcome} as a human-readable status line, distinguishing
 * success from *not yours* (EPERM), *already gone* (ESRCH), and *ignored*.
 *
 * @param o outcome returned by {@link killPid}
 * @param port port shown in the message
 * @param pid process id shown in the message
 * @param force whether the attempt used `SIGKILL`
 * @returns a one-line summary suitable for display
 */
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

/**
 * Opens a URL in the default browser via the platform opener (`open` on macOS,
 * `xdg-open` elsewhere). Fire-and-forget: failures are swallowed so a missing
 * opener can't crash the UI.
 *
 * @param url the URL to open
 * @param exec command runner (injectable for tests)
 */
export function openUrl(url: string, exec: Exec = defaultExec): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  void exec(opener, [url]).catch(() => {})
}

/**
 * Opens `http://localhost:<port>` in the default browser.
 *
 * @param port localhost port to open
 * @param exec command runner (injectable for tests)
 */
export function openPort(port: number, exec: Exec = defaultExec): void {
  openUrl(`http://localhost:${port}`, exec)
}

// ── formatters ───────────────────────────────────────────────────────────────

/**
 * Formats a duration in seconds as a compact, largest-unit uptime string,
 * e.g. `45s`, `12m`, `3h07m`, `2d8h`.
 *
 * @param s duration in seconds
 * @returns compact human-readable uptime
 */
export function fmtUptime(s: number): string {
  if (s < 60) return `${s | 0}s`
  if (s < 3600) return `${(s / 60) | 0}m`
  if (s < 86400) return `${(s / 3600) | 0}h${((s % 3600) / 60) | 0}m`
  return `${(s / 86400) | 0}d${((s % 86400) / 3600) | 0}h`
}

/**
 * Formats a %CPU value: `·` when there's no baseline yet (`null`), otherwise
 * one decimal below 10 and whole numbers at or above it.
 *
 * @param c instantaneous %CPU, or `null` on the first sample
 * @returns display string for the CPU column
 */
export function fmtCpu(c: number | null): string {
  return c == null ? '·' : c.toFixed(c >= 10 ? 0 : 1)
}
