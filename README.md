# ports — live view of localhost dev servers

A reimagining of the Ports.app menu-bar tool. One shared data layer, two front
ends: a terminal TUI and a browser UI.

```
🔌 ports  3 listening · sort:port
  PORT      FRAMEWORK PROJECT              PID   CPU%   MEM MB      UP COMMAND
▸ 3000      Next.js   weather            70244    1.2       15    2d8h next-server (v15.3.6)
  3333      Vite      rss-extensions     24546    0.0       22  11d23h /Users/e/.vite-plus/js_runtime/node/…
  9229 +2   Workers   github-traffic-…   61323    0.4       18   4d23h /Users/e/GitHub/github-traffic-dash…
  ↑↓ select · k kill · x force · o open · s sort · / filter · q quit
```

## Usage

```
ports                 # live TUI (Ink)
ports --web           # browser UI on 127.0.0.1:7331, opens your browser
ports --web --port 9000 --no-open
ports -a / --all      # include OS daemons, GUI apps, ephemeral-only listeners
ports -v / --version  # print version
ports -h / --help     # usage and keys
```

Enumerate, kill, and open all live inside whichever view you pick — there are no
subcommands.

The TUI needs a terminal to draw on, and exits 1 when stdout is not a TTY. Keys
keep working even when stdin isn't a TTY (launched from a pipeline, with stdin
redirected, or by a wrapper): it reads the controlling terminal via `/dev/tty`,
the same way fzf and vim do.

## Browser UI

`ports --web` serves a single self-contained page (no bundler, no build step, no
CDN) and streams updates over SSE. Click a port to open it, `kill`/`force` to
signal it. The system/ephemeral toggle and the filter run client-side, so they
are instant.

It is a loopback service that can kill processes, so it is locked down:

- Binds `127.0.0.1` only, and every route — including the HTML — requires a
  random per-run token, printed as part of the URL.
- `Host` must be a loopback name (blocks DNS rebinding) and any `Origin` must be
  loopback too (blocks a page on another origin from driving it).
- `/api/kill` refuses any pid that is not currently in the listener list, so it
  cannot be used as a general "kill any pid" endpoint.

If `--port` is taken it falls back to an ephemeral port rather than failing —
a port tool should not lose to a port race. The server hides its own process
from the listing.

### Upgrading from an older version

The `-w` / `--watch` flag is gone — plain `ports` is the TUI now, and the
`kill`, `open`, and `--json` subcommands moved into it (`k`/`x`, `o`, and the
live table). If bare `ports` still prints a one-shot table, you are running a
stale build: rebuild or reinstall it. `ports -v` prints a version on current
builds and the table on old ones, so it tells the two apart.

## TUI keys

`↑↓` select · `k` SIGTERM · `x` SIGKILL · `o` open · `s` cycle sort · `/` filter · `q` quit

`k`/`x` arm a `y`/`n` confirmation bound to the pid resolved at keypress, so a refresh landing
mid-confirm cannot retarget it. Selection is anchored on pid too — the cursor follows a process
across re-sorts instead of drifting onto its neighbour.

## Develop

```bash
pnpm install
pnpm dev               # live TUI against your real machine
pnpm dev --web         # browser UI against your real machine
pnpm test              # parser + view + HTTP logic, no processes harmed
pnpm typecheck
```

## How it works

- **Enumerate**: `lsof -nP -iTCP -sTCP:LISTEN -F pcn` → pid · command · listening ports. Field output (`-F`), not columns, so parsing is robust. IPv4+IPv6 on the same port dedupe.
- **Enrich**: one batched `ps -o pid=,rss=,etime=,time=,command=` → mem, uptime, cumulative CPU time, full argv. `cwd` via `lsof -d cwd` (cached per pid) for the project name.
- **Live CPU**: `ps` gives *lifetime-average* %cpu, which is useless for a live view. Instead we diff cumulative CPU-time between ticks over wall-clock — the same delta top does. First frame shows `·` (no baseline yet).
- **Framework**: regex over the full argv, specific before generic (Next before bare Node). Next.js renames its process to `next-server (v15.3.6)` once booted, so both the argv and post-rename forms are matched. Frameworks that run *on* Vite/Webpack/node (SvelteKit, Gatsby, Angular, Storybook, Expo) are matched by their own signature before the generic bundler rules. Known: Next.js · SvelteKit · Vite · Nuxt · Astro · Gatsby · Angular · Storybook · Webpack · Remix · Expo · Workers · Bun · Deno · Rails · Python · Go · Node.
- **One row per process**: a pid listening on several ports collapses to a single row keyed on its lowest port, rendered `9229 +2`. `k` kill and `/` filter still match any port in the group.
- **Killing**: signal delivery is not death — a SIGTERM handler can ignore it. `k`/`x` poll until the pid is actually gone and distinguish *not yours* (EPERM) · *already gone* (ESRCH) · *ignored*, each with its own message.
- **Noise filter** — most localhost listeners are not dev servers. Hidden unless `--all`:
  - OS daemons and GUI apps: anything under `/System`, `/usr/sbin`, `/usr/libexec`, `/Library`, or inside a `.app` bundle (ControlCenter, Spotify, VSCode helpers).
  - Processes listening *only* in the ephemeral range (≥ 49152) — workerd and Vite control sockets, never something you'd browse to.

  On a typical machine this is the difference between 54 rows and 4.
- **Two front ends, one collector**: `core.ts` owns every subprocess and parser;
  the TUI and the web server are both just views over it. The web server polls
  once and fans the result out to all open tabs — a collector per tab would give
  each of them a different (and wrong) CPU baseline. Rows reach the browser with
  the raw numbers *and* the strings formatted by `core.ts`/`view.ts`, so the page
  never reimplements a formatter. In the noise filter's place it ships a `noise`
  flag per row, so the toggle is instant instead of a round trip.

## Packaging

```bash
pnpm build              # dist/index.js — the `ports` bin, deps external
pnpm build:binary       # ./ports — standalone, ~51 MB, both UIs, needs bun
pnpm build:sea          # build/ports-web — standalone, ~120 MB, web UI only, node only
```

`build:binary` needs `bun`. Ink dynamically imports `react-devtools-core`, which bun's bundler
resolves eagerly — it is a devDependency for that reason alone.

`build:sea` uses Node's own [single executable](https://nodejs.org/api/single-executable-applications.html)
support, so it needs no toolchain beyond node. **It packages the web UI only, and that is a hard
constraint rather than a choice**: SEA injects a *CommonJS* bundle, and the TUI's dependency chain
(`ink` → `yoga-layout`) uses top-level await, which CommonJS cannot express — bundling it fails
outright. The web server depends on nothing but Hono and node builtins, so it packages cleanly
(a 127 KB bundle; the remaining ~120 MB is the embedded node runtime, which is why this binary is
more than twice the size of the bun one).

On macOS the script strips the signature from `node` before injection and re-signs afterwards —
without that the binary is killed on launch.

## Notes / limits

- macOS 14+ target. Verified end-to-end on macOS (Darwin 25) — `lsof`/`ps` parsing and the live path both.
- "Open owning terminal" from the GUI has no clean CLI equivalent (you can't portably focus a terminal tab); dropped in favor of the `o` key, which opens the port's URL.
- Native upgrade path: replace the lsof/ps subprocesses with a napi-rs `libproc` binding (`proc_listpids` + `proc_pidfdinfo`) — zero subprocess spawns per tick.
