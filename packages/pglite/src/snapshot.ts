/**
 * Memory Snapshot Utilities
 *
 * Utilities for loading and managing pre-captured memory snapshots
 * for fast PGlite cold starts.
 *
 * @module snapshot
 */

import type { MemorySnapshot } from './interface.js'

/**
 * Current snapshot format version
 */
export const SNAPSHOT_VERSION = '1.0'

/**
 * Decompress a gzip-compressed snapshot
 */
async function decompressSnapshot(data: Uint8Array): Promise<Uint8Array> {
  // Check for gzip magic bytes
  if (data[0] !== 0x1f || data[1] !== 0x8b) {
    // Not gzip compressed, return as-is
    return data
  }

  // Use DecompressionStream API if available (Node 18+, modern browsers)
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

  throw new Error(
    'DecompressionStream not available - compressed snapshots require Node 18+ or a modern browser',
  )
}

/**
 * Deserialize a MemorySnapshot from bytes
 * Format: [4 bytes header length][header JSON][heap data]
 */
function deserializeSnapshot(data: Uint8Array): MemorySnapshot {
  if (data.length < 4) {
    throw new Error('Invalid snapshot: data too short')
  }

  // Read header length (little-endian)
  const headerLength =
    data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)

  if (headerLength < 0 || headerLength > 1024 * 1024) {
    throw new Error(`Invalid snapshot: header length ${headerLength} out of range`)
  }

  if (data.length < 4 + headerLength) {
    throw new Error('Invalid snapshot: data truncated')
  }

  const headerBytes = data.slice(4, 4 + headerLength)
  const headerJson = new TextDecoder().decode(headerBytes)

  let header: {
    version: string
    heapSize: number
    capturedAt: number
    pgVersion?: string
    extensions?: string[]
  }

  try {
    header = JSON.parse(headerJson)
  } catch (e) {
    throw new Error(`Invalid snapshot: failed to parse header JSON: ${e}`)
  }

  // Validate version
  if (header.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `Unsupported snapshot version: ${header.version}. Expected: ${SNAPSHOT_VERSION}`,
    )
  }

  const heapData = data.slice(4 + headerLength)

  // Validate heap size
  if (heapData.length !== header.heapSize) {
    throw new Error(
      `Invalid snapshot: heap size mismatch. Expected ${header.heapSize}, got ${heapData.length}`,
    )
  }

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
 * Serialize a MemorySnapshot to bytes for storage
 * Format: [4 bytes header length][header JSON][heap data]
 */
export function serializeSnapshot(snapshot: MemorySnapshot): Uint8Array {
  // Create a header with metadata (excluding the heap)
  const header = {
    version: snapshot.version,
    heapSize: snapshot.heapSize,
    capturedAt: snapshot.capturedAt,
    pgVersion: snapshot.pgVersion,
    extensions: snapshot.extensions,
  }

  const headerJson = JSON.stringify(header)
  const headerBytes = new TextEncoder().encode(headerJson)

  const heapData = new Uint8Array(snapshot.heap)

  // Allocate result buffer
  const result = new Uint8Array(4 + headerBytes.length + heapData.length)

  // Write header length (little-endian)
  result[0] = headerBytes.length & 0xff
  result[1] = (headerBytes.length >> 8) & 0xff
  result[2] = (headerBytes.length >> 16) & 0xff
  result[3] = (headerBytes.length >> 24) & 0xff

  // Write header and heap
  result.set(headerBytes, 4)
  result.set(heapData, 4 + headerBytes.length)

  return result
}

/**
 * Compress a snapshot using gzip
 */
export async function compressSnapshot(data: Uint8Array): Promise<Uint8Array> {
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

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }

  // Return uncompressed if CompressionStream not available
  return data
}

/**
 * Load a MemorySnapshot from raw bytes (compressed or uncompressed)
 *
 * @param data - Raw snapshot bytes (may be gzip compressed)
 * @returns The deserialized MemorySnapshot
 */
export async function loadSnapshotFromBytes(
  data: Uint8Array | ArrayBuffer,
): Promise<MemorySnapshot> {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
  const decompressed = await decompressSnapshot(bytes)
  return deserializeSnapshot(decompressed)
}

/**
 * Load a MemorySnapshot from a URL
 *
 * @param url - URL to fetch the snapshot from
 * @returns The deserialized MemorySnapshot
 */
export async function loadSnapshotFromUrl(url: string): Promise<MemorySnapshot> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to load snapshot from ${url}: ${response.status} ${response.statusText}`,
    )
  }
  const data = await response.arrayBuffer()
  return loadSnapshotFromBytes(data)
}

/**
 * Load a MemorySnapshot from a Blob
 *
 * @param blob - Blob containing the snapshot data
 * @returns The deserialized MemorySnapshot
 */
export async function loadSnapshotFromBlob(blob: Blob): Promise<MemorySnapshot> {
  const data = await blob.arrayBuffer()
  return loadSnapshotFromBytes(data)
}
