# ports — CLI/TUI for localhost dev servers

A CLI reimagining of the Ports.app menu-bar tool. One shared data layer, several views.

```
$ ports
PORT      FRAMEWORK PROJECT              PID   CPU%   MEM MB      UP COMMAND
3000      Next.js   weather            70244    1.2       15    2d8h next-server (v15.3.6)
3333      Vite      rss-extensions     24546    0.0       22  11d23h /Users/e/.vite-plus/js_runtime/node/…
9229 +2   Workers   github-traffic-…   61323    0.4       18   4d23h /Users/e/GitHub/github-traffic-dash…
```

## Usage

```
ports                 # snapshot table (double-samples for a live CPU %)
ports --json          # machine output, pipe into jq
ports -w              # live TUI (Ink)
ports -a / --all      # include OS daemons, GUI apps, ephemeral-only listeners
ports kill 3000 4000  # kill by port — SIGTERM (add -9 for SIGKILL)
ports open 3000       # open http://localhost:3000
```

`kill` exits 1 for any port it did not manage to kill, so it composes:

```bash
ports kill 3000 || echo "nothing was listening"
```

## TUI keys

`↑↓` select · `k` SIGTERM · `x` SIGKILL · `o` open · `s` cycle sort · `/` filter · `q` quit

`k`/`x` arm a `y`/`n` confirmation bound to the pid resolved at keypress, so a refresh landing
mid-confirm cannot retarget it. Selection is anchored on pid too — the cursor follows a process
across re-sorts instead of drifting onto its neighbour.

## Develop

```bash
pnpm install
pnpm watch             # live TUI against your real machine
pnpm test              # parser + view logic, no processes harmed
pnpm typecheck
```

## How it works

- **Enumerate**: `lsof -nP -iTCP -sTCP:LISTEN -F pcn` → pid · command · listening ports. Field output (`-F`), not columns, so parsing is robust. IPv4+IPv6 on the same port dedupe.
- **Enrich**: one batched `ps -o pid=,rss=,etime=,time=,command=` → mem, uptime, cumulative CPU time, full argv. `cwd` via `lsof -d cwd` (cached per pid) for the project name.
- **Live CPU**: `ps` gives *lifetime-average* %cpu, which is useless for a live view. Instead we diff cumulative CPU-time between ticks over wall-clock — the same delta top does. First frame shows `·` (no baseline yet).
- **Framework**: regex over the full argv, specific before generic (Next before bare Node). Next.js renames its process to `next-server (v15.3.6)` once booted, so both the argv and post-rename forms are matched. Known: Next.js · Vite · Nuxt · Astro · Webpack · Remix · Workers · Bun · Deno · Rails · Python · Go · Node.
- **One row per process**: a pid listening on several ports collapses to a single row keyed on its lowest port, rendered `9229 +2`. `kill` and `/` filter still match any port in the group.
- **Killing**: signal delivery is not death — a SIGTERM handler can ignore it. `kill` polls until the pid is actually gone and distinguishes *not yours* (EPERM) · *already gone* (ESRCH) · *ignored*, each with its own message.
- **Noise filter** — most localhost listeners are not dev servers. Hidden unless `--all`:
  - OS daemons and GUI apps: anything under `/System`, `/usr/sbin`, `/usr/libexec`, `/Library`, or inside a `.app` bundle (ControlCenter, Spotify, VSCode helpers).
  - Processes listening *only* in the ephemeral range (≥ 49152) — workerd and Vite control sockets, never something you'd browse to.

  On a typical machine this is the difference between 54 rows and 4.

## JSON

One object per process. `port` is the primary (lowest); `ports` holds the whole group.

```json
{
  "port": 9229,
  "ports": [9229, 55725, 55727],
  "pid": 61323,
  "command": "…/workerd serve --socket-addr=entry=127.0.0.1:9229",
  "framework": "Workers",
  "project": "github-traffic-dashboard",
  "cpu": 0.4,
  "memMB": 18,
  "uptimeSecs": 428400
}
```

`cpu` is `null` only when there is no baseline to diff against — every other path double-samples.

## Packaging

```bash
pnpm build              # dist/index.js — the `ports` bin, deps external
pnpm build:binary       # ./ports — standalone, ~51 MB, no node_modules
```

`build:binary` needs `bun`. Ink dynamically imports `react-devtools-core`, which bun's bundler
resolves eagerly — it is a devDependency for that reason alone.

## Notes / limits

- macOS 14+ target. Verified end-to-end on macOS (Darwin 25) — `lsof`/`ps` parsing and the live path both.
- "Open owning terminal" from the GUI has no clean CLI equivalent (you can't portably focus a terminal tab); dropped in favor of `open <url>`.
- Native upgrade path: replace the lsof/ps subprocesses with a napi-rs `libproc` binding (`proc_listpids` + `proc_pidfdinfo`) — zero subprocess spawns per tick.
