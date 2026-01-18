/**
 * Snapshot Loading Utilities
 *
 * Utilities for loading pre-captured memory snapshots for fast PGlite cold starts.
 */

import type { MemorySnapshot } from '../src/interface.js'

/**
 * Decompress a gzip-compressed snapshot
 */
async function decompressSnapshot(data: Uint8Array): Promise<Uint8Array> {
  // Use DecompressionStream API if available (Node 18+)
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new DecompressionStream('gzip')
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

  // Fallback: assume uncompressed
  return data
}

/**
 * Deserialize a MemorySnapshot from bytes
 */
function deserializeSnapshot(data: Uint8Array): MemorySnapshot {
  // Format: [4 bytes header length][header JSON][heap data]
  const headerLength = new Uint32Array(data.buffer.slice(0, 4))[0]
  const headerBytes = data.slice(4, 4 + headerLength)
  const headerJson = new TextDecoder().decode(headerBytes)
  const header = JSON.parse(headerJson)

  const heapData = data.slice(4 + headerLength)

  return {
    version: header.version,
    heapSize: header.heapSize,
    heap: heapData.buffer.slice(
      heapData.byteOffset,
      heapData.byteOffset + heapData.byteLength,
    ),
    capturedAt: header.capturedAt,
    pgVersion: header.pgVersion,
    extensions: header.extensions,
  }
}

/**
 * Load a MemorySnapshot from a file path (Node.js)
 */
export async function loadSnapshotFromFile(
  filePath: string,
): Promise<MemorySnapshot> {
  const fs = await import('fs/promises')
  const data = await fs.readFile(filePath)
  const decompressed = await decompressSnapshot(new Uint8Array(data))
  return deserializeSnapshot(decompressed)
}

/**
 * Load a MemorySnapshot from a URL (Browser/Workers)
 */
export async function loadSnapshotFromUrl(
  url: string,
): Promise<MemorySnapshot> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load snapshot from ${url}: ${response.status}`)
  }
  const data = await response.arrayBuffer()
  const decompressed = await decompressSnapshot(new Uint8Array(data))
  return deserializeSnapshot(decompressed)
}

/**
 * Load a MemorySnapshot from a Blob
 */
export async function loadSnapshotFromBlob(
  blob: Blob,
): Promise<MemorySnapshot> {
  const data = await blob.arrayBuffer()
  const decompressed = await decompressSnapshot(new Uint8Array(data))
  return deserializeSnapshot(decompressed)
}

/**
 * Load a MemorySnapshot from raw compressed bytes
 */
export async function loadSnapshotFromBytes(
  data: Uint8Array,
): Promise<MemorySnapshot> {
  const decompressed = await decompressSnapshot(data)
  return deserializeSnapshot(decompressed)
}
