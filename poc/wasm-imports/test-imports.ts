/**
 * Test file for PGlite WASM Imports POC
 *
 * This file contains tests to verify the import handler works correctly.
 * Note: These tests use mocked WASM memory since we don't have a rebuilt
 * PGlite WASM module with the import declarations yet.
 *
 * To run: npx vitest run poc/wasm-imports/test-imports.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createPGliteImportHandler,
  mergePGliteImports,
  hasWasmMemory,
  type PGliteImportHandler,
  type WasmMemory
} from './pglite-imports'

describe('PGlite WASM Imports POC', () => {
  let handler: PGliteImportHandler
  let mockModule: WasmMemory

  beforeEach(() => {
    // Create handler
    handler = createPGliteImportHandler()

    // Create mock WASM module with 1MB heap
    mockModule = {
      HEAPU8: new Uint8Array(1024 * 1024)
    }

    // Set module reference
    handler.setModule(mockModule)
  })

  describe('createPGliteImportHandler', () => {
    it('should create handler with import functions', () => {
      expect(handler.imports).toBeDefined()
      expect(typeof handler.imports.pglite_js_read).toBe('function')
      expect(typeof handler.imports.pglite_js_write).toBe('function')
    })

    it('should create handler with state management functions', () => {
      expect(typeof handler.setModule).toBe('function')
      expect(typeof handler.setInput).toBe('function')
      expect(typeof handler.getOutput).toBe('function')
      expect(typeof handler.reset).toBe('function')
    })
  })

  describe('pglite_js_read', () => {
    it('should return 0 when no input is set', () => {
      const bufferPtr = 0
      const maxLength = 100

      const bytesRead = handler.imports.pglite_js_read(bufferPtr, maxLength)

      expect(bytesRead).toBe(0)
    })

    it('should read input data into WASM memory', () => {
      const inputData = new Uint8Array([1, 2, 3, 4, 5])
      handler.setInput(inputData)

      const bufferPtr = 100 // Arbitrary location in heap
      const maxLength = 10

      const bytesRead = handler.imports.pglite_js_read(bufferPtr, maxLength)

      expect(bytesRead).toBe(5) // All 5 bytes read
      expect(mockModule.HEAPU8.slice(bufferPtr, bufferPtr + 5)).toEqual(
        inputData
      )
    })

    it('should respect maxLength parameter', () => {
      const inputData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      handler.setInput(inputData)

      const bufferPtr = 0
      const maxLength = 3

      const bytesRead = handler.imports.pglite_js_read(bufferPtr, maxLength)

      expect(bytesRead).toBe(3)
      expect(mockModule.HEAPU8.slice(0, 3)).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('should track read position for subsequent calls', () => {
      const inputData = new Uint8Array([1, 2, 3, 4, 5])
      handler.setInput(inputData)

      // First read: get 2 bytes
      let bytesRead = handler.imports.pglite_js_read(0, 2)
      expect(bytesRead).toBe(2)
      expect(handler.getReadPosition()).toBe(2)

      // Second read: get remaining 3 bytes
      bytesRead = handler.imports.pglite_js_read(10, 10)
      expect(bytesRead).toBe(3)
      expect(mockModule.HEAPU8.slice(10, 13)).toEqual(new Uint8Array([3, 4, 5]))

      // Third read: nothing left
      bytesRead = handler.imports.pglite_js_read(20, 10)
      expect(bytesRead).toBe(0)
    })

    it('should return 0 before module is set', () => {
      const freshHandler = createPGliteImportHandler()
      freshHandler.setInput(new Uint8Array([1, 2, 3]))

      // Module not set yet
      const bytesRead = freshHandler.imports.pglite_js_read(0, 10)
      expect(bytesRead).toBe(0)
    })
  })

  describe('pglite_js_write', () => {
    it('should copy data from WASM memory to output', () => {
      // Write some data to mock WASM memory
      const testData = new Uint8Array([10, 20, 30, 40, 50])
      mockModule.HEAPU8.set(testData, 200)

      // Call write callback
      const bytesWritten = handler.imports.pglite_js_write(200, 5)

      expect(bytesWritten).toBe(5)

      const output = handler.getOutput()
      expect(output.length).toBe(1)
      expect(output[0]).toEqual(testData)
    })

    it('should accumulate multiple writes', () => {
      // First write
      mockModule.HEAPU8.set(new Uint8Array([1, 2, 3]), 0)
      handler.imports.pglite_js_write(0, 3)

      // Second write
      mockModule.HEAPU8.set(new Uint8Array([4, 5]), 100)
      handler.imports.pglite_js_write(100, 2)

      const output = handler.getOutput()
      expect(output.length).toBe(2)
      expect(output[0]).toEqual(new Uint8Array([1, 2, 3]))
      expect(output[1]).toEqual(new Uint8Array([4, 5]))
    })

    it('should create independent copies of data', () => {
      // Write data
      mockModule.HEAPU8.set(new Uint8Array([1, 2, 3]), 0)
      handler.imports.pglite_js_write(0, 3)

      // Modify WASM memory after write
      mockModule.HEAPU8[0] = 99

      // Output should be unchanged
      const output = handler.getOutput()
      expect(output[0][0]).toBe(1) // Not 99
    })

    it('should return 0 before module is set', () => {
      const freshHandler = createPGliteImportHandler()

      const bytesWritten = freshHandler.imports.pglite_js_write(0, 10)
      expect(bytesWritten).toBe(0)
    })
  })

  describe('reset', () => {
    it('should clear all state', () => {
      // Set up state
      handler.setInput(new Uint8Array([1, 2, 3, 4, 5]))
      handler.imports.pglite_js_read(0, 2) // Read some
      mockModule.HEAPU8.set(new Uint8Array([10, 20]), 0)
      handler.imports.pglite_js_write(0, 2) // Write some

      // Reset
      handler.reset()

      // Verify state is cleared
      expect(handler.getReadPosition()).toBe(0)
      expect(handler.getOutput()).toEqual([])

      // Read should return 0 (no input)
      const bytesRead = handler.imports.pglite_js_read(0, 10)
      expect(bytesRead).toBe(0)
    })
  })

  describe('debug counters', () => {
    it('should track total bytes read', () => {
      handler.setInput(new Uint8Array([1, 2, 3, 4, 5]))
      handler.imports.pglite_js_read(0, 3)
      handler.imports.pglite_js_read(10, 2)

      expect(handler.getTotalBytesRead()).toBe(5)
    })

    it('should track total bytes written', () => {
      mockModule.HEAPU8.set(new Uint8Array([1, 2, 3]), 0)
      handler.imports.pglite_js_write(0, 3)
      handler.imports.pglite_js_write(0, 2)

      expect(handler.getTotalBytesWritten()).toBe(5)
    })
  })

  describe('mergePGliteImports', () => {
    it('should merge imports into env namespace', () => {
      const emscriptenImports = {
        env: {
          existing: () => 42
        },
        wasi_snapshot_preview1: {
          fd_write: () => 0
        }
      }

      const merged = mergePGliteImports(emscriptenImports, handler.imports)

      // Original imports preserved
      expect(merged.env).toBeDefined()
      expect(typeof (merged.env as any).existing).toBe('function')
      expect(typeof merged.wasi_snapshot_preview1).toBe('object')

      // PGlite imports added
      expect(typeof (merged.env as any).pglite_js_read).toBe('function')
      expect(typeof (merged.env as any).pglite_js_write).toBe('function')
    })
  })

  describe('hasWasmMemory', () => {
    it('should return true for valid WASM memory', () => {
      expect(hasWasmMemory(mockModule)).toBe(true)
    })

    it('should return false for null', () => {
      expect(hasWasmMemory(null)).toBe(false)
    })

    it('should return false for undefined', () => {
      expect(hasWasmMemory(undefined)).toBe(false)
    })

    it('should return false for objects without HEAPU8', () => {
      expect(hasWasmMemory({ foo: 'bar' })).toBe(false)
    })

    it('should return false for objects with wrong HEAPU8 type', () => {
      expect(hasWasmMemory({ HEAPU8: 'not an array' })).toBe(false)
    })
  })
})

describe('Integration Simulation', () => {
  /**
   * This test simulates how the imports would be used in actual PGlite code.
   * It demonstrates the full flow without an actual WASM module.
   */
  it('should simulate a full query cycle', () => {
    // 1. Create handler
    const handler = createPGliteImportHandler()

    // 2. Simulate WASM instantiation
    const mockHeap = new Uint8Array(1024)
    handler.setModule({ HEAPU8: mockHeap })

    // 3. Prepare query input (simulated PostgreSQL wire protocol)
    const queryInput = new Uint8Array([
      81, // 'Q' - Simple Query message type
      0,
      0,
      0,
      14, // Length: 14 bytes
      83,
      69,
      76,
      69,
      67,
      84,
      32,
      49, // "SELECT 1"
      0 // Null terminator
    ])
    handler.setInput(queryInput)

    // 4. Simulate WASM calling recv() to get query
    // In real code, this happens inside _interactive_one
    let bytesRead = handler.imports.pglite_js_read(100, 50)
    expect(bytesRead).toBe(queryInput.length)
    expect(mockHeap.slice(100, 100 + queryInput.length)).toEqual(queryInput)

    // 5. Simulate WASM calling send() with results
    // In real code, PostgreSQL would process the query and send results
    const mockResult = new Uint8Array([
      84, // 'T' - Row Description
      0,
      0,
      0,
      10,
      1,
      2,
      3,
      4,
      5
    ])
    mockHeap.set(mockResult, 200)
    handler.imports.pglite_js_write(200, mockResult.length)

    // 6. Get output
    const output = handler.getOutput()
    expect(output.length).toBe(1)
    expect(output[0]).toEqual(mockResult)

    // 7. Reset for next query
    handler.reset()
    expect(handler.getOutput()).toEqual([])
  })
})
