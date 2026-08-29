/**
 * The standalone binary: the browser UI in a chrome-less Chrome window.
 *
 * Downloading a binary is an implicit request for the GUI, so this is the whole
 * program — there is no terminal UI here and therefore no flag to opt out of.
 * The TUI ships via npm, where node is already a given.
 *
 * The window is barlo's: it finds an installed Chrome, Chromium, Edge, or
 * Brave, launches it in `--app` mode against a loopback origin, and bridges the
 * page back into this process over CDP. That bridge is why there is no HTTP API
 * — `__kill` and `__openPort` are installed into this window's execution context
 * and nowhere else, so a loopback service that can signal processes is not
 * something another local process, another origin, or a rebound DNS name can
 * reach. Only the page itself is served over HTTP, and it holds no secrets.
 *
 * Needs bun: barlo is built on `Bun.serve` and `Bun.spawn`, which is why this
 * entry point is compiled with `bun build --compile` and never bundled into the
 * npm build.
 *
 * @module
 */
import { launch } from 'barlo'
import { createCollector, fmtKill, killPid, openPort } from './core.ts'
import { toWire, type WireRow } from './wire.ts'
import { PAGE } from './web-page.ts'

declare const __VERSION__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'

/** Poll interval, matching the TUI's. Fast enough to feel live, cheap enough to leave running. */
const INTERVAL_MS = 1500

/**
 * Opens the window and keeps it fed until it closes.
 *
 * One collector for the one window: the CPU column is a delta against the
 * previous sample, so a second collector would hand the page a different (and
 * wrong) baseline.
 *
 * @returns the process exit code
 */
async function start(): Promise<number> {
  const launched = await launch({ title: 'ports', width: 1180, height: 760 })

  // A GUI that cannot open its window has nothing to say but why, and each
  // failure has a different thing for the reader to do about it.
  if (launched.isErr()) {
    console.error(
      launched.error.match({
        ChromeNotFoundError: () =>
          'No Chrome, Chromium, Edge, or Brave found. Install one, or set BARLO_CHROME_PATH to a browser binary.',
        LaunchTimeoutError: (e) =>
          `The browser did not come up (${e.phase}, waited ${e.ms}ms). Try again, or set BARLO_CHROME_PATH.`,
        BrowserGoneError: (e) => `The browser exited during startup: ${e.message}`,
        ProtocolError: (e) => `The browser refused ${e.method} during startup: ${e.message}`,
      }),
    )
    return 1
  }

  const app = launched.unwrap()
  app.serveEmbedded({ 'index.html': PAGE })

  const { collect } = createCollector()
  let rows: WireRow[] = []

  /**
   * Collects one snapshot and pushes it into the page as `{ rows }`, or as
   * `{ error }` when `lsof` fails — the window stays up either way, since a
   * transient failure is not worth tearing it down for.
   */
  async function poll(): Promise<void> {
    let payload: { rows: WireRow[] } | { error: string }
    try {
      // Hide this process from its own listing — the page's origin is a listener too.
      rows = (await collect()).filter((r) => r.pid !== process.pid).map(toWire)
      payload = { rows }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      payload = { error: msg.includes('lsof') ? 'lsof not found — required on macOS/Linux' : msg }
    }
    // Fails once every window is gone; the exit handler is already on its way,
    // so the Err is the expected end of the loop rather than something to report.
    await app.evaluate((p: unknown) => (window as any).__ports(p), payload)
  }

  /**
   * Re-collects and pushes to the page, at most one sweep at a time.
   *
   * Overlapping calls join the sweep already running rather than starting a
   * second one: `lsof` on a busy machine can outlast the interval, and the
   * `kill` bridge needs a *fresh* `rows` when it awaits this, not an early
   * return that hands it the stale list it just failed to find a pid in.
   */
  let pending: Promise<void> | null = null
  function tick(): Promise<void> {
    pending ??= poll().finally(() => { pending = null })
    return pending
  }

  await app.exposeFunction('__openPort', (port: number) => void openPort(port))

  await app.exposeFunction('__kill', async (pid: number, force: boolean) => {
    // Only ever signal something currently on screen, so the bridge cannot be
    // turned into a general-purpose "kill any pid on the box" call.
    let row = rows.find((r) => r.pid === pid)
    if (!row) {
      await tick()
      row = rows.find((r) => r.pid === pid)
    }
    if (!row) return `pid ${pid} is not a tracked listener`

    const outcome = await killPid(row.pid, force)
    await tick()
    return fmtKill(outcome, row.port, row.pid, force)
  })

  // A GUI that outlives its window is a stray process; closing it should end the run.
  app.onExit(() => process.exit(0))

  await app.load('index.html')
  await tick()
  setInterval(() => void tick(), INTERVAL_MS)
  return 0
}

const argv = process.argv.slice(2)

if (argv.includes('-v') || argv.includes('--version')) {
  console.log(VERSION)
} else if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ports — live view of localhost dev servers, in a desktop window

usage: ports

  -v, --version  print version
  -h, --help     print this help

Opens a window and nothing else: this build has no terminal UI, so there is no
flag to pass. Needs an installed Chrome, Chromium, Edge, or Brave; set
BARLO_CHROME_PATH to point at one it does not find. For the TUI, install the
npm package and run \`ports\`.`)
} else {
  // start() reports its own failures, so anything reaching here is a bug.
  start().then(
    (code) => {
      if (code !== 0) process.exitCode = code
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
    },
  )
}
