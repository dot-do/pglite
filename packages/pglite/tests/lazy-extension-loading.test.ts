/**
 * RED PHASE TESTS: Lazy Extension Loading
 *
 * These tests define the expected behavior for on-demand extension loading.
 * Currently, all extensions are loaded eagerly at PGlite initialization time,
 * consuming memory even if the extension is never used.
 *
 * The proposed lazy loading feature should:
 * 1. Defer extension bundle loading until the extension is first used
 * 2. Provide memory savings by only loading needed extensions
 * 3. Support explicit loading via a new API
 * 4. Handle missing extensions gracefully
 * 5. Resolve extension dependencies automatically
 *
 * Issue: postgres-pq33
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterface,
} from '../src/interface'

// Mock extension for testing - simulates a real extension with tracking
function createMockExtension(name: string, _bundleSize: number = 1000): Extension & { loadCount: number; isLoaded: () => boolean } {
  let loadCount = 0
  let loaded = false

  return {
    name,
    loadCount: 0,
    isLoaded: () => loaded,
    setup: async (_pg: PGliteInterface, _emscriptenOpts: any): Promise<ExtensionSetupResult> => {
      loadCount++
      loaded = true
      // In real implementation, this would return bundlePath for lazy loading
      // Using a mock URL here - the actual bundle resolution is tested elsewhere
      return {
        bundlePath: new URL(`file:///mock/release/${name}.tar.gz`),
      }
    },
    get loadCount() {
      return loadCount
    },
  }
}

describe('Lazy Extension Loading', () => {
  /**
   * Test 1: Extensions should load only when first used
   *
   * Currently, extensions are loaded during PGlite initialization.
   * With lazy loading, the extension bundle should only be fetched
   * when CREATE EXTENSION is called or when extension functions are used.
   */
  describe('deferred loading behavior', () => {
    it.fails('should not load extension bundle at initialization time', async () => {
      // This test expects a future API where extensions can be configured
      // for lazy loading and their bundles are not fetched until needed

      const { PGlite } = await import('../dist/index.js')

      // Create a mock extension that tracks when it's loaded
      const mockVector = createMockExtension('vector', 45000) // ~45KB

      // Configure PGlite with lazy loading enabled for this extension
      const pg = await PGlite.create({
        extensions: {
          vector: mockVector,
        },
        // Future API: lazyExtensions option to defer loading
        lazyExtensions: true,
      } as any)

      // At this point, the extension bundle should NOT have been fetched
      // because we haven't used any vector functionality yet
      expect(mockVector.isLoaded()).toBe(false)

      // Extension should only load when CREATE EXTENSION is called
      await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')

      // Now the extension should be loaded
      expect(mockVector.isLoaded()).toBe(true)
      expect(mockVector.loadCount).toBe(1)

      await pg.close()
    })

    it.fails('should load extension only once even with multiple uses', async () => {
      const { PGlite } = await import('../dist/index.js')

      const mockVector = createMockExtension('vector')

      const pg = await PGlite.create({
        extensions: {
          vector: mockVector,
        },
        lazyExtensions: true,
      } as any)

      // First use - should trigger load
      await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')
      expect(mockVector.loadCount).toBe(1)

      // Create a table using vector type
      await pg.exec('CREATE TABLE test_vec (id SERIAL, embedding vector(3));')
      expect(mockVector.loadCount).toBe(1) // Should still be 1

      // Insert data
      await pg.exec("INSERT INTO test_vec (embedding) VALUES ('[1,2,3]');")
      expect(mockVector.loadCount).toBe(1) // Should still be 1

      await pg.close()
    })

    it.fails('should support auto-loading when extension functions are detected', async () => {
      const { PGlite } = await import('../dist/index.js')

      const mockVector = createMockExtension('vector')

      const pg = await PGlite.create({
        extensions: {
          vector: mockVector,
        },
        lazyExtensions: true,
        // Future API: auto-detect and load extensions based on SQL
        autoLoadExtensions: true,
      } as any)

      expect(mockVector.isLoaded()).toBe(false)

      // Using vector operators should auto-load the extension
      // This would require SQL parsing to detect extension-specific syntax
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS items (embedding vector(3));
        INSERT INTO items VALUES ('[1,2,3]');
      `)

      expect(mockVector.isLoaded()).toBe(true)

      await pg.close()
    })
  })

  /**
   * Test 2: Memory savings from deferred loading
   *
   * Each extension adds to the WASM memory footprint.
   * Lazy loading should allow starting with minimal memory
   * and only growing when extensions are actually needed.
   */
  describe('memory optimization', () => {
    it.fails('should report lower initial memory without loaded extensions', async () => {
      const { PGlite } = await import('../dist/index.js')

      // Create instance WITHOUT any extensions
      const pgBase = await PGlite.create()
      const baseMemory = await pgBase.getMemoryStats()

      // Create instance WITH extensions but lazy loading enabled
      const pgLazy = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector', 45000),
          pgcrypto: createMockExtension('pgcrypto', 1100000),
        },
        lazyExtensions: true,
      } as any)
      const lazyMemory = await pgLazy.getMemoryStats()

      // Create instance WITH extensions eagerly loaded (current behavior)
      const pgEager = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector', 45000),
          pgcrypto: createMockExtension('pgcrypto', 1100000),
        },
      })
      const eagerMemory = await pgEager.getMemoryStats()

      // Lazy loading should have similar memory to base (no extensions loaded yet)
      expect(lazyMemory.heapSize).toBeLessThan(eagerMemory.heapSize)

      // The difference should be approximately the size of the extension bundles
      const memorySaved = eagerMemory.heapSize - lazyMemory.heapSize
      expect(memorySaved).toBeGreaterThan(1000000) // At least 1MB saved

      await pgBase.close()
      await pgLazy.close()
      await pgEager.close()
    })

    it.fails('should track memory increase when extension is loaded', async () => {
      const { PGlite } = await import('../dist/index.js')

      const pg = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector', 45000),
        },
        lazyExtensions: true,
      } as any)

      const memoryBefore = await pg.getMemoryStats()

      // Load the extension
      await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')

      const memoryAfter = await pg.getMemoryStats()

      // Memory should have increased after loading extension
      expect(memoryAfter.heapSize).toBeGreaterThan(memoryBefore.heapSize)

      await pg.close()
    })

    it.fails('should provide extension memory breakdown via API', async () => {
      const { PGlite } = await import('../dist/index.js')

      const pg = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector', 45000),
          pgcrypto: createMockExtension('pgcrypto', 1100000),
        },
      })

      // Future API: getExtensionMemoryStats()
      const extMemory = await (pg as any).getExtensionMemoryStats()

      expect(extMemory).toHaveProperty('vector')
      expect(extMemory).toHaveProperty('pgcrypto')
      expect(extMemory.vector.bundleSize).toBeGreaterThan(0)
      expect(extMemory.pgcrypto.bundleSize).toBeGreaterThan(0)
      expect(extMemory.vector.loaded).toBe(true)

      await pg.close()
    })
  })

  /**
   * Test 3: Extension initialization API
   *
   * Provide explicit methods to pre-load extensions when needed,
   * without waiting for SQL to trigger loading.
   */
  describe('explicit loading API', () => {
    it.fails('should support explicit loadExtension() method', async () => {
      const { PGlite } = await import('../dist/index.js')

      const mockVector = createMockExtension('vector')

      const pg = await PGlite.create({
        extensions: {
          vector: mockVector,
        },
        lazyExtensions: true,
      } as any)

      expect(mockVector.isLoaded()).toBe(false)

      // Future API: explicit loadExtension method
      await (pg as any).loadExtension('vector')

      expect(mockVector.isLoaded()).toBe(true)

      await pg.close()
    })

    it.fails('should support preloading multiple extensions at once', async () => {
      const { PGlite } = await import('../dist/index.js')

      const mockVector = createMockExtension('vector')
      const mockPgcrypto = createMockExtension('pgcrypto')

      const pg = await PGlite.create({
        extensions: {
          vector: mockVector,
          pgcrypto: mockPgcrypto,
        },
        lazyExtensions: true,
      } as any)

      expect(mockVector.isLoaded()).toBe(false)
      expect(mockPgcrypto.isLoaded()).toBe(false)

      // Future API: preload multiple extensions in parallel
      await (pg as any).loadExtensions(['vector', 'pgcrypto'])

      expect(mockVector.isLoaded()).toBe(true)
      expect(mockPgcrypto.isLoaded()).toBe(true)

      await pg.close()
    })

    it.fails('should support checking extension load status', async () => {
      const { PGlite } = await import('../dist/index.js')

      const pg = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector'),
          pgcrypto: createMockExtension('pgcrypto'),
        },
        lazyExtensions: true,
      } as any)

      // Future API: check extension status
      const status = await (pg as any).getExtensionStatus()

      expect(status).toEqual({
        vector: { configured: true, loaded: false },
        pgcrypto: { configured: true, loaded: false },
      })

      await (pg as any).loadExtension('vector')

      const statusAfter = await (pg as any).getExtensionStatus()
      expect(statusAfter.vector.loaded).toBe(true)
      expect(statusAfter.pgcrypto.loaded).toBe(false)

      await pg.close()
    })

    it.fails('should emit events when extensions are loaded', async () => {
      const { PGlite } = await import('../dist/index.js')

      const pg = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector'),
        },
        lazyExtensions: true,
      } as any)

      const loadedExtensions: string[] = []

      // Future API: extension load event
      ;(pg as any).onExtensionLoad((extName: string) => {
        loadedExtensions.push(extName)
      })

      await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')

      expect(loadedExtensions).toContain('vector')

      await pg.close()
    })
  })

  /**
   * Test 4: Error handling for missing extensions
   *
   * When an extension is requested but not configured or not available,
   * provide clear and helpful error messages.
   */
  describe('error handling', () => {
    it('should throw clear error when loading unconfigured extension', async () => {
      const { PGlite } = await import('../dist/index.js')

      const pg = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector'),
        },
        lazyExtensions: true,
      } as any)

      // Try to load an extension that wasn't configured
      await expect((pg as any).loadExtension('postgis')).rejects.toThrow(
        /Extension 'postgis' is not configured/
      )

      await pg.close()
    })

    it('should provide helpful error when extension bundle fetch fails', async () => {
      const { PGlite } = await import('../dist/index.js')

      // Create extension with invalid bundle path
      const brokenExtension: Extension = {
        name: 'broken',
        setup: async () => ({
          bundlePath: new URL('file:///nonexistent/broken.tar.gz'),
        }),
      }

      const pg = await PGlite.create({
        extensions: {
          broken: brokenExtension,
        },
        lazyExtensions: true,
      } as any)

      // Should throw with helpful error message including extension name
      await expect((pg as any).loadExtension('broken')).rejects.toThrow(
        /Failed to load extension 'broken'/
      )

      await pg.close()
    })

    it.fails('should handle CREATE EXTENSION error gracefully when extension not configured', async () => {
      const { PGlite } = await import('../dist/index.js')

      const pg = await PGlite.create({
        lazyExtensions: true,
      } as any)

      // Without the extension configured, CREATE EXTENSION should fail
      // with a helpful error explaining the extension needs to be configured
      await expect(
        pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')
      ).rejects.toThrow(/extension.*not available.*configure/)

      await pg.close()
    })

    it('should support graceful degradation with isExtensionAvailable()', async () => {
      const { PGlite } = await import('../dist/index.js')

      const pg = await PGlite.create({
        extensions: {
          vector: createMockExtension('vector'),
        },
        lazyExtensions: true,
      } as any)

      // Future API: check if extension is available before using
      expect(await (pg as any).isExtensionAvailable('vector')).toBe(true)
      expect(await (pg as any).isExtensionAvailable('postgis')).toBe(false)

      await pg.close()
    })
  })

  /**
   * Test 5: Extension dependency resolution
   *
   * Some PostgreSQL extensions depend on other extensions.
   * For example, earthdistance depends on cube.
   * Lazy loading should handle these dependencies correctly.
   */
  describe('dependency resolution', () => {
    it.fails('should automatically load dependencies when loading an extension', async () => {
      const { PGlite } = await import('../dist/index.js')

      const mockCube = createMockExtension('cube')
      const mockEarthdistance = createMockExtension('earthdistance')

      // Configure earthdistance with its dependency on cube
      const earthdistanceWithDeps: Extension = {
        name: 'earthdistance',
        setup: async (pg, opts) => {
          const result = await mockEarthdistance.setup(pg, opts)
          return {
            ...result,
            // Future API: declare dependencies
            dependencies: ['cube'],
          } as any
        },
      }

      const pg = await PGlite.create({
        extensions: {
          cube: mockCube,
          earthdistance: earthdistanceWithDeps,
        },
        lazyExtensions: true,
      } as any)

      expect(mockCube.isLoaded()).toBe(false)
      expect(mockEarthdistance.isLoaded()).toBe(false)

      // Loading earthdistance should automatically load cube first
      await (pg as any).loadExtension('earthdistance')

      expect(mockCube.isLoaded()).toBe(true)
      expect(mockEarthdistance.isLoaded()).toBe(true)

      await pg.close()
    })

    it('should throw error if dependency is not configured', async () => {
      const { PGlite } = await import('../dist/index.js')

      const earthdistanceWithDeps: Extension = {
        name: 'earthdistance',
        setup: async () => ({
          bundlePath: new URL('file:///mock/release/earthdistance.tar.gz'),
          dependencies: ['cube'], // cube is not configured
        } as any),
      }

      const pg = await PGlite.create({
        extensions: {
          earthdistance: earthdistanceWithDeps,
          // Note: cube is NOT configured
        },
        lazyExtensions: true,
      } as any)

      // Should fail with error about missing dependency
      await expect((pg as any).loadExtension('earthdistance')).rejects.toThrow(
        /Extension 'earthdistance' requires dependency 'cube' which is not configured/
      )

      await pg.close()
    })

    it('should handle circular dependency detection', async () => {
      const { PGlite } = await import('../dist/index.js')

      // Create extensions with circular dependency (shouldn't happen in practice,
      // but we should handle it gracefully)
      const extA: Extension = {
        name: 'ext_a',
        setup: async () => ({
          bundlePath: new URL('file:///mock/release/ext_a.tar.gz'),
          dependencies: ['ext_b'],
        } as any),
      }

      const extB: Extension = {
        name: 'ext_b',
        setup: async () => ({
          bundlePath: new URL('file:///mock/release/ext_b.tar.gz'),
          dependencies: ['ext_a'],
        } as any),
      }

      const pg = await PGlite.create({
        extensions: {
          ext_a: extA,
          ext_b: extB,
        },
        lazyExtensions: true,
      } as any)

      // Should detect circular dependency and throw helpful error
      await expect((pg as any).loadExtension('ext_a')).rejects.toThrow(
        /Circular dependency detected.*ext_a.*ext_b/
      )

      await pg.close()
    })

    it.fails('should load dependencies in correct order', async () => {
      const { PGlite } = await import('../dist/index.js')

      const loadOrder: string[] = []

      const createTrackedExtension = (name: string, deps: string[] = []): Extension => ({
        name,
        setup: async () => {
          loadOrder.push(name)
          return {
            bundlePath: new URL(`file:///mock/release/${name}.tar.gz`),
            dependencies: deps,
          } as any
        },
      })

      // Create a chain: ext_c depends on ext_b, which depends on ext_a
      const pg = await PGlite.create({
        extensions: {
          ext_a: createTrackedExtension('ext_a'),
          ext_b: createTrackedExtension('ext_b', ['ext_a']),
          ext_c: createTrackedExtension('ext_c', ['ext_b']),
        },
        lazyExtensions: true,
      } as any)

      // Loading ext_c should load in order: ext_a, ext_b, ext_c
      await (pg as any).loadExtension('ext_c')

      expect(loadOrder).toEqual(['ext_a', 'ext_b', 'ext_c'])

      await pg.close()
    })

    it.fails('should not reload already loaded dependencies', async () => {
      const { PGlite } = await import('../dist/index.js')

      const mockCube = createMockExtension('cube')
      const mockEarthdistance = createMockExtension('earthdistance')

      const earthdistanceWithDeps: Extension = {
        name: 'earthdistance',
        setup: async (pg, opts) => {
          const result = await mockEarthdistance.setup(pg, opts)
          return {
            ...result,
            dependencies: ['cube'],
          } as any
        },
      }

      const pg = await PGlite.create({
        extensions: {
          cube: mockCube,
          earthdistance: earthdistanceWithDeps,
        },
        lazyExtensions: true,
      } as any)

      // Load cube explicitly first
      await (pg as any).loadExtension('cube')
      expect(mockCube.loadCount).toBe(1)

      // Now load earthdistance - should NOT reload cube
      await (pg as any).loadExtension('earthdistance')
      expect(mockCube.loadCount).toBe(1) // Still 1, not reloaded

      await pg.close()
    })
  })

  /**
   * Additional integration tests for edge cases
   */
  describe('integration scenarios', () => {
    it.fails('should work with extension persistence across restarts', async () => {
      const { PGlite } = await import('../dist/index.js')

      const dataDir = './test-lazy-ext-persist'

      // First session: create with lazy loading, use vector
      let pg = await PGlite.create({
        dataDir,
        extensions: {
          vector: createMockExtension('vector'),
        },
        lazyExtensions: true,
      } as any)

      await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')
      await pg.exec('CREATE TABLE vec_data (id SERIAL, v vector(3));')
      await pg.exec("INSERT INTO vec_data (v) VALUES ('[1,2,3]');")
      await pg.close()

      // Second session: extension should be remembered and auto-loaded
      // since the database has vector data
      const mockVectorRestart = createMockExtension('vector')
      pg = await PGlite.create({
        dataDir,
        extensions: {
          vector: mockVectorRestart,
        },
        lazyExtensions: true,
      } as any)

      // Query existing vector data - should work
      const result = await pg.query('SELECT * FROM vec_data;')
      expect(result.rows).toHaveLength(1)

      await pg.close()

      // Cleanup
      const fs = await import('fs')
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    it('should support conditional extension loading based on feature flags', async () => {
      const { PGlite } = await import('../dist/index.js')

      const mockVector = createMockExtension('vector')

      const pg = await PGlite.create({
        extensions: {
          vector: mockVector,
        },
        lazyExtensions: true,
        // Future API: feature flags to control extension availability
        extensionFlags: {
          vector: process.env.ENABLE_VECTOR === 'true',
        },
      } as any)

      // If feature flag is off, extension should not be available
      const available = await (pg as any).isExtensionAvailable('vector')
      expect(available).toBe(process.env.ENABLE_VECTOR === 'true')

      await pg.close()
    })
  })
})
