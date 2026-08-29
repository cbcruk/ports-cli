import { ok, summary } from './test-assert.ts'
import { PAGE } from './web-page.ts'

// Comment lines are dropped so prose about the bridge does not read as a use of
// it. Only whole-line comments, so a `http://…` in a string survives.
const script = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'))
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')

// A classic script's top-level declarations become properties of `window`,
// which is exactly where the runtime installs its bridge. An unwrapped
// `function kill` once replaced `window.kill` with itself, so the kill button
// called the page back instead of the runtime. Two guards against a repeat:
// the script is wrapped, and every bridge name is `__`-prefixed.
ok('page script is wrapped', script.includes(';(() => {') && script.trimEnd().endsWith('})()'))

const BRIDGE = ['__ports', '__kill', '__openPort']
const referenced = [...script.matchAll(/window\.(\w+)/g)].map((m) => m[1])
ok('page uses the bridge', BRIDGE.every((n) => referenced.includes(n)))
ok('every window.* reference is a bridge name', referenced.every((n) => BRIDGE.includes(n)))
ok('no bare bridge names leak in', !/\b(?<!\.)__kill\s*\(/.test(script.replace(/window\.__kill/g, '')))

// A process command line is attacker-influenced text and must never be parsed
// as markup, so the page builds rows with DOM APIs only.
ok('no innerHTML', !PAGE.includes('innerHTML'))
ok('no document.write', !PAGE.includes('document.write'))

// Nothing is fetched: the page holds no token because there is no HTTP API to
// authenticate against.
ok('no fetch', !script.includes('fetch('))
ok('no EventSource', !script.includes('EventSource'))
ok('no token in the page', !/\bt=|token/.test(script))

summary()
