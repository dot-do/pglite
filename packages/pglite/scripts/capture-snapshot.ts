/**
 * Snapshot Capture Script
 *
 * This script captures a pre-initialized memory snapshot of PGlite for fast cold starts.
 * The snapshot includes a fully initialized PostgreSQL database with common system
 * catalogs warmed and ready for immediate use.
 *
 * Usage:
 *   npx tsx scripts/capture-snapshot.ts [output-path]
 *
 * Output:
 *   Creates a .snapshot file containing the serialized MemorySnapshot
 *
 * Security Notes:
 * - NEVER include user data in snapshots
 * - Snapshots should only be created from fresh instances
 * - RNG is automatically reseeded on restore (handled by PGlite)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { PGlite } from '../src/pglite.js'
import type { MemorySnapshot } from '../src/interface.js'

// Default output path
const DEFAULT_OUTPUT = './dist/pglite.snapshot'

/**
 * Compress a snapshot using gzip-compatible compression
 */
async function compressSnapshot(data: Uint8Array): Promise<Uint8Array> {
  // Use CompressionStream API if available (Node 18+)
  if (typeof CompressionStream !== 'undefined') {
    const stream = new CompressionStream('gzip')
    const writer = stream.writable.getWriter()
    writer.write(data)
    writer.close()

    const chunks: Uint8Array[] = []
    const reader = stream.readable.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }

  // Fallback: return uncompressed
  console.warn(
    'Warning: CompressionStream not available, snapshot will not be compressed',
  )
  return data
}

/**
 * Serialize a MemorySnapshot to bytes for storage
 */
function serializeSnapshot(snapshot: MemorySnapshot): Uint8Array {
  // Create a header with metadata
  const header = {
    version: snapshot.version,
    heapSize: snapshot.heapSize,
    capturedAt: snapshot.capturedAt,
    pgVersion: snapshot.pgVersion,
    extensions: snapshot.extensions,
  }

  const headerJson = JSON.stringify(header)
  const headerBytes = new TextEncoder().encode(headerJson)

  // Format: [4 bytes header length][header JSON][heap data]
  const headerLength = new Uint32Array([headerBytes.length])
  const heapData = new Uint8Array(snapshot.heap)

  const result = new Uint8Array(
    4 + headerBytes.length + heapData.length,
  )
  result.set(new Uint8Array(headerLength.buffer), 0)
  result.set(headerBytes, 4)
  result.set(heapData, 4 + headerBytes.length)

  return result
}

/**
 * Main snapshot capture function
 */
async function captureSnapshot(outputPath: string): Promise<void> {
  console.log('PGlite Snapshot Capture')
  console.log('=======================')
  console.log('')

  const startTime = performance.now()

  // Create a fresh PGlite instance
  console.log('1. Creating fresh PGlite instance...')
  const initStart = performance.now()
  const pg = await PGlite.create()
  const initTime = performance.now() - initStart
  console.log(`   Done in ${initTime.toFixed(0)}ms`)

  // Warm up the system catalogs
  console.log('2. Warming up system catalogs...')
  const warmStart = performance.now()
  await pg.exec(`
    -- Warm up common system catalogs
    SELECT * FROM pg_catalog.pg_type LIMIT 1;
    SELECT * FROM pg_catalog.pg_class LIMIT 1;
    SELECT * FROM pg_catalog.pg_attribute LIMIT 1;
    SELECT * FROM pg_catalog.pg_namespace LIMIT 1;
    SELECT * FROM pg_catalog.pg_proc LIMIT 1;

    -- Ensure pg_catalog schema is in search_path
    SET search_path TO public, pg_catalog;

    -- Run ANALYZE on system catalogs for better query planning
    ANALYZE pg_catalog.pg_type;
    ANALYZE pg_catalog.pg_class;
  `)
  const warmTime = performance.now() - warmStart
  console.log(`   Done in ${warmTime.toFixed(0)}ms`)

  // Capture the snapshot
  console.log('3. Capturing memory snapshot...')
  const captureStart = performance.now()
  const snapshot = await pg.captureSnapshot()
  const captureTime = performance.now() - captureStart
  console.log(`   Done in ${captureTime.toFixed(0)}ms`)
  console.log(
    `   Heap size: ${(snapshot.heapSize / 1024 / 1024).toFixed(2)} MB`,
  )

  // Serialize the snapshot
  console.log('4. Serializing snapshot...')
  const serializeStart = performance.now()
  const serialized = serializeSnapshot(snapshot)
  const serializeTime = performance.now() - serializeStart
  console.log(`   Done in ${serializeTime.toFixed(0)}ms`)
  console.log(
    `   Serialized size: ${(serialized.length / 1024 / 1024).toFixed(2)} MB`,
  )

  // Compress the snapshot
  console.log('5. Compressing snapshot...')
  const compressStart = performance.now()
  const compressed = await compressSnapshot(serialized)
  const compressTime = performance.now() - compressStart
  console.log(`   Done in ${compressTime.toFixed(0)}ms`)
  console.log(
    `   Compressed size: ${(compressed.length / 1024 / 1024).toFixed(2)} MB`,
  )
  console.log(
    `   Compression ratio: ${((1 - compressed.length / serialized.length) * 100).toFixed(1)}%`,
  )

  // Write to file
  console.log(`6. Writing to ${outputPath}...`)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, compressed)
  console.log('   Done!')

  // Close the instance
  await pg.close()

  const totalTime = performance.now() - startTime
  console.log('')
  console.log('Summary')
  console.log('-------')
  console.log(`Total time: ${totalTime.toFixed(0)}ms`)
  console.log(`Output: ${outputPath}`)
  console.log(`Size: ${(compressed.length / 1024 / 1024).toFixed(2)} MB`)
  console.log('')
  console.log('The snapshot can be used with PGlite.create({ memorySnapshot: ... })')
  console.log('to achieve ~70-85% faster cold starts.')
}

// Run the script
const outputPath = process.argv[2] || DEFAULT_OUTPUT
captureSnapshot(outputPath).catch((err) => {
  console.error('Error capturing snapshot:', err)
  process.exit(1)
})
