/**
 * Drives the desktop app against a real browser window.
 *
 * `page.test.ts` checks the page's source statically; this loads it, feeds it
 * rows the way the runtime does, and clicks it. The bridge, the render, the
 * filter, and both actions only ever run in a window, so this is the only test
 * that can catch them breaking — and the only one whose result differs per
 * platform, which is why CI runs it on macOS as well as Linux.
 *
 * No `lsof` is involved: rows are fixtures pushed through `toWire`, so a runner
 * without dev servers listening still exercises the whole path.
 */
import assert from 'node:assert'
import { launch } from 'barlo'
import { PAGE } from './web-page.ts'
import { toWire } from './wire.ts'
import type { Row } from './core.ts'

let pass = 0
const ok = (n: string, c: boolean) => { assert(c, n); pass++ }

/** Waits for a bridge round trip rather than guessing at a sleep, so a slow
 *  CI runner does not turn into a flaky assertion. */
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const FIXTURES: Row[] = [
  { port: 3000, ports: [3000], pid: 52341, command: '/usr/local/bin/node next dev', framework: 'Next.js', project: 'web', cpu: 82.4, memMB: 181, uptimeSecs: 19391 },
  { port: 5173, ports: [5173], pid: 52890, command: 'node vite.js', framework: 'Vite', project: 'dashboard', cpu: null, memMB: 96, uptimeSecs: 50 },
  // Ephemeral-only, so the page files it under noise and hides it by default.
  { port: 49500, ports: [49500], pid: 61002, command: 'workerd serve', framework: '—', project: 'edge', cpu: 1, memMB: 20, uptimeSecs: 10 },
]

const rows = FIXTURES.map(toWire)

const app = await launch({
  title: 'ports',
  width: 1180,
  height: 760,
  // Containers and CI images ship a 64MB /dev/shm, which this page's fonts
  // outgrow — Chrome then dies with "No space left on device". Harmless on a
  // real desktop, so it stays here rather than in the app itself.
  args: ['--disable-dev-shm-usage'],
})
app.serveEmbedded({ 'index.html': PAGE })

/** What the page asked the runtime to do. A holder, so assignment inside the
 *  bridge callbacks does not narrow these away for the assertions below. */
const called: {
  openPort: number | null
  kill: { pid: number; force: boolean } | null
} = { openPort: null, kill: null }

await app.exposeFunction('__openPort', (port: number) => { called.openPort = port })
await app.exposeFunction('__kill', async (pid: number, force: boolean) => {
  called.kill = { pid, force }
  return `SIGKILL → :3000 (pid ${pid})`
})

await app.load('index.html')

const win = app.mainWindow()
const text = (sel: string) => app.evaluate<string>(`document.querySelector(${JSON.stringify(sel)}).textContent`)
const count = () => app.evaluate<number>('document.querySelectorAll("#rows tr").length')

// ── the window itself ──
ok('window is not headless', !(await app.evaluate<string>('navigator.userAgent')).includes('Headless'))

// ── the push from the runtime ──
await app.evaluate((p: unknown) => (window as any).__ports(p), { rows })
ok('noise is hidden by default', (await count()) === 2)
ok('count reflects what is shown', (await text('#count')) === '2 listening')
ok('the empty notice is hidden', await app.evaluate<boolean>('document.getElementById("empty").hidden'))
ok('rows carry preformatted display strings', (await text('#rows tr td.num')) === '52341')

// ── the bridge survived the page ──
// A classic script's top-level declarations land on `window`, over the bridge.
// The page is wrapped so it declares nothing; barlo reports it if that changes.
ok('no exposed name was shadowed', (await win.shadowedFunctions()).length === 0)

// ── filter ──
await app.evaluate(`(() => {
  const f = document.getElementById('filter')
  f.value = 'vite'
  f.dispatchEvent(new Event('input'))
})()`)
ok('filter narrows the table', (await count()) === 1)
ok('filter matches on framework', (await text('#rows tr td.fw')) === 'Vite')

await app.evaluate(`(() => {
  const f = document.getElementById('filter')
  f.value = ''
  f.dispatchEvent(new Event('input'))
})()`)

// ── noise toggle ──
await app.evaluate(`(() => {
  const a = document.getElementById('all')
  a.checked = true
  a.dispatchEvent(new Event('change'))
})()`)
ok('the toggle reveals noise', (await count()) === 3)

// ── port click reaches the runtime ──
await app.evaluate('document.querySelector("#rows tr a.port").click()')
await until('__openPort', () => called.openPort !== null)
ok('clicking a port calls __openPort', called.openPort === 3000)

// ── kill reaches the runtime ──
// confirm() blocks the renderer on a real dialog, which would deadlock an
// evaluate; the button wiring is what matters here, not Chrome's dialog.
await app.evaluate('window.confirm = () => true')
await app.evaluate('document.querySelector("#rows tr button.force").click()')
await until('__kill', () => called.kill !== null)
ok('force calls __kill with force set', called.kill?.pid === 52341 && called.kill.force === true)
await until('the status line', async () => (await text('#status')).includes('SIGKILL'))
ok('the runtime message lands in the status line', (await text('#status')).includes('SIGKILL'))

// ── the error path ──
await app.evaluate((p: unknown) => (window as any).__ports(p), { error: 'lsof not found' })
ok('a collector error reaches the status line', (await text('#status')) === 'lsof not found')

app.exit()
console.log(`\n✓ ${pass} assertions passed`)
process.exit(0)
