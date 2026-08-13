import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createCollector, killPid, fmtKill, fmtUptime, fmtCpu,
  isSystemProcess, isEphemeralOnly, openApp, type Row,
} from './core.ts'
import { fmtPorts } from './view.ts'
import { PAGE } from './web-page.ts'

export type Collect = () => Promise<Row[]>

/**
 * A row as sent to the browser: the raw {@link Row} (so the client can sort on
 * real numbers) plus a `noise` flag and preformatted display strings, so the
 * page never has to reimplement the formatters in `core.ts`/`view.ts`.
 */
export type WireRow = Row & {
  noise: boolean
  display: { ports: string; cpu: string; mem: string; up: string }
}

/** Generates the shared secret that gates every endpoint. */
export const newToken = (): string => randomBytes(16).toString('hex')

/**
 * Annotates a row for the wire: marks system/GUI/ephemeral listeners as noise
 * (the client toggles them, so no round trip) and precomputes display strings.
 */
export function toWire(r: Row): WireRow {
  return {
    ...r,
    noise: isSystemProcess(r.command) || isEphemeralOnly(r.ports),
    display: {
      ports: fmtPorts(r),
      cpu: fmtCpu(r.cpu),
      mem: r.memMB.toFixed(0),
      up: fmtUptime(r.uptimeSecs),
    },
  }
}

/** Constant-time token comparison, so a wrong guess leaks no timing signal. */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Polls once for all subscribers and fans the result out.
 *
 * One shared collector matters: the CPU column is a delta against the previous
 * sample, so a collector per client would hand each of them a different (and
 * wrong) baseline. Overlapping ticks are skipped for the same reason.
 *
 * @param collect the data source
 * @param intervalMs poll interval while at least one client is listening
 */
export function createBroadcaster(collect: Collect, intervalMs: number) {
  const subs = new Set<(rows: WireRow[], err: string | null) => void>()
  let timer: NodeJS.Timeout | null = null
  let inFlight = false
  let last: WireRow[] = []

  async function tick() {
    if (inFlight) return
    inFlight = true
    try {
      // Hide the server from its own listing — it is a listener too.
      last = (await collect()).filter((r) => r.pid !== process.pid).map(toWire)
      for (const fn of subs) fn(last, null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      for (const fn of subs) fn(last, msg)
    } finally {
      inFlight = false
    }
  }

  return {
    current: () => last,
    refresh: tick,
    subscribe(fn: (rows: WireRow[], err: string | null) => void) {
      subs.add(fn)
      if (!timer) timer = setInterval(() => void tick(), intervalMs)
      void tick()
      return () => {
        subs.delete(fn)
        // Stop polling entirely once the last tab closes.
        if (subs.size === 0 && timer) { clearInterval(timer); timer = null }
      }
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}

export type AppOptions = {
  token: string
  collect?: Collect
  intervalMs?: number
  /** Injected in tests so `/api/kill` never signals a real process. */
  kill?: typeof killPid
}

/**
 * Builds the Hono app.
 *
 * Every route is gated on the token, which the CLI prints as part of the URL.
 * `Host` and `Origin` are checked as well: the token is the real lock, but a
 * loopback service that kills processes should not be reachable by a rebound
 * DNS name or driven by a page from another origin.
 */
export function createApp({ token, collect, intervalMs = 1500, kill = killPid }: AppOptions) {
  const source: Collect = collect ?? createCollector().collect
  const bus = createBroadcaster(source, intervalMs)
  const app = new Hono()

  app.use('*', async (c, next) => {
    // DNS-rebinding guard: only loopback names may address this server.
    const host = (c.req.header('host') ?? '').split(':')[0]
    if (host && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
      return c.text('forbidden host', 403)
    }
    // A browser sends Origin on cross-origin requests; curl and EventSource send none.
    const origin = c.req.header('origin')
    if (origin && new URL(origin).hostname !== '127.0.0.1' && new URL(origin).hostname !== 'localhost') {
      return c.text('forbidden origin', 403)
    }
    const given = c.req.query('t') ?? (c.req.header('authorization') ?? '').replace(/^Bearer /, '')
    if (!tokenMatches(given, token)) return c.text('unauthorized', 401)
    await next()
  })

  app.get('/', (c) => c.html(PAGE))

  app.get('/api/ports', async (c) => {
    await bus.refresh()
    return c.json(bus.current())
  })

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let close = () => {}
      const closed = new Promise<void>((resolve) => { close = resolve })
      stream.onAbort(close)

      const unsubscribe = bus.subscribe((rows, err) => {
        void stream
          .writeSSE(err
            ? { event: 'fail', data: err.includes('lsof') ? 'lsof not found — required on macOS/Linux' : err }
            : { event: 'rows', data: JSON.stringify(rows) })
          .catch(close) // the tab went away mid-write
      })

      await closed
      unsubscribe()
    }),
  )

  app.post('/api/kill', async (c) => {
    const body = await c.req.json().catch(() => null) as { pid?: number; port?: number; force?: boolean } | null
    if (!body || typeof body.pid !== 'number') return c.json({ message: 'pid required' }, 400)

    // Only ever signal something we are currently listing, so this endpoint
    // cannot be used as a general-purpose "kill any pid on the box" API.
    let row = bus.current().find((r) => r.pid === body.pid)
    if (!row) {
      await bus.refresh()
      row = bus.current().find((r) => r.pid === body.pid)
    }
    if (!row) return c.json({ message: `pid ${body.pid} is not a tracked listener` }, 404)

    const force = body.force === true
    const outcome = await kill(row.pid, force)
    await bus.refresh()
    return c.json({ ...outcome, message: fmtKill(outcome, row.port, row.pid, force) })
  })

  return { app, bus }
}

