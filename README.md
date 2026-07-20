# ports — CLI/TUI for localhost dev servers

A CLI reimagining of the Ports.app menu-bar tool. One shared data layer, several views.

```
ports                 # snapshot table (double-samples for a live CPU %)
ports --json          # machine output, pipe into jq
ports -w              # live TUI (Ink)
ports --all           # include OS daemons and GUI apps (hidden by default)
ports kill 3000 4000  # kill by port — SIGTERM (add -9 for SIGKILL)
ports open 3000       # open http://localhost:3000
```

## Run

```bash
pnpm install
pnpm build             # bundles to dist/index.js (the `ports` bin)
pnpm watch             # or: npx tsx src/index.tsx -w
pnpm test              # parser + view logic (40 + 20 assertions)
pnpm typecheck
```

## TUI keys

`↑↓` select · `k` SIGTERM · `x` SIGKILL · `o` open · `s` cycle sort · `/` filter · `q` quit

## How it works

- **Enumerate**: `lsof -nP -iTCP -sTCP:LISTEN -F pcn` → pid · command · listening ports. Field output (`-F`), not columns, so parsing is robust. IPv4+IPv6 on the same port dedupe.
- **Enrich**: one batched `ps -o pid=,rss=,etime=,time=,command=` → mem, uptime, cumulative CPU time, full argv. `cwd` via `lsof -d cwd` (cached per pid) for the project name.
- **Live CPU**: `ps` gives *lifetime-average* %cpu, which is useless for a live view. Instead we diff cumulative CPU-time between ticks over wall-clock — the same delta top does. First frame shows `·` (no baseline yet).
- **Framework**: regex over the full argv (Next before bare Node, etc.). Next.js renames its process to `next-server (v15.3.6)` once booted, so both the argv and post-rename forms are matched.
- **Noise filter**: most localhost listeners are OS daemons and GUI apps (ControlCenter, Spotify, VSCode helpers). Anything under `/System`, `/usr/sbin`, `/Library`, or inside a `.app` bundle is hidden unless `--all`.

## Notes / limits

- macOS 14+ target. Verified end-to-end on macOS (Darwin 25) — `lsof`/`ps` parsing and the live path both.
- Some tools open transient high-numbered control sockets (workerd, Vite HMR); these show as extra rows since they are genuine listeners.
- "Open owning terminal" from the GUI has no clean CLI equivalent (you can't portably focus a terminal tab); dropped in favor of `open <url>`.
- Native upgrade path: replace the lsof/ps subprocesses with a napi-rs `libproc` binding (`proc_listpids` + `proc_pidfdinfo`) — zero subprocess spawns per tick.

## Packaging → single binary

```bash
bun build src/index.tsx --compile --outfile ports   # fast startup, no node_modules
```
