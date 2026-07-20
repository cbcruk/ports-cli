import assert from 'node:assert'
import {
  parseClock, detectFramework, parseListeners, parsePs, parseCwd,
  createCollector, fmtUptime, isSystemProcess, type Exec,
} from './core.ts'

let pass = 0
const ok = (name: string, cond: boolean) => {
  assert(cond, name)
  pass++
}

// ── parseClock ──
ok('clock mm:ss', parseClock('12:07') === 727)
ok('clock hh:mm:ss', parseClock('05:23:11') === 19391)
ok('clock frac', Math.abs(parseClock('0:04.12') - 4.12) < 1e-9)
ok('clock dd-hh:mm:ss', parseClock('1-02:11:44') === 94304)

// ── detectFramework ── (order: specific before generic node)
ok('next', detectFramework('/usr/local/bin/node /p/web/node_modules/.bin/next dev') === 'Next.js')
ok('vite', detectFramework('node /p/dash/node_modules/vite/bin/vite.js') === 'Vite')
ok('python', detectFramework('/opt/homebrew/bin/python3.11 -m http.server 8000') === 'Python')
ok('bun', detectFramework('bun run dev') === 'Bun')
ok('bare node', detectFramework('/usr/local/bin/node server.js') === 'Node')
ok('unknown', detectFramework('/usr/sbin/mDNSResponder') === '—')
// post-boot Next renames its own process; argv is gone by then
ok('next-server rename', detectFramework('next-server (v15.3.6)') === 'Next.js')
ok('next router worker', detectFramework('next-router-worker') === 'Next.js')
ok('next not nextcloud', detectFramework('/opt/nextcloud/bin/serve') === '—')
ok('workerd', detectFramework('/p/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve') === 'Workers')

// ── isSystemProcess ── (real macOS listeners seen in the wild)
ok('sys /System', isSystemProcess('/System/Library/PrivateFrameworks/A/mediasharingd --launchd'))
ok('sys /usr/sbin', isSystemProcess('/usr/sbin/mDNSResponder'))
ok('sys GUI app', isSystemProcess('/Applications/Spotify.app/Contents/MacOS/Spotify'))
ok('sys app support', isSystemProcess('/Users/e/Library/Application Support/Figma/FigmaAgent.app/Contents/MacOS/figma_agent'))
ok('dev server not system', !isSystemProcess('/Users/e/proj/web/node_modules/.bin/next dev'))
ok('homebrew not system', !isSystemProcess('/opt/homebrew/bin/python3.11 -m http.server 8000'))

// ── parseListeners ── (macOS lsof -F pcn: IPv4+IPv6 dedupe, wildcard)
const LSOF = `p52341
cnode
n127.0.0.1:3000
n[::1]:3000
p52890
cnode
n*:5173
p61002
cpython3.11
n127.0.0.1:8000`
const L = parseListeners(LSOF)
ok('listeners count', L.size === 3)
ok('ipv4+ipv6 dedupe', L.get(52341)!.ports.size === 1 && L.get(52341)!.ports.has(3000))
ok('wildcard port', L.get(52890)!.ports.has(5173))

// ── parsePs ── (command contains spaces)
const PS = `52341  185600     05:23:11   0:04.12 /usr/local/bin/node /p/web/node_modules/.bin/next dev
61002   45120  1-02:11:44   1:23.00 /opt/homebrew/bin/python3.11 -m http.server 8000`
const P = parsePs(PS)
ok('ps rss', P.get(52341)!.rss === 185600)
ok('ps etime', P.get(52341)!.etime === 19391)
ok('ps cpuSecs', Math.abs(P.get(52341)!.cpuSecs - 4.12) < 1e-9)
ok('ps command spaces', P.get(52341)!.command.endsWith('next dev'))
ok('ps cputime dd', P.get(61002)!.cpuSecs === 83)

// ── parseCwd ──
const CWD = `p52341
fcwd
n/Users/e/proj/web
p61002
fcwd
n/Users/e/proj/api-server`
const C = parseCwd(CWD)
ok('cwd basename', C.get(52341) === 'web')
ok('cwd hyphen name', C.get(61002) === 'api-server')

// ── fmtUptime ──
ok('uptime s', fmtUptime(45) === '45s')
ok('uptime m', fmtUptime(600) === '10m')
ok('uptime h', fmtUptime(19391) === '5h23m')

// ── collector: CPU null on first tick, number on second (delta over real sleep) ──
const mkExec = (cpu1: string, cpu2: string): Exec => {
  let tick = 0
  return async (cmd, args) => {
    if (cmd === 'lsof' && args.includes('-sTCP:LISTEN')) return 'p52341\ncnode\nn127.0.0.1:3000\n'
    if (cmd === 'lsof') return 'p52341\nfcwd\nn/Users/e/web\n'
    // ps: bump cputime on 2nd tick
    tick++
    return `52341  185600  05:23:11  ${tick === 1 ? cpu1 : cpu2} /usr/local/bin/node next dev`
  }
}
const col = createCollector(mkExec('0:04.00', '0:04.50'))
const r1 = await col.collect()
ok('tick1 one row', r1.length === 1 && r1[0].port === 3000)
ok('tick1 cpu null', r1[0].cpu === null)
ok('tick1 framework', r1[0].framework === 'Next.js')
ok('tick1 project', r1[0].project === 'web')
ok('tick1 mem MB', Math.abs(r1[0].memMB - 181.25) < 0.1)
await new Promise((r) => setTimeout(r, 1000))
const r2 = await col.collect()
// ~0.5 CPU-sec over ~1 wall-sec ⇒ ~50%
ok('tick2 cpu number', typeof r2[0].cpu === 'number')
ok('tick2 cpu plausible', r2[0].cpu! > 20 && r2[0].cpu! < 90)

console.log(`\n✓ ${pass} assertions passed`)
