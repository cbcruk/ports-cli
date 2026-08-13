import assert from 'node:assert'
import {
  parseClock, detectFramework, parseListeners, parsePs, parseCwd,
  createCollector, fmtUptime, isSystemProcess, isEphemeralOnly,
  killPid, isAlive, fmtKill, findAppModeBrowser, openApp, type Exec, type Signal,
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
// frameworks that run on top of Vite/Webpack/node must win over the generic rules
ok('sveltekit over vite', detectFramework('node /p/app/node_modules/@sveltejs/kit/src/exports/vite/dev.js') === 'SvelteKit')
ok('gatsby', detectFramework('node /p/site/node_modules/.bin/gatsby develop') === 'Gatsby')
ok('angular', detectFramework('node /p/app/node_modules/@angular/cli/bin/ng serve') === 'Angular')
ok('storybook', detectFramework('node /p/ui/node_modules/.bin/storybook dev -p 6006') === 'Storybook')
ok('expo over node', detectFramework('node /p/app/node_modules/expo/bin/cli start') === 'Expo')
ok('metro over node', detectFramework('node /p/app/node_modules/metro/src/index.js') === 'Expo')
ok('rails not pmua typo', detectFramework('/usr/bin/pmua serve') === '—')

// ── isSystemProcess ── (real macOS listeners seen in the wild)
ok('sys /System', isSystemProcess('/System/Library/PrivateFrameworks/A/mediasharingd --launchd'))
ok('sys /usr/sbin', isSystemProcess('/usr/sbin/mDNSResponder'))
ok('sys GUI app', isSystemProcess('/Applications/Spotify.app/Contents/MacOS/Spotify'))
ok('sys app support', isSystemProcess('/Users/e/Library/Application Support/Figma/FigmaAgent.app/Contents/MacOS/figma_agent'))
ok('dev server not system', !isSystemProcess('/Users/e/proj/web/node_modules/.bin/next dev'))
ok('homebrew not system', !isSystemProcess('/opt/homebrew/bin/python3.11 -m http.server 8000'))

// ── isEphemeralOnly ──
ok('ephemeral only', isEphemeralOnly([55725, 57694]))
ok('has a real port', !isEphemeralOnly([9229, 55725]))
ok('empty is not ephemeral', !isEphemeralOnly([]))

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
    if (cmd === 'lsof' && args.includes('-sTCP:LISTEN'))
      return 'p52341\ncnode\nn127.0.0.1:55725\nn127.0.0.1:3000\nn[::1]:3000\n'
    if (cmd === 'lsof') return 'p52341\nfcwd\nn/Users/e/web\n'
    // ps: bump cputime on 2nd tick
    tick++
    return `52341  185600  05:23:11  ${tick === 1 ? cpu1 : cpu2} /usr/local/bin/node next dev`
  }
}
const col = createCollector(mkExec('0:04.00', '0:04.50'))
const r1 = await col.collect()
// one row per pid, not per port; primary port is the lowest
ok('tick1 one row per pid', r1.length === 1)
ok('tick1 primary port', r1[0].port === 3000)
ok('tick1 all ports', r1[0].ports.join() === '3000,55725')
ok('tick1 cpu null', r1[0].cpu === null)
ok('tick1 framework', r1[0].framework === 'Next.js')
ok('tick1 project', r1[0].project === 'web')
ok('tick1 mem MB', Math.abs(r1[0].memMB - 181.25) < 0.1)
await new Promise((r) => setTimeout(r, 1000))
const r2 = await col.collect()
// ~0.5 CPU-sec over ~1 wall-sec ⇒ ~50%
ok('tick2 cpu number', typeof r2[0].cpu === 'number')
ok('tick2 cpu plausible', r2[0].cpu! > 20 && r2[0].cpu! < 90)

// ── killPid ── (fake signal: no real processes harmed)
const errno = (code: string) => Object.assign(new Error(code), { code })

// dies after `afterProbes` liveness checks
const mkSignal = (afterProbes: number): Signal => {
  let probes = 0
  return (_pid, sig) => {
    if (sig === 0) {
      if (probes++ >= afterProbes) throw errno('ESRCH')
      return
    }
  }
}

const dies = await killPid(1, false, { waitMs: 500, pollMs: 5, signal: mkSignal(2) })
ok('kill reports actual exit', dies.sent && dies.exited)

const stubborn = await killPid(1, false, { waitMs: 60, pollMs: 10, signal: () => {} })
ok('ignored SIGTERM not reported as success', stubborn.sent && !stubborn.exited)
ok('ignored has reason', stubborn.reason === 'ignored')

const denied = await killPid(1, false, { waitMs: 10, pollMs: 5, signal: () => { throw errno('EPERM') } })
ok('EPERM surfaced', !denied.sent && denied.reason === 'not-permitted')

const gone = await killPid(1, false, { waitMs: 10, pollMs: 5, signal: () => { throw errno('ESRCH') } })
ok('ESRCH surfaced', gone.reason === 'no-such-process')

// EPERM on probe means it exists but isn't ours
ok('isAlive EPERM is alive', isAlive(1, () => { throw errno('EPERM') }))
ok('isAlive ESRCH is dead', !isAlive(1, () => { throw errno('ESRCH') }))
ok('isAlive no throw is alive', isAlive(1, () => {}))

ok('fmtKill exit', fmtKill({ sent: true, exited: true }, 3000, 9, false).includes('exited'))
ok('fmtKill perm', fmtKill(denied, 3000, 9, false).includes('sudo'))
ok('fmtKill ignored suggests -9', fmtKill(stubborn, 3000, 9, false).includes('-9'))
ok('fmtKill sigkill survivor differs', fmtKill(stubborn, 3000, 9, true).includes('survived'))

// ── app-mode browser ── (chromeless window when a Chromium browser is installed)
const has = (...installed: string[]) => (c: string) => (installed.includes(c) ? c : null)
const none = () => null

ok('finds chrome on macOS', findAppModeBrowser('darwin', has('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) !== null)
ok('prefers chrome over edge', findAppModeBrowser('darwin', has(
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
))!.includes('Google Chrome'))
ok('finds chromium on linux', findAppModeBrowser('linux', has('chromium')) === 'chromium')
ok('none installed is null', findAppModeBrowser('darwin', none) === null)
ok('unknown platform is null', findAppModeBrowser('win32', has('chrome')) === null)

// openApp: launches a window, or falls back without pretending it succeeded
const launched: { cmd: string; args: string[] }[] = []
const launch = (cmd: string, args: string[]) => void launched.push({ cmd, args })
const opened: string[] = []
const fakeExec = async (_c: string, a: string[]) => { opened.push(a[0]); return '' }

const url = 'http://127.0.0.1:7331/?t=abc'
ok('app mode used when available',
  openApp(url, { platform: 'linux', lookup: has('chromium'), launch, exec: fakeExec }) === 'app')
ok('launched with --app', launched[0].args[0] === `--app=${url}`)
ok('app mode did not also open a tab', opened.length === 0)

ok('falls back to the browser',
  openApp(url, { platform: 'linux', lookup: none, launch, exec: fakeExec }) === 'browser')
ok('fallback opened the url', opened[0] === url)
ok('fallback did not launch a window', launched.length === 1)

ok('--tab skips app mode',
  openApp(url, { tab: true, platform: 'linux', lookup: has('chromium'), launch, exec: fakeExec }) === 'browser')
ok('--tab did not launch a window', launched.length === 1)

console.log(`\n✓ ${pass} assertions passed`)