/**
 * Reads the `--web` options out of argv, shared by the `ports` entry point and
 * the web-only single-executable build so the two cannot drift apart.
 *
 * @param argv arguments after the program name
 * @returns `port` (undefined when absent or non-numeric) and whether to open a browser
 */
export function webOptionsFromArgv(argv: string[]): { port?: number; open: boolean; tab: boolean } {
  const i = argv.indexOf('--port')
  const raw = i === -1 ? undefined : argv[i + 1]
  return {
    port: raw && /^\d+$/.test(raw) ? Number(raw) : undefined,
    open: !argv.includes('--no-open'),
    tab: argv.includes('--tab'),
  }
}

/**
 * Starts the web UI on loopback and prints (and opens) its tokenized URL.
 *
 * @param opts.port preferred port; falls back to an ephemeral one when taken
 * @param opts.open open the URL in the default browser
 * @param opts.intervalMs poll interval
 * @returns the bound port and URL
 */
export function startWeb(
  opts: { port?: number; open?: boolean; tab?: boolean; intervalMs?: number } = {},
): Promise<{ port: number; url: string }> {
  const { port = 7331, open = true, tab = false, intervalMs } = opts
  const token = newToken()
  const { app } = createApp({ token, intervalMs })

  return new Promise((resolve, reject) => {
    const listen = (p: number, isRetry: boolean) => {
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: p }, (info) => {
        const url = `http://127.0.0.1:${info.port}/?t=${token}`
        if (isRetry) console.log(`:${port} was taken — using :${info.port}`)
        console.log(`ports web ui → ${url}`)
        console.log('press ctrl-c to stop')
        if (open && openApp(url, { tab }) === 'browser' && !tab) {
          console.log('(no Chromium-family browser found — opened a normal tab; --tab silences this)')
        }
        resolve({ port: info.port, url })
      })
      server.on('error', (e: NodeJS.ErrnoException) => {
        // The irony of a port tool losing a port race: just take another one.
        if (e.code === 'EADDRINUSE' && !isRetry) listen(0, true)
        else reject(e)
      })
    }
    listen(port, false)
  })
}
