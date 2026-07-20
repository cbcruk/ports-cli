import React from 'react'
import { render } from 'ink'
import { App } from './tui.tsx'
import type { Row } from './core.ts'

const data: Row[] = [
  { port: 3000, pid: 52341, command: '/usr/local/bin/node /p/web/node_modules/.bin/next dev', framework: 'Next.js', project: 'web', cpu: 82.4, memMB: 181, uptimeSecs: 19391 },
  { port: 5173, pid: 52890, command: 'node /p/dash/node_modules/vite/bin/vite.js', framework: 'Vite', project: 'dashboard-frontend', cpu: null, memMB: 96, uptimeSecs: 50 },
  { port: 8000, pid: 61002, command: '/opt/homebrew/bin/python3.11 -m http.server 8000', framework: 'Python', project: 'api', cpu: 3.1, memMB: 44, uptimeSecs: 94304 },
]

const { unmount, lastFrame } = render(<App collect={async () => data} intervalMs={100000} />) as any
setTimeout(() => {
  unmount()
  console.log('\n[smoke] rendered without throwing')
  process.exit(0)
}, 250)
