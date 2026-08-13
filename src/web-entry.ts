/**
 * Entry point for the single-executable build (`pnpm build:sea`).
 *
 * This ships the browser UI only — deliberately, not as a simplification.
 * Node's SEA support bundles CommonJS, and the TUI's dependency chain (`ink`,
 * `yoga-layout`) uses top-level await, which CommonJS cannot express. The web
 * server pulls in nothing but Hono and node builtins, so it packages cleanly.
 *
 * The TUI is unaffected: it ships through npm, where ESM is fine.
 */
import { startWeb, webOptionsFromArgv } from './web.ts'

declare const __VERSION__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'

const argv = process.argv.slice(2)

if (argv.includes('-v') || argv.includes('--version')) {
  console.log(VERSION)
} else if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ports-web — browser UI for localhost dev servers

usage: ports-web [--port <n>] [--tab] [--no-open]

      --port <n> port to serve on (default 7331, falls back if taken)
      --tab      open a normal browser tab instead of an app window
      --no-open  do not open anything
  -v, --version  print version
  -h, --help     print this help

This build serves the browser UI only. For the terminal UI, install the npm
package and run \`ports\`.`)
} else {
  startWeb(webOptionsFromArgv(argv)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
}
