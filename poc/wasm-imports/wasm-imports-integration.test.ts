/**
 * Integration tests for PGlite WASM Imports
 *
 * These tests verify the WASM imports handler works correctly with mocked WASM memory.
 * For tests with actual WASM, the module needs to be rebuilt with pglite-comm-imports.h.
 *
 * Run: npx vitest run poc/wasm-imports/wasm-imports-integration.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createPGliteWasmImports,
  instantiateWasmWithImports,
  hasWasmImportsDeclarations,
  getWasmImports,
  type PGliteWasmImportsHandler,
  type WasmModule
} from './pglite-wasm-imports'

describe('PGlite WASM Imports Handler', () => {
  let handler: PGliteWasmImportsHandler
  let mockModule: WasmModule

  beforeEach(() => {
    handler = createPGliteWasmImports()

    // Create mock WASM module with 1MB heap
    mockModule = {
      HEAPU8: new Uint8Array(1024 * 1024),
      HEAP8: new Int8Array(1024 * 1024)
    }

    handler.setModule(mockModule)
  })

  describe('Handler Creation', () => {
    it('should create handler with import functions', () => {
      expect(handler.imports).toBeDefined()
      expect(typeof handler.imports.pglite_js_read).toBe('function')
      expect(typeof handler.imports.pglite_js_write).toBe('function')
    })

    it('should create handler with state management functions', () => {
      expect(typeof handler.setModule).toBe('function')
      expect(typeof handler.setInput).toBe('function')
      expect(typeof handler.getOutput).toBe('function')
      expect(typeof handler.getMessages).toBe('function')
      expect(typeof handler.reset).toBe('function')
    })

    it('should accept debug option', () => {
      const debugHandler = createPGliteWasmImports({ debug: true })
      expect(debugHandler).toBeDefined()
    })
  })

  describe('Read Callback (pglite_js_read)', () => {
    it('should return 0 when no input is set', () => {
      const bytesRead = handler.imports.pglite_js_read(0, 100)
      expect(bytesRead).toBe(0)
    })

    it('should read input data into WASM memory', () => {
      const inputData = new Uint8Array([1, 2, 3, 4, 5])
      handler.setInput(inputData)

      const bufferPtr = 100
      const bytesRead = handler.imports.pglite_js_read(bufferPtr, 10)

      expect(bytesRead).toBe(5)
      expect(mockModule.HEAPU8.slice(bufferPtr, bufferPtr + 5)).toEqual(inputData)
    })

    it('should respect maxLength parameter', () => {
      const inputData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      handler.setInput(inputData)

      const bytesRead = handler.imports.pglite_js_read(0, 3)

      expect(bytesRead).toBe(3)
      expect(mockModule.HEAPU8.slice(0, 3)).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('should track read position for subsequent calls', () => {
      const inputData = new Uint8Array([1, 2, 3, 4, 5])
      handler.setInput(inputData)

      // First read
      let bytesRead = handler.imports.pglite_js_read(0, 2)
      expect(bytesRead).toBe(2)
      expect(handler.getReadOffset()).toBe(2)

      // Second read
      bytesRead = handler.imports.pglite_js_read(10, 10)
      expect(bytesRead).toBe(3)
      expect(mockModule.HEAPU8.slice(10, 13)).toEqual(new Uint8Array([3, 4, 5]))

      // Third read - nothing left
      bytesRead = handler.imports.pglite_js_read(20, 10)
      expect(bytesRead).toBe(0)
    })

    it('should return 0 before module is set', () => {
      const freshHandler = createPGliteWasmImports()
      freshHandler.setInput(new Uint8Array([1, 2, 3]))

      const bytesRead = freshHandler.imports.pglite_js_read(0, 10)
      expect(bytesRead).toBe(0)
    })
  })

  describe('Write Callback (pglite_js_write)', () => {
    it('should store data from WASM memory', () => {
      const testData = new Uint8Array([10, 20, 30, 40, 50])
      mockModule.HEAPU8.set(testData, 200)

      const bytesWritten = handler.imports.pglite_js_write(200, 5)

      expect(bytesWritten).toBe(5)
      expect(handler.getOutput().length).toBe(5)
    })

    it('should accumulate multiple writes', () => {
      // First write
      mockModule.HEAPU8.set(new Uint8Array([1, 2, 3]), 0)
      handler.imports.pglite_js_write(0, 3)

      // Second write
      mockModule.HEAPU8.set(new Uint8Array([4, 5]), 100)
      handler.imports.pglite_js_write(100, 2)

      const output = handler.getOutput()
      expect(output.length).toBe(5)
    })

    it('should parse PostgreSQL protocol messages', () => {
      // Simulate a simple ReadyForQuery message
      // 'Z' (0x5A) followed by length (5) and status 'I' (0x49)
      const readyForQueryMessage = new Uint8Array([
        0x5A, // 'Z' - ReadyForQuery
        0x00, 0x00, 0x00, 0x05, // Length: 5 bytes
        0x49 // 'I' - Idle status
      ])
      mockModule.HEAPU8.set(readyForQueryMessage, 0)
      handler.imports.pglite_js_write(0, readyForQueryMessage.length)

      const messages = handler.getMessages()
      expect(messages.length).toBe(1)
      expect(messages[0].name).toBe('readyForQuery')
    })

    it('should return 0 before module is set', () => {
      const freshHandler = createPGliteWasmImports()
      const bytesWritten = freshHandler.imports.pglite_js_write(0, 10)
      expect(bytesWritten).toBe(0)
    })
  })

  describe('State Management', () => {
    it('should reset all state', () => {
      // Set up state
      handler.setInput(new Uint8Array([1, 2, 3, 4, 5]))
      handler.imports.pglite_js_read(0, 2)
      mockModule.HEAPU8.set(new Uint8Array([10, 20]), 0)
      handler.imports.pglite_js_write(0, 2)

      // Reset
      handler.reset()

      // Verify state is cleared
      expect(handler.getReadOffset()).toBe(0)
      expect(handler.getWriteOffset()).toBe(0)
      expect(handler.getOutput().length).toBe(0)
      expect(handler.getMessages().length).toBe(0)

      // Read should return 0 (no input)
      const bytesRead = handler.imports.pglite_js_read(0, 10)
      expect(bytesRead).toBe(0)
    })

    it('should track debug counters', () => {
      handler.setInput(new Uint8Array([1, 2, 3, 4, 5]))
      handler.imports.pglite_js_read(0, 3)
      handler.imports.pglite_js_read(10, 2)

      mockModule.HEAPU8.set(new Uint8Array([1, 2, 3]), 0)
      handler.imports.pglite_js_write(0, 3)

      expect(handler.getTotalBytesRead()).toBe(5)
      expect(handler.getTotalBytesWritten()).toBe(3)
    })
  })

  describe('Buffer Management', () => {
    it('should grow output buffer when needed', () => {
      // Create handler with small default buffer
      const smallHandler = createPGliteWasmImports({
        defaultBufferSize: 100
      })
      smallHandler.setModule(mockModule)

      // Write more than 100 bytes
      const largeData = new Uint8Array(150)
      largeData.fill(42)
      mockModule.HEAPU8.set(largeData, 0)
      smallHandler.imports.pglite_js_write(0, 150)

      const output = smallHandler.getOutput()
      expect(output.length).toBe(150)
      expect(output[0]).toBe(42)
      expect(output[149]).toBe(42)
    })

    it('should respect maxBufferSize', () => {
      const tinyHandler = createPGliteWasmImports({
        defaultBufferSize: 10,
        maxBufferSize: 50
      })
      tinyHandler.setModule(mockModule)

      // First write - should work
      mockModule.HEAPU8.set(new Uint8Array(40), 0)
      tinyHandler.imports.pglite_js_write(0, 40)

      // Second write that would exceed max - should throw
      expect(() => {
        tinyHandler.imports.pglite_js_write(0, 20)
      }).toThrow(/maximum size/)
    })

    it('should reset buffer size on reset', () => {
      const smallHandler = createPGliteWasmImports({
        defaultBufferSize: 100
      })
      smallHandler.setModule(mockModule)

      // Grow the buffer
      const largeData = new Uint8Array(500)
      mockModule.HEAPU8.set(largeData, 0)
      smallHandler.imports.pglite_js_write(0, 500)

      // Reset
      smallHandler.reset()

      // Output should be empty and buffer should be at default size
      expect(smallHandler.getOutput().length).toBe(0)
    })
  })

  describe('Options', () => {
    it('should support keepRawResponse option', () => {
      handler.setKeepRawResponse(false)

      mockModule.HEAPU8.set(new Uint8Array([1, 2, 3]), 0)
      handler.imports.pglite_js_write(0, 3)

      // Output should be empty when keepRawResponse is false
      expect(handler.getOutput().length).toBe(0)
    })

    it('should call onMessage callback', () => {
      const onMessage = vi.fn()
      const handlerWithCallback = createPGliteWasmImports({ onMessage })
      handlerWithCallback.setModule(mockModule)

      // Write a ReadyForQuery message
      const msg = new Uint8Array([0x5A, 0x00, 0x00, 0x00, 0x05, 0x49])
      mockModule.HEAPU8.set(msg, 0)
      handlerWithCallback.imports.pglite_js_write(0, msg.length)

      expect(onMessage).toHaveBeenCalledTimes(1)
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'readyForQuery' }))
    })
  })
})

describe('WASM Import Instantiation Helpers', () => {
  it('instantiateWasmWithImports should merge imports correctly', async () => {
    const handler = createPGliteWasmImports()

    // Create a minimal valid WASM module that imports pglite_js_read and pglite_js_write
    // This is the minimum valid WASM that imports two functions
    const wasmBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // WASM magic number
      0x01, 0x00, 0x00, 0x00, // WASM version 1
      // Type section (2 function types: both (i32, i32) -> i32)
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
      // Import section (2 imports from "env")
      0x02, 0x23, // Section ID and size
      0x02, // 2 imports
      // Import 1: env.pglite_js_read
      0x03, 0x65, 0x6e, 0x76, // "env"
      0x0f, 0x70, 0x67, 0x6c, 0x69, 0x74, 0x65, 0x5f, 0x6a, 0x73, 0x5f, 0x72, 0x65, 0x61, 0x64, // "pglite_js_read"
      0x00, 0x00, // func type 0
      // Import 2: env.pglite_js_write
      0x03, 0x65, 0x6e, 0x76, // "env"
      0x10, 0x70, 0x67, 0x6c, 0x69, 0x74, 0x65, 0x5f, 0x6a, 0x73, 0x5f, 0x77, 0x72, 0x69, 0x74, 0x65, // "pglite_js_write"
      0x00, 0x00 // func type 0
    ])

    const wasmModule = await WebAssembly.compile(wasmBytes)

    const emscriptenImports: WebAssembly.Imports = {
      env: {
        someOtherFunction: () => 42
      }
    }

    // This should not throw
    const result = await instantiateWasmWithImports(
      emscriptenImports,
      handler,
      wasmModule
    )

    expect(result.instance).toBeDefined()
    expect(result.module).toBe(wasmModule)
  })
})

describe('WASM Module Inspection', () => {
  it('hasWasmImportsDeclarations should detect imports', async () => {
    // Create WASM module with pglite imports
    const wasmBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
      0x02, 0x23,
      0x02,
      0x03, 0x65, 0x6e, 0x76,
      0x0f, 0x70, 0x67, 0x6c, 0x69, 0x74, 0x65, 0x5f, 0x6a, 0x73, 0x5f, 0x72, 0x65, 0x61, 0x64,
      0x00, 0x00,
      0x03, 0x65, 0x6e, 0x76,
      0x10, 0x70, 0x67, 0x6c, 0x69, 0x74, 0x65, 0x5f, 0x6a, 0x73, 0x5f, 0x77, 0x72, 0x69, 0x74, 0x65,
      0x00, 0x00
    ])

    const wasmModule = await WebAssembly.compile(wasmBytes)
    expect(hasWasmImportsDeclarations(wasmModule)).toBe(true)
  })

  it('hasWasmImportsDeclarations should return false for module without imports', async () => {
    // Minimal WASM module without imports
    const wasmBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00
    ])

    const wasmModule = await WebAssembly.compile(wasmBytes)
    expect(hasWasmImportsDeclarations(wasmModule)).toBe(false)
  })

  it('getWasmImports should return import list', async () => {
    const wasmBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
      0x02, 0x23,
      0x02,
      0x03, 0x65, 0x6e, 0x76,
      0x0f, 0x70, 0x67, 0x6c, 0x69, 0x74, 0x65, 0x5f, 0x6a, 0x73, 0x5f, 0x72, 0x65, 0x61, 0x64,
      0x00, 0x00,
      0x03, 0x65, 0x6e, 0x76,
      0x10, 0x70, 0x67, 0x6c, 0x69, 0x74, 0x65, 0x5f, 0x6a, 0x73, 0x5f, 0x77, 0x72, 0x69, 0x74, 0x65,
      0x00, 0x00
    ])

    const wasmModule = await WebAssembly.compile(wasmBytes)
    const imports = getWasmImports(wasmModule)

    expect(imports.length).toBe(2)
    expect(imports.some(i => i.name === 'pglite_js_read')).toBe(true)
    expect(imports.some(i => i.name === 'pglite_js_write')).toBe(true)
  })
})

describe('Full Query Simulation', () => {
  /**
   * Simulates a complete query cycle to verify the handler
   * works correctly in a realistic scenario.
   */
  it('should handle a complete query cycle', () => {
    const handler = createPGliteWasmImports()
    const mockHeap = new Uint8Array(4096)
    handler.setModule({ HEAPU8: mockHeap, HEAP8: new Int8Array(mockHeap.buffer) })

    // 1. Set query input (PostgreSQL Simple Query message)
    // 'Q' followed by length and "SELECT 1\0"
    const queryInput = new Uint8Array([
      0x51, // 'Q' - Simple Query
      0x00, 0x00, 0x00, 0x0E, // Length: 14 bytes
      0x53, 0x45, 0x4C, 0x45, 0x43, 0x54, 0x20, 0x31, // "SELECT 1"
      0x00 // Null terminator
    ])
    handler.setInput(queryInput)

    // 2. Simulate WASM reading the query
    const readBuffer = 100
    let bytesRead = handler.imports.pglite_js_read(readBuffer, 50)
    expect(bytesRead).toBe(queryInput.length)
    expect(mockHeap.slice(readBuffer, readBuffer + queryInput.length)).toEqual(queryInput)

    // 3. Simulate WASM sending a response (ReadyForQuery)
    const response = new Uint8Array([
      0x5A, // 'Z' - ReadyForQuery
      0x00, 0x00, 0x00, 0x05, // Length: 5 bytes
      0x49 // 'I' - Idle
    ])
    mockHeap.set(response, 200)
    handler.imports.pglite_js_write(200, response.length)

    // 4. Verify output
    const output = handler.getOutput()
    expect(output.length).toBe(response.length)
    expect(output).toEqual(response)

    // 5. Verify parsed messages
    const messages = handler.getMessages()
    expect(messages.length).toBe(1)
    expect(messages[0].name).toBe('readyForQuery')

    // 6. Reset for next query
    handler.reset()
    expect(handler.getOutput().length).toBe(0)
    expect(handler.getMessages().length).toBe(0)
    expect(handler.getReadOffset()).toBe(0)
  })
})
