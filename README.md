# ports — live view of localhost dev servers

A reimagining of the Ports.app menu-bar tool. One shared data layer, two front
ends: a terminal TUI on npm, and a desktop app in the standalone binaries.

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
ports                 # live TUI (Ink), from npm
ports -a / --all      # include OS daemons, GUI apps, ephemeral-only listeners
ports -v / --version  # print version
ports -h / --help     # usage and keys

./ports               # desktop window, from a release binary — no flags at all
```

Enumerate, kill, and open all live inside whichever view you pick — there are no
subcommands, and neither build has a flag for switching to the other.

The TUI needs a terminal to draw on, and exits 1 when stdout is not a TTY. Keys
keep working even when stdin isn't a TTY (launched from a pipeline, with stdin
redirected, or by a wrapper): it reads the controlling terminal via `/dev/tty`,
the same way fzf and vim do.

## Desktop app

The release binaries are a GUI and nothing else: run `./ports` and a window
opens. It is a chrome-less Chrome window — no tab strip, no address bar —
driven by [barlo](https://github.com/cbcruk/barlo), which finds an installed
Chrome, Chromium, Edge, or Brave, launches it in `--app` mode against a loopback
origin, and bridges the page back into the process over CDP. Set
`BARLO_CHROME_PATH` to point at a browser it does not find; with none installed
at all it says so and exits.

The page itself is one self-contained document (no bundler, no build step, no
CDN), embedded in the binary as a string — which is also what lets it survive
`bun build --compile`, since a compiled binary has no folder to serve from.
Click a port to open it, `kill`/`force` to signal it. The system/ephemeral
toggle and the filter run client-side, so they are instant.

**There is no HTTP API.** `kill` and `open` go over the RPC bridge, which CDP
installs into this window's execution context and nowhere else, so a facility
that can signal processes is not reachable by another local process, by a page
on another origin, or by a rebound DNS name. Only the page is served over HTTP,
on an ephemeral loopback port, and it holds no secrets — so it needs no token,
no `Host` guard, and no `Origin` guard. What replaces them is smaller: the
bridge still refuses any pid that is not currently in the listener list, so it
cannot be turned into a general "kill any pid" call.

The trade is a CDP endpoint, on loopback and unauthenticated, for as long as the
window is open. A local process under the same user could attach to it and drive
the window — but that process could also just call `kill(2)` itself, so this is
not a privilege it did not already have. What it removes is the surface a
*remote* page could reach, which is the one that mattered.

Closing the window exits the process. Bridge names are `__`-prefixed
(`__ports`, `__kill`, `__openPort`) because a classic script's top-level
declarations land on `window`, and an unprefixed `function kill` in the page
silently replaced the bridge with itself; the page script is wrapped for the
same reason, and `src/page.test.ts` guards both.

### Upgrading from an older version

`ports --web` is gone with it: the browser UI became the standalone binaries,
which need no flag, and the npm package is the TUI alone. `--port`, `--tab`, and
`--no-open` went with it — the window picks its own ephemeral port.

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
bun install
bun run dev            # live TUI against your real machine
bun run dev:app        # desktop window against your real machine
bun run test           # parser, view, wire, and page logic; no processes harmed
bun run typecheck
```

**bun is the only toolchain** — building the app already required it, so the
alternative was carrying two package managers to install one dependency. It also
happens to be the path of least resistance for `barlo`, which is a git
dependency: bun installs one without running its lifecycle scripts, while pnpm
refuses it outright unless the package is allowlisted. Nothing needs to be built
at install time either — barlo commits its declarations and resolves to
TypeScript source under bun.

What that bought, beyond the allowlist: bun runs the TypeScript tests directly
(no `tsx`) and bundles the npm build itself (no `esbuild`), so the devDependency
list is types, barlo, and `tsc` for `typecheck`.

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
  the TUI and the desktop app are both just views over it. The app runs one
  collector for its one window and pushes each sweep into the page — a second
  collector would hand it a different (and wrong) CPU baseline, since the CPU
  column is a delta against the previous sample. Overlapping sweeps join the one
  already running rather than stacking, because `lsof` on a busy machine can
  outlast the interval. Rows reach the page with the raw numbers *and* the
  strings formatted by `core.ts`/`view.ts` (`wire.ts`), so the page never
  reimplements a formatter. In the noise filter's place it ships a `noise` flag
  per row, so the toggle is instant instead of a round trip.

## Install

**Binary** — from the [latest release](https://github.com/cbcruk/ports-cli/releases).
Reaching for a binary means you want the GUI, so the binaries are the **desktop app
only** and start it with no flag at all:

```bash
tar -xzf ports-darwin-arm64.tar.gz && ./ports    # window opens
```

Each archive holds one self-contained `ports`; no node, no npm, and no bundled
Chromium — it drives the browser already on the machine. They are built on Linux and
are **not codesigned**, so macOS quarantines them — clear it once with
`xattr -d com.apple.quarantine ./ports`.

**npm** — needs node, and gives you the TUI. The GUI is not here: barlo is built on
`Bun.serve` and `Bun.spawn`, so it cannot run under node, which is why the desktop app
ships as a compiled binary instead of a flag on this package.

## Packaging

```bash
bun run build           # dist/index.js — the npm `ports` bin, TUI only, deps external
bun run build:binary    # ./ports — the desktop app
```

Both run through bun, but they are not the same kind of build. `build` bundles
`src/index.tsx` with `--target=node`, so the published bin is an ordinary node ESM script
that needs no bun on the consumer's machine. `build:binary` compiles `src/web-entry.ts`
into a self-contained executable with the bun runtime inside it.

The split of entry points is not a preference either: `barlo` is bun-only, so it may be
imported from `src/web-entry.ts` and nowhere else. The node-targeted build never sees it,
which is what keeps the npm package runnable under plain node.

Sizes, uncompressed / as shipped in a release archive:

| target | size | archive |
| --- | --- | --- |
| darwin-arm64 | 61 MB | 25 MB |
| darwin-x64 | 68 MB | 28 MB |
| linux-arm64 | 79 MB | 35 MB |
| linux-x64 | 79 MB | 36 MB |

Nearly all of that is the embedded bun runtime, not the app. Chromium is not in there —
the app drives the browser already installed on the machine, which is the whole reason a
GUI fits in 25 MB.

Ink dynamically imports `react-devtools-core`, which bun's bundler resolves eagerly — it is
a devDependency for that reason alone.

### Releases

`.github/workflows/release.yml` runs on a published release (or `workflow_dispatch` with a tag).
bun cross-compiles all four targets from a single Linux runner — no macOS runner, no build matrix —
after `typecheck` and `test` pass, then uploads the archives plus `checksums.txt` to the release.
It refuses to build when the tag and `package.json` version disagree, since the version is compiled
into the binary and would otherwise be wrong.

## Notes / limits

- macOS 14+ target. `lsof`/`ps` parsing and the live path are verified end-to-end on macOS (Darwin 25).
- The window is **not** yet verified on macOS. barlo is verified on Linux/arm64 only; its macOS and
  Windows browser lookups are written from the documented install locations but unexercised, so that
  is the first thing to check on a Mac before cutting a release.
- "Open owning terminal" from the GUI has no clean CLI equivalent (you can't portably focus a terminal tab); dropped in favor of the `o` key, which opens the port's URL.
- Native upgrade path: replace the lsof/ps subprocesses with a napi-rs `libproc` binding (`proc_listpids` + `proc_pidfdinfo`) — zero subprocess spawns per tick.
