import assert from 'node:assert'
import { serve } from '@hono/node-server'
import { request } from 'node:http'
import { createApp, toWire, newToken, webOptionsFromArgv, type Collect } from './web.ts'
import type { Row } from './core.ts'
import type { KillOutcome } from './core.ts'

let pass = 0
const ok = (n: string, c: boolean) => { assert(c, n); pass++ }

const mk = (o: Partial<Row>): Row => {
  const r = {
    port: 3000, pid: 4242, command: 'node next dev', framework: 'Next.js',
    project: 'web', cpu: 1.5, memMB: 180, uptimeSecs: 19391, ...o,
  }
  return { ...r, ports: o.ports ?? [r.port] }
}

// ── toWire ── (noise flag + display strings, so the page reuses core's formatters)
const plain = toWire(mk({}))
ok('wire keeps raw fields', plain.port === 3000 && plain.memMB === 180)
ok('wire display ports', plain.display.ports === '3000')
ok('wire display up', plain.display.up === '5h23m')
ok('wire display cpu', plain.display.cpu === '1.5')
ok('dev server is not noise', plain.noise === false)
ok('system process is noise', toWire(mk({ command: '/Applications/Spotify.app/Contents/MacOS/Spotify' })).noise)
ok('ephemeral-only is noise', toWire(mk({ port: 55725, ports: [55725, 57694] })).noise)
ok('multi-port display', toWire(mk({ port: 9229, ports: [9229, 55725, 55727] })).display.ports === '9229 +2')
ok('null cpu display', toWire(mk({ cpu: null })).display.cpu === '·')

// ── webOptionsFromArgv ── (shared by `ports --web` and the SEA binary)
ok('no flags', JSON.stringify(webOptionsFromArgv([])) === JSON.stringify({ open: true }))
ok('port parsed', webOptionsFromArgv(['--port', '9000']).port === 9000)
ok('port 0 is honoured', webOptionsFromArgv(['--port', '0']).port === 0)
ok('non-numeric port ignored', webOptionsFromArgv(['--port', 'abc']).port === undefined)
ok('dangling --port ignored', webOptionsFromArgv(['--port']).port === undefined)
ok('--no-open respected', webOptionsFromArgv(['--no-open']).open === false)

// ── HTTP surface ── (real server on an ephemeral port, fake collector + fake kill)
const TOKEN = newToken()
const rows = [mk({ pid: 4242, port: 3000 }), mk({ pid: 61002, port: 8000, command: 'python3 -m http.server' })]
const collect: Collect = async () => rows

const killed: { pid: number; force: boolean }[] = []
const fakeKill = async (pid: number, force = false): Promise<KillOutcome> => {
  killed.push({ pid, force })
  return { sent: true, exited: true }
}

const { app, bus } = createApp({ token: TOKEN, collect, kill: fakeKill, intervalMs: 60_000 })
const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
  const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => resolve({ server: s, port: info.port }))
})
const base = `http://127.0.0.1:${port}`

const get = (path: string, init?: RequestInit) => fetch(base + path, init)
const postKill = (body: unknown, init: RequestInit = {}) =>
  get('/api/kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  })

// auth
ok('no token is 401', (await get('/api/ports')).status === 401)
ok('wrong token is 401', (await get(`/api/ports?t=${'0'.repeat(32)}`)).status === 401)
ok('query token works', (await get(`/api/ports?t=${TOKEN}`)).status === 200)
ok('bearer token works', (await get('/api/ports', { headers: { authorization: `Bearer ${TOKEN}` } })).status === 200)

// the page itself is gated too, so the HTML never leaks the listener list
ok('page needs a token', (await get('/')).status === 401)
const page = await get(`/?t=${TOKEN}`)
ok('page served with token', page.status === 200 && (await page.text()).includes('🔌 ports'))

// rebinding / cross-origin guards.
// `fetch` refuses to send a forged Host, so drive these through raw http.
const rawGet = (path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })

ok('foreign host rejected', (await rawGet(`/api/ports?t=${TOKEN}`, { host: 'evil.example.com' })) === 403)
ok('foreign origin rejected', (await rawGet(`/api/ports?t=${TOKEN}`, { origin: 'https://evil.example.com' })) === 403)
ok('loopback origin allowed', (await get(`/api/ports?t=${TOKEN}`, { headers: { origin: `http://localhost:${port}` } })).status === 200)

// payload
const listed = await (await get(`/api/ports?t=${TOKEN}`)).json() as { pid: number; display: { ports: string } }[]
ok('lists the collected rows', listed.length === 2)
ok('rows carry display strings', listed[0].display.ports === '3000')

// kill: only tracked listeners, and the signal actually reaches killPid
ok('kill needs a pid', (await postKill({})).status === 400)
ok('untracked pid refused', (await postKill({ pid: 999999 })).status === 404)
ok('untracked pid not signalled', killed.length === 0)

const res = await postKill({ pid: 4242 })
const out = await res.json() as { exited: boolean; message: string }
ok('kill reports exit', res.status === 200 && out.exited)
ok('kill message mentions the port', out.message.includes(':3000'))
ok('kill signalled the pid', killed.length === 1 && killed[0].pid === 4242 && !killed[0].force)

await postKill({ pid: 61002, force: true })
ok('force flag forwarded', killed[1].force === true)

// unauthenticated kill must not reach killPid at all
ok('kill without token is 401', (await get('/api/kill', { method: 'POST', body: '{"pid":4242}' })).status === 401)
ok('kill without token not signalled', killed.length === 2)

bus.stop()
server.close()

console.log(`\n✓ ${pass} assertions passed`)
