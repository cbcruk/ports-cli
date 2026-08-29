/**
 * Pure parsers for `lsof` and `ps` output, plus the classifiers that decide
 * what counts as a dev server.
 *
 * Nothing here spawns anything, so every rule can be asserted against a canned
 * string.
 *
 * @module
 */

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
 * import { parseClock } from './parsers.ts'
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
 * import { detectFramework } from './parsers.ts'
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
