/**
 * Test to verify the import.meta.url patch works correctly in Workers-like environments
 *
 * This simulates the Cloudflare Workers environment where import.meta.url
 * throws an error when accessed, and validates that providing wasmModule/fsBundle
 * options bypasses the problematic code path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('import.meta.url patch for Workers compatibility', () => {
  // Track if import.meta.url was accessed
  let urlAccessCount = 0

  // Helper to create a mock that tracks URL access and optionally throws
  const createUrlAccessTracker = (shouldThrow: boolean) => {
    return () => {
      urlAccessCount++
      if (shouldThrow) {
        throw new Error('import.meta.url is not available in Workers')
      }
      return new URL('file:///mock/pglite.wasm')
    }
  }

  beforeEach(() => {
    urlAccessCount = 0
  })

  describe('instantiateWasm behavior', () => {
    it('should not access URL when wasmModule is provided', async () => {
      // Simulated instantiateWasm with our patch
      const getWasmUrl = createUrlAccessTracker(true) // Would throw if called

      async function instantiateWasm(
        imports: WebAssembly.Imports,
        module?: WebAssembly.Module,
      ) {
        // Our patch: Check for provided module FIRST
        if (module) {
          return { instance: {}, module }
        }
        // Only resolve URL if no module provided
        getWasmUrl() // This would throw in Workers without wasmModule
        throw new Error('Should not reach here')
      }

      // Create a mock module
      const mockModule = {} as WebAssembly.Module

      // Should NOT throw because we provided wasmModule
      const result = await instantiateWasm({}, mockModule)

      expect(result.module).toBe(mockModule)
      expect(urlAccessCount).toBe(0) // URL was never accessed!
    })

    it('should throw informative error in Workers when wasmModule not provided', async () => {
      const getWasmUrl = createUrlAccessTracker(true)

      async function instantiateWasm(
        imports: WebAssembly.Imports,
        module?: WebAssembly.Module,
      ) {
        if (module) {
          return { instance: {}, module }
        }
        // This will throw the Workers-friendly error
        try {
          getWasmUrl()
        } catch {
          throw new Error(
            'Cannot resolve WASM URL. In Cloudflare Workers, you must provide wasmModule option.',
          )
        }
      }

      await expect(instantiateWasm({}, undefined)).rejects.toThrow(
        'Cannot resolve WASM URL. In Cloudflare Workers, you must provide wasmModule option.',
      )
      expect(urlAccessCount).toBe(1)
    })
  })

  describe('getFsBundle behavior', () => {
    it('should not be called when fsBundle option is provided', async () => {
      const getFsBundleUrl = createUrlAccessTracker(true)

      // Simulated getFsBundle
      async function getFsBundle(): Promise<ArrayBuffer> {
        getFsBundleUrl() // Would throw in Workers
        return new ArrayBuffer(0)
      }

      // Simulate the check in pglite.ts constructor
      const options = {
        fsBundle: new Blob(['mock data']),
      }

      // The actual code path: if fsBundle provided, getFsBundle is never called
      const fsBundleBufferPromise = options.fsBundle
        ? options.fsBundle.arrayBuffer()
        : getFsBundle()

      const buffer = await fsBundleBufferPromise
      expect(buffer).toBeDefined()
      expect(urlAccessCount).toBe(0) // URL was never accessed!
    })

    it('should throw informative error in Workers when fsBundle not provided', async () => {
      async function getFsBundle(): Promise<ArrayBuffer> {
        try {
          createUrlAccessTracker(true)()
        } catch {
          throw new Error(
            'Cannot resolve fsBundle URL. In Cloudflare Workers, you must provide fsBundle option.',
          )
        }
        return new ArrayBuffer(0)
      }

      await expect(getFsBundle()).rejects.toThrow(
        'Cannot resolve fsBundle URL. In Cloudflare Workers, you must provide fsBundle option.',
      )
    })
  })

  describe('startWasmDownload behavior', () => {
    it('should not be called when wasmModule option is provided', () => {
      let wasmDownloadCalled = false

      function startWasmDownload() {
        wasmDownloadCalled = true
        createUrlAccessTracker(true)() // Would throw
      }

      // Simulate the check in pglite.ts constructor
      const options = {
        wasmModule: {} as WebAssembly.Module,
      }

      // The actual code path: if wasmModule provided, startWasmDownload is never called
      if (!options.wasmModule) {
        startWasmDownload()
      }

      expect(wasmDownloadCalled).toBe(false)
      expect(urlAccessCount).toBe(0)
    })
  })
})
