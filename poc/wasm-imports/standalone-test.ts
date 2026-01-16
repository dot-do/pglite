/**
 * Standalone test for PGlite WASM Imports
 *
 * This test file has no external dependencies and can be run with:
 *   npx tsx poc/wasm-imports/standalone-test.ts
 *
 * It verifies the core WASM imports handler functionality without
 * requiring the full PGlite dependencies.
 */

// ============================================================================
// MINIMAL TYPE DEFINITIONS (no external imports)
// ============================================================================

interface WasmModule {
  HEAPU8: Uint8Array
  HEAP8: Int8Array
}

interface PGliteWasmImports {
  pglite_js_read: (bufferPtr: number, maxLength: number) => number
  pglite_js_write: (bufferPtr: number, length: number) => number
}

interface PGliteWasmImportsHandler {
  readonly imports: PGliteWasmImports
  setModule(mod: WasmModule): void
  setInput(data: Uint8Array): void
  getOutput(): Uint8Array
  reset(): void
  getReadOffset(): number
  getWriteOffset(): number
}

// ============================================================================
// IMPLEMENTATION (copied from pglite-wasm-imports.ts for standalone testing)
// ============================================================================

function createPGliteWasmImportsForTest(): PGliteWasmImportsHandler {
  let module: WasmModule | undefined
  let inputBuffer: Uint8Array | undefined
  let inputOffset = 0
  let outputBuffer = new Uint8Array(1024 * 1024)
  let outputOffset = 0

  const imports: PGliteWasmImports = {
    pglite_js_read: (bufferPtr: number, maxLength: number): number => {
      if (!module || !inputBuffer) return 0

      const available = inputBuffer.length - inputOffset
      if (available === 0) return 0

      const length = Math.min(available, maxLength)
      module.HEAPU8.set(
        inputBuffer.subarray(inputOffset, inputOffset + length),
        bufferPtr
      )
      inputOffset += length
      return length
    },

    pglite_js_write: (bufferPtr: number, length: number): number => {
      if (!module) return 0

      const bytes = module.HEAPU8.subarray(bufferPtr, bufferPtr + length)

      if (outputOffset + length > outputBuffer.length) {
        const newBuffer = new Uint8Array(outputBuffer.length * 2)
        newBuffer.set(outputBuffer.subarray(0, outputOffset))
        outputBuffer = newBuffer
      }

      outputBuffer.set(bytes, outputOffset)
      outputOffset += length
      return length
    }
  }

  return {
    imports,

    setModule(mod: WasmModule) {
      module = mod
    },

    setInput(data: Uint8Array) {
      inputBuffer = data
      inputOffset = 0
    },

    getOutput(): Uint8Array {
      return outputBuffer.subarray(0, outputOffset)
    },

    reset() {
      inputBuffer = undefined
      inputOffset = 0
      outputOffset = 0
    },

    getReadOffset: () => inputOffset,
    getWriteOffset: () => outputOffset
  }
}

// ============================================================================
// TEST RUNNER
// ============================================================================

interface TestResult {
  name: string
  passed: boolean
  error?: string
}

const results: TestResult[] = []

function test(name: string, fn: () => void) {
  try {
    fn()
    results.push({ name, passed: true })
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error })
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error}`)
  }
}

function assertEqual<T>(actual: T, expected: T, message = '') {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}. ${message}`)
  }
}

function assertArrayEqual(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length) {
    throw new Error(`Array length mismatch: ${actual.length} vs ${expected.length}`)
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`Array mismatch at index ${i}: ${actual[i]} vs ${expected[i]}`)
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

console.log('\n=== PGlite WASM Imports Standalone Tests ===\n')

console.log('Handler Creation:')
test('should create handler with import functions', () => {
  const handler = createPGliteWasmImportsForTest()
  assertEqual(typeof handler.imports.pglite_js_read, 'function')
  assertEqual(typeof handler.imports.pglite_js_write, 'function')
})

console.log('\nRead Callback:')
test('should return 0 when no input is set', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockModule: WasmModule = {
    HEAPU8: new Uint8Array(1024),
    HEAP8: new Int8Array(1024)
  }
  handler.setModule(mockModule)

  const bytesRead = handler.imports.pglite_js_read(0, 100)
  assertEqual(bytesRead, 0)
})

test('should read input data into WASM memory', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockModule: WasmModule = {
    HEAPU8: new Uint8Array(1024),
    HEAP8: new Int8Array(1024)
  }
  handler.setModule(mockModule)

  const inputData = new Uint8Array([1, 2, 3, 4, 5])
  handler.setInput(inputData)

  const bufferPtr = 100
  const bytesRead = handler.imports.pglite_js_read(bufferPtr, 10)

  assertEqual(bytesRead, 5)
  assertArrayEqual(mockModule.HEAPU8.slice(bufferPtr, bufferPtr + 5), inputData)
})

