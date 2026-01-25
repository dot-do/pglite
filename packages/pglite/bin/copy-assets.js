#!/usr/bin/env node
/**
 * Copy PGLite WASM and data files to your project for Cloudflare Workers.
 *
 * Usage: npx @dotdo/pglite copy-assets [destination]
 *
 * This copies pglite.wasm and pglite.data to your project so Wrangler can
 * use them as static imports with the CompiledWasm rule.
 */

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, '..', 'dist')

async function main() {
  const destArg = process.argv[2] || './pglite-assets'
  const destDir = path.resolve(process.cwd(), destArg)

  console.log(`Copying PGLite assets to ${destDir}...`)

  // Create destination directory
  await fs.mkdir(destDir, { recursive: true })

  // Copy files (WASM, data, and pre-patched JS for Workers)
  const files = ['pglite.wasm', 'pglite.data', 'pglite.js']
  for (const file of files) {
    const src = path.join(distDir, file)
    const dest = path.join(destDir, file)
    await fs.copyFile(src, dest)
    const stat = await fs.stat(dest)
    console.log(`  ${file} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  }

  console.log(`
Done! Add these to your wrangler.toml:

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]

[[rules]]
type = "Data"
globs = ["**/*.data"]

Then import in your worker:

import pgliteWasm from './${path.relative(process.cwd(), destDir)}/pglite.wasm'
import pgliteData from './${path.relative(process.cwd(), destDir)}/pglite.data'

const pg = await PGlite.create({
  wasmModule: pgliteWasm,
  fsBundle: new Blob([pgliteData]),
})
`)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
