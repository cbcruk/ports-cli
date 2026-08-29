import {
  detectFramework, isEphemeralOnly, isSystemProcess,
  parseClock, parseCwd, parseListeners, parsePs,
} from './parsers.ts'
import { ok, summary } from './test-assert.ts'

ok('clock mm:ss', parseClock('12:07') === 727)
ok('clock hh:mm:ss', parseClock('05:23:11') === 19391)
ok('clock frac', Math.abs(parseClock('0:04.12') - 4.12) < 1e-9)
ok('clock dd-hh:mm:ss', parseClock('1-02:11:44') === 94304)

// Rules are ordered specific before generic, so every case below also asserts
// that the bare-node fallback did not win first.
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

// real macOS listeners seen in the wild
ok('sys /System', isSystemProcess('/System/Library/PrivateFrameworks/A/mediasharingd --launchd'))
ok('sys /usr/sbin', isSystemProcess('/usr/sbin/mDNSResponder'))
ok('sys GUI app', isSystemProcess('/Applications/Spotify.app/Contents/MacOS/Spotify'))
ok('sys app support', isSystemProcess('/Users/e/Library/Application Support/Figma/FigmaAgent.app/Contents/MacOS/figma_agent'))
ok('dev server not system', !isSystemProcess('/Users/e/proj/web/node_modules/.bin/next dev'))
ok('homebrew not system', !isSystemProcess('/opt/homebrew/bin/python3.11 -m http.server 8000'))

ok('ephemeral only', isEphemeralOnly([55725, 57694]))
ok('has a real port', !isEphemeralOnly([9229, 55725]))
ok('empty is not ephemeral', !isEphemeralOnly([]))

// captured from macOS `lsof -F pcn`: one pid bound on both IPv4 and IPv6, one wildcard
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

const PS = `52341  185600     05:23:11   0:04.12 /usr/local/bin/node /p/web/node_modules/.bin/next dev
61002   45120  1-02:11:44   1:23.00 /opt/homebrew/bin/python3.11 -m http.server 8000`
const P = parsePs(PS)
ok('ps rss', P.get(52341)!.rss === 185600)
ok('ps etime', P.get(52341)!.etime === 19391)
ok('ps cpuSecs', Math.abs(P.get(52341)!.cpuSecs - 4.12) < 1e-9)
ok('ps command spaces', P.get(52341)!.command.endsWith('next dev'))
ok('ps cputime dd', P.get(61002)!.cpuSecs === 83)

const CWD = `p52341
fcwd
n/Users/e/proj/web
p61002
fcwd
n/Users/e/proj/api-server`
const C = parseCwd(CWD)
ok('cwd basename', C.get(52341) === 'web')
ok('cwd hyphen name', C.get(61002) === 'api-server')

summary()
