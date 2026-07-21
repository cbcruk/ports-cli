#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { App } from './tui.tsx'

// Replaced at build time via esbuild/bun `--define`; falls back to 'dev' under tsx.
declare const __VERSION__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'

const argv = process.argv.slice(2)
const showAll = argv.includes('-a') || argv.includes('--all')

if (argv.includes('-v') || argv.includes('--version')) {
  console.log(VERSION)
} else if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ports — live TUI for localhost dev servers

usage: ports [-a | --all]

  -a, --all      include OS daemons, GUI apps, ephemeral-only listeners
  -v, --version  print version
  -h, --help     print this help

keys: ↑↓ select · k kill · x force · o open · s sort · / filter · q quit`)
} else if (!process.stdout.isTTY || !process.stdin.isTTY) {
  // The TUI needs stdout to draw and stdin (raw mode) to read keys; without both
  // it would render but never accept input — not even a way to quit.
  console.error('ports needs an interactive terminal (TTY) to run')
  process.exitCode = 1
} else {
  render(<App showAll={showAll} />)
}