test('should respect maxLength parameter', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockModule: WasmModule = {
    HEAPU8: new Uint8Array(1024),
    HEAP8: new Int8Array(1024)
  }
  handler.setModule(mockModule)

  const inputData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  handler.setInput(inputData)

  const bytesRead = handler.imports.pglite_js_read(0, 3)

  assertEqual(bytesRead, 3)
  assertArrayEqual(mockModule.HEAPU8.slice(0, 3), new Uint8Array([1, 2, 3]))
})

test('should track read position for subsequent calls', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockModule: WasmModule = {
    HEAPU8: new Uint8Array(1024),
    HEAP8: new Int8Array(1024)
  }
  handler.setModule(mockModule)

  const inputData = new Uint8Array([1, 2, 3, 4, 5])
  handler.setInput(inputData)

  // First read
  let bytesRead = handler.imports.pglite_js_read(0, 2)
  assertEqual(bytesRead, 2)
  assertEqual(handler.getReadOffset(), 2)

  // Second read
  bytesRead = handler.imports.pglite_js_read(10, 10)
  assertEqual(bytesRead, 3)
  assertArrayEqual(mockModule.HEAPU8.slice(10, 13), new Uint8Array([3, 4, 5]))

  // Third read - nothing left
  bytesRead = handler.imports.pglite_js_read(20, 10)
  assertEqual(bytesRead, 0)
})

console.log('\nWrite Callback:')
test('should store data from WASM memory', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockModule: WasmModule = {
    HEAPU8: new Uint8Array(1024),
    HEAP8: new Int8Array(1024)
  }
  handler.setModule(mockModule)

  const testData = new Uint8Array([10, 20, 30, 40, 50])
  mockModule.HEAPU8.set(testData, 200)

  const bytesWritten = handler.imports.pglite_js_write(200, 5)

  assertEqual(bytesWritten, 5)
  assertEqual(handler.getOutput().length, 5)
  assertArrayEqual(handler.getOutput(), testData)
})

test('should accumulate multiple writes', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockModule: WasmModule = {
    HEAPU8: new Uint8Array(1024),
    HEAP8: new Int8Array(1024)
  }
  handler.setModule(mockModule)

  // First write
  mockModule.HEAPU8.set(new Uint8Array([1, 2, 3]), 0)
  handler.imports.pglite_js_write(0, 3)

  // Second write
  mockModule.HEAPU8.set(new Uint8Array([4, 5]), 100)
  handler.imports.pglite_js_write(100, 2)

  const output = handler.getOutput()
  assertEqual(output.length, 5)
  assertArrayEqual(output, new Uint8Array([1, 2, 3, 4, 5]))
})

console.log('\nState Management:')
test('should reset all state', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockModule: WasmModule = {
    HEAPU8: new Uint8Array(1024),
    HEAP8: new Int8Array(1024)
  }
  handler.setModule(mockModule)

  // Set up state
  handler.setInput(new Uint8Array([1, 2, 3, 4, 5]))
  handler.imports.pglite_js_read(0, 2)
  mockModule.HEAPU8.set(new Uint8Array([10, 20]), 0)
  handler.imports.pglite_js_write(0, 2)

  // Reset
  handler.reset()

  // Verify state is cleared
  assertEqual(handler.getReadOffset(), 0)
  assertEqual(handler.getWriteOffset(), 0)
  assertEqual(handler.getOutput().length, 0)

  // Read should return 0 (no input)
  const bytesRead = handler.imports.pglite_js_read(0, 10)
  assertEqual(bytesRead, 0)
})

console.log('\nFull Query Cycle Simulation:')
test('should handle a complete query cycle', () => {
  const handler = createPGliteWasmImportsForTest()
  const mockHeap = new Uint8Array(4096)
  handler.setModule({ HEAPU8: mockHeap, HEAP8: new Int8Array(mockHeap.buffer) })

  // 1. Set query input (simulated PostgreSQL wire protocol)
  const queryInput = new Uint8Array([
    0x51, // 'Q' - Simple Query
    0x00, 0x00, 0x00, 0x0E, // Length: 14 bytes
    0x53, 0x45, 0x4C, 0x45, 0x43, 0x54, 0x20, 0x31, // "SELECT 1"
    0x00 // Null terminator
  ])
  handler.setInput(queryInput)

  // 2. Simulate WASM reading the query
  const bytesRead = handler.imports.pglite_js_read(100, 50)
  assertEqual(bytesRead, queryInput.length)
  assertArrayEqual(mockHeap.slice(100, 100 + queryInput.length), queryInput)

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
  assertEqual(output.length, response.length)
  assertArrayEqual(output, response)

  // 5. Reset for next query
  handler.reset()
  assertEqual(handler.getOutput().length, 0)
  assertEqual(handler.getReadOffset(), 0)
})

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n=== Test Summary ===')
const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed).length
console.log(`Total: ${results.length}, Passed: ${passed}, Failed: ${failed}`)

if (failed > 0) {
  console.log('\nFailed tests:')
  results.filter(r => !r.passed).forEach(r => {
    console.log(`  - ${r.name}: ${r.error}`)
  })
  process.exit(1)
} else {
  console.log('\nAll tests passed!')
  process.exit(0)
}
