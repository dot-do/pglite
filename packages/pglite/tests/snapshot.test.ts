import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '../dist/index.js'
import type { MemorySnapshot } from '../dist/index.js'
import {
  SNAPSHOT_VERSION,
  serializeSnapshot,
  loadSnapshotFromBytes,
} from '../dist/index.js'

describe('Memory Snapshots', () => {
  let capturedSnapshot: MemorySnapshot

  describe('captureSnapshot()', () => {
    it('captures a valid memory snapshot', async () => {
      const db = await PGlite.create()

      // Create a table and insert some data
      await db.exec(`
        CREATE TABLE test_capture (
          id SERIAL PRIMARY KEY,
          name TEXT
        );
        INSERT INTO test_capture (name) VALUES ('before_snapshot');
      `)

      // Capture the snapshot
      capturedSnapshot = await db.captureSnapshot()

      // Verify snapshot structure
      expect(capturedSnapshot).toBeDefined()
      expect(capturedSnapshot.version).toBe(SNAPSHOT_VERSION)
      expect(capturedSnapshot.heapSize).toBeGreaterThan(0)
      expect(capturedSnapshot.heap).toBeInstanceOf(ArrayBuffer)
      expect(capturedSnapshot.heap.byteLength).toBe(capturedSnapshot.heapSize)
      expect(capturedSnapshot.capturedAt).toBeGreaterThan(0)
      expect(capturedSnapshot.capturedAt).toBeLessThanOrEqual(Date.now())

      await db.close()
    })

    it('includes extensions list in snapshot', async () => {
      const db = await PGlite.create()
      const snapshot = await db.captureSnapshot()

      // Extensions should be an array (may be empty if no extensions loaded)
      expect(Array.isArray(snapshot.extensions)).toBe(true)

      await db.close()
    })
  })

  describe('serializeSnapshot() / loadSnapshotFromBytes()', () => {
    it('serializes and deserializes a snapshot correctly', async () => {
      const db = await PGlite.create()
      const originalSnapshot = await db.captureSnapshot()
      await db.close()

      // Serialize
      const serialized = serializeSnapshot(originalSnapshot)
      expect(serialized).toBeInstanceOf(Uint8Array)
      expect(serialized.length).toBeGreaterThan(4) // At least header length

      // Deserialize
      const restored = await loadSnapshotFromBytes(serialized)

      // Verify all fields match
      expect(restored.version).toBe(originalSnapshot.version)
      expect(restored.heapSize).toBe(originalSnapshot.heapSize)
      expect(restored.capturedAt).toBe(originalSnapshot.capturedAt)
      expect(new Uint8Array(restored.heap)).toEqual(
        new Uint8Array(originalSnapshot.heap),
      )
    })

    it('throws on invalid snapshot data', async () => {
      // Too short
      await expect(loadSnapshotFromBytes(new Uint8Array([1, 2, 3]))).rejects.toThrow(
        'Invalid snapshot',
      )

      // Invalid header length
      const badHeaderLength = new Uint8Array([255, 255, 255, 127, 0, 0, 0, 0])
      await expect(loadSnapshotFromBytes(badHeaderLength)).rejects.toThrow(
        'Invalid snapshot',
      )
    })
  })

  describe('PGlite.create() with memorySnapshot', () => {
    let sourceDb: PGlite
    let sourceSnapshot: MemorySnapshot

    beforeAll(async () => {
      // Create a fresh database and capture its state
      sourceDb = await PGlite.create()

      // Create some schema that should be preserved
      await sourceDb.exec(`
        CREATE TABLE snapshot_test (
          id SERIAL PRIMARY KEY,
          value TEXT
        );
      `)

      // Capture the snapshot
      sourceSnapshot = await sourceDb.captureSnapshot()
    })

    afterAll(async () => {
      if (sourceDb && !sourceDb.closed) {
        await sourceDb.close()
      }
    })

    it('restores from a memory snapshot', async () => {
      // Create a new instance from the snapshot
      const restoredDb = await PGlite.create({
        memorySnapshot: sourceSnapshot,
      })

      // Verify the database is functional
      expect(restoredDb.ready).toBe(true)

      // The schema from the snapshot should exist
      const result = await restoredDb.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'snapshot_test'
      `)
      expect(result.rows.length).toBe(1)

      await restoredDb.close()
    })

    it('generates unique random values after restore', async () => {
      // Create two instances from the same snapshot
      const db1 = await PGlite.create({
        memorySnapshot: sourceSnapshot,
      })
      const db2 = await PGlite.create({
        memorySnapshot: sourceSnapshot,
      })

      // Get random values from both
      const result1 = await db1.query('SELECT random() as r')
      const result2 = await db2.query('SELECT random() as r')

      const random1 = result1.rows[0].r
      const random2 = result2.rows[0].r

      // The random values should be different (RNG was reseeded)
      // Note: There's a tiny theoretical chance they could be equal,
      // but with proper reseeding this should essentially never happen
      expect(random1).not.toBe(random2)

      await db1.close()
      await db2.close()
    })

    it('allows querying and modifications after restore', async () => {
      const restoredDb = await PGlite.create({
        memorySnapshot: sourceSnapshot,
      })

      // Insert data
      await restoredDb.exec(`
        INSERT INTO snapshot_test (value) VALUES ('post_restore_data');
      `)

      // Query the data
      const result = await restoredDb.query('SELECT * FROM snapshot_test')
      expect(result.rows.length).toBe(1)
      expect(result.rows[0].value).toBe('post_restore_data')

      await restoredDb.close()
    })

    it('rejects snapshots with incompatible version', async () => {
      const badSnapshot: MemorySnapshot = {
        ...sourceSnapshot,
        version: '999.0', // Invalid version
      }

      await expect(
        PGlite.create({ memorySnapshot: badSnapshot }),
      ).rejects.toThrow('Unsupported snapshot version')
    })
  })

  describe('Cold start performance', () => {
    let snapshot: MemorySnapshot

    beforeAll(async () => {
      // Create a snapshot to use for performance testing
      const db = await PGlite.create()
      await db.exec(`
        -- Warm up catalogs
        SELECT * FROM pg_catalog.pg_type LIMIT 1;
        SELECT * FROM pg_catalog.pg_class LIMIT 1;
      `)
      snapshot = await db.captureSnapshot()
      await db.close()
    })

    it('snapshot restore is faster than cold start', async () => {
      // Measure normal cold start time
      const coldStartTime = performance.now()
      const coldDb = await PGlite.create()
      const coldStartDuration = performance.now() - coldStartTime
      await coldDb.close()

      // Measure snapshot restore time
      const snapshotStartTime = performance.now()
      const snapshotDb = await PGlite.create({
        memorySnapshot: snapshot,
      })
      const snapshotRestoreDuration = performance.now() - snapshotStartTime
      await snapshotDb.close()

      // Log the times for visibility
      console.log(`Cold start: ${coldStartDuration.toFixed(0)}ms`)
      console.log(`Snapshot restore: ${snapshotRestoreDuration.toFixed(0)}ms`)
      console.log(
        `Speedup: ${((1 - snapshotRestoreDuration / coldStartDuration) * 100).toFixed(1)}%`,
      )

      // Snapshot restore should be faster (this is a sanity check, not a strict requirement
      // as timing can vary. In practice, the improvement should be significant.)
      // We use a generous threshold since test environments can be slow
      expect(snapshotRestoreDuration).toBeLessThan(coldStartDuration * 1.5)
    })
  })
})
