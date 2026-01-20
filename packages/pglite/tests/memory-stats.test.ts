import { describe, it, expect } from 'vitest'
import { testEsmCjsAndDTC } from './test-utils.ts'

await testEsmCjsAndDTC(async (importType) => {
  const { PGlite } =
    importType === 'esm'
      ? await import('../dist/index.js')
      : ((await import(
          '../dist/index.cjs'
        )) as unknown as typeof import('../dist/index.js'))

  describe(`memory-stats`, () => {
    it('getMemoryStats returns valid stats', async () => {
      const db = await PGlite.create()

      const stats = await db.getMemoryStats()

      // Check that heapSize is a positive number
      expect(typeof stats.heapSize).toBe('number')
      expect(stats.heapSize).toBeGreaterThan(0)

      // Check that peakHeapSize is tracked and at least as large as heapSize
      expect(typeof stats.peakHeapSize).toBe('number')
      expect(stats.peakHeapSize).toBeGreaterThanOrEqual(stats.heapSize)

      // Check that PostgreSQL settings are returned
      expect(stats.postgresSettings).toBeDefined()
      expect(typeof stats.postgresSettings.sharedBuffers).toBe('string')
      expect(typeof stats.postgresSettings.workMem).toBe('string')
      expect(typeof stats.postgresSettings.tempBuffers).toBe('string')
      expect(typeof stats.postgresSettings.walBuffers).toBe('string')
      expect(typeof stats.postgresSettings.maintenanceWorkMem).toBe('string')

      // Settings should end with MB or kB
      const validSuffixRegex = /(MB|kB|unknown)$/
      expect(stats.postgresSettings.sharedBuffers).toMatch(validSuffixRegex)
      expect(stats.postgresSettings.workMem).toMatch(validSuffixRegex)
      expect(stats.postgresSettings.tempBuffers).toMatch(validSuffixRegex)
      expect(stats.postgresSettings.walBuffers).toMatch(validSuffixRegex)
      expect(stats.postgresSettings.maintenanceWorkMem).toMatch(validSuffixRegex)

      await db.close()
    })

    it('getMemoryStats returns reasonable heap size', async () => {
      const db = await PGlite.create()

      const stats = await db.getMemoryStats()

      // Heap size should be at least 1MB (WASM minimum is typically larger)
      expect(stats.heapSize).toBeGreaterThan(1024 * 1024)

      // Heap size should be less than 1GB (reasonable upper bound)
      expect(stats.heapSize).toBeLessThan(1024 * 1024 * 1024)

      await db.close()
    })

    it('peakHeapSize tracks memory growth', async () => {
      const db = await PGlite.create()

      // Get initial stats
      const initialStats = await db.getMemoryStats()
      const initialPeak = initialStats.peakHeapSize

      // Create a table and insert some data to potentially trigger memory growth
      await db.exec(`
        CREATE TABLE test_memory (
          id SERIAL PRIMARY KEY,
          data TEXT
        );
      `)

      // Insert some data
      for (let i = 0; i < 100; i++) {
        await db.query('INSERT INTO test_memory (data) VALUES ($1)', [
          'x'.repeat(1000),
        ])
      }

      // Get stats after operations
      const afterStats = await db.getMemoryStats()

      // Peak should still be tracked correctly
      expect(afterStats.peakHeapSize).toBeGreaterThanOrEqual(initialPeak)
      expect(afterStats.peakHeapSize).toBeGreaterThanOrEqual(
        afterStats.heapSize,
      )

      await db.close()
    })

    it('throws error when database is closed', async () => {
      const db = await PGlite.create()
      await db.close()

      await expect(db.getMemoryStats()).rejects.toThrow('PGlite is closed')
    })
  })
})
