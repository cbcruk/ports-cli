/**
 * Entry point for the standalone binaries (`pnpm build:binary`, `pnpm build:sea`).
 *
 * Downloading a binary is an implicit request for the GUI, so the binaries carry
 * the browser UI and start it with no flag — `--web` exists only in the npm
 * build, where the TUI is the default and has to be opted out of.
 *
 * Dropping the TUI here is also what makes the SEA build possible at all: it
 * injects a CommonJS bundle, and the TUI's dependency chain (`ink`,
 * `yoga-layout`) uses top-level await, which CommonJS cannot express.
 */
import { startWeb, webOptionsFromArgv } from './web.ts'

declare const __VERSION__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'

const argv = process.argv.slice(2)

if (argv.includes('-v') || argv.includes('--version')) {
  console.log(VERSION)
} else if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ports — browser UI for localhost dev servers

usage: ports [--port <n>] [--tab] [--no-open]

      --port <n> port to serve on (default 7331, falls back if taken)
      --tab      open a normal browser tab instead of an app window
      --no-open  do not open anything
  -v, --version  print version
  -h, --help     print this help

Starts the browser UI directly — this build has no terminal UI, so there is no
--web flag to pass. For the TUI, install the npm package and run \`ports\`.`)
} else {
  startWeb(webOptionsFromArgv(argv)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
}
