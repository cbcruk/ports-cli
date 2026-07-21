#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { App } from './tui.tsx'

const argv = process.argv.slice(2)
const showAll = argv.includes('-a') || argv.includes('--all')

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ports — live TUI for localhost dev servers

usage: ports [-a | --all]

  -a, --all   include OS daemons, GUI apps, ephemeral-only listeners

keys: ↑↓ select · k kill · x force · o open · s sort · / filter · q quit`)
} else if (!process.stdout.isTTY) {
  console.error('ports needs an interactive terminal (TTY) to run')
  process.exitCode = 1
} else {
  render(<App showAll={showAll} />)
}
