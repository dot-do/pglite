/**
 * PGlite WASM Imports Integration
 *
 * This module provides the TypeScript integration for using WASM imports
 * instead of Emscripten's addFunction() to provide PGlite's read/write callbacks.
 *
 * This approach eliminates runtime WASM code generation, making PGlite compatible
 * with Cloudflare Workers and other restricted JavaScript environments.
 *
 * ARCHITECTURE:
 *
 *   JavaScript (this module)              WASM (C code with imports)
 *   ----------------------                ------------------------
 *
 *   createPGliteWasmImports() ──────────> pglite_js_read (import)
 *        │                                     │
 *        │ setInput(queryBytes)                ▼
 *        │         ─────────────────────> recv() calls pglite_js_read
 *        │                                     │
 *        │                                     ▼
 *        │                                PostgreSQL processes query
 *        │                                     │
 *        │ getOutput() <─────────────────      ▼
 *        │         <─────────────────────< send() calls pglite_js_write
 *        │                                pglite_js_write (import)
 *        ▼
 *   Parse protocol messages
 *
 * USAGE:
 *
 * ```typescript
 * import { createPGliteWasmImports, instantiateWasmWithImports } from './pglite-wasm-imports'
 * import PostgresModFactory from '../release/pglite'
 *
 * // Create import handler
 * const importsHandler = createPGliteWasmImports()
 *
 * // Instantiate module with imports
 * const mod = await PostgresModFactory({
 *   instantiateWasm: (imports, callback) => {
 *     instantiateWasmWithImports(imports, importsHandler, wasmModule)
 *       .then(({ instance, module }) => callback(instance, module))
 *     return {}
 *   }
 * })
 *
 * // Set module reference (required for memory access)
 * importsHandler.setModule(mod)
 *
 * // Execute query
 * importsHandler.setInput(queryBytes)
 * mod._interactive_one(queryBytes.length, queryBytes[0])
 * const results = importsHandler.getOutput()
 * importsHandler.reset()
 * ```
 *
 * @module pglite-wasm-imports
 */

import { Parser as ProtocolParser } from '@electric-sql/pg-protocol'
import type { BackendMessage } from '@electric-sql/pg-protocol/messages'

// ============================================================================
// TYPES
// ============================================================================

/**
 * WASM import function signatures
 *
 * These match the C declarations in pglite-comm-imports.h:
 *   extern ssize_t pglite_js_read(void *buffer, size_t max_length);
 *   extern ssize_t pglite_js_write(void *buffer, size_t length);
 */
export interface PGliteWasmImports {
  /**
   * Read callback - WASM calls this to get query input from JavaScript
   *
   * Called by C's recv() when PostgreSQL needs to read query data.
   * The JavaScript side provides query bytes, which are copied into WASM memory.
   *
   * @param bufferPtr - Pointer to WASM memory where data should be written
   * @param maxLength - Maximum bytes to read
   * @returns Number of bytes actually read (0 if no more data)
   */
  pglite_js_read: (bufferPtr: number, maxLength: number) => number

  /**
   * Write callback - WASM calls this to send results to JavaScript
   *
   * Called by C's send() when PostgreSQL has query results.
   * The JavaScript side receives the bytes and parses PostgreSQL protocol messages.
   *
   * @param bufferPtr - Pointer to WASM memory containing data to send
   * @param length - Number of bytes to write
   * @returns Number of bytes actually written
   */
  pglite_js_write: (bufferPtr: number, length: number) => number
}

/**
 * Interface for accessing WASM memory
 * This is a subset of the Emscripten module interface
 */
export interface WasmModule {
  /** WASM heap as Uint8Array view */
  HEAPU8: Uint8Array
  /** WASM heap as Int8Array view */
  HEAP8: Int8Array
}

/**
 * Options for the PGlite WASM imports handler
 */
export interface PGliteWasmImportsOptions {
  /**
   * Whether to keep raw response bytes (default: true)
   * Set to false for streaming mode
   */
  keepRawResponse?: boolean

  /**
   * Default buffer size for raw responses (default: 1MB)
   */
  defaultBufferSize?: number

  /**
   * Maximum buffer size (default: 1GB)
   */
  maxBufferSize?: number

  /**
   * Callback for parsed protocol messages
   * Called for each message as it arrives
   */
  onMessage?: (msg: BackendMessage) => void

  /**
   * Enable debug logging
   */
  debug?: boolean
}

/**
 * Handler interface for PGlite WASM imports
 */
export interface PGliteWasmImportsHandler {
  /**
   * The import functions to provide to WebAssembly.instantiate
   */
  readonly imports: PGliteWasmImports

  /**
   * Set the WASM module reference
   * Must be called after instantiation
   */
  setModule(mod: WasmModule): void

  /**
   * Set the input data for the next query
   * Call BEFORE executing _interactive_one
   */
  setInput(data: Uint8Array): void

  /**
   * Get raw output bytes from the last query
   */
  getOutput(): Uint8Array

  /**
   * Get parsed protocol messages from the last query
   */
  getMessages(): BackendMessage[]

  /**
   * Reset state for the next query
   */
  reset(): void

  /**
   * Set whether to keep raw response bytes
   */
  setKeepRawResponse(keep: boolean): void

  // Debug methods
  getReadOffset(): number
  getWriteOffset(): number
  getTotalBytesRead(): number
  getTotalBytesWritten(): number
}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

const DEFAULT_BUFFER_SIZE = 1 * 1024 * 1024 // 1MB
const MAX_BUFFER_SIZE = Math.pow(2, 30) // 1GB

/**
 * Creates a PGlite WASM imports handler
 *
 * This factory function creates the import functions and state management
 * needed to handle PGlite's read/write callbacks via WASM imports.
 *
 * @param options - Configuration options
 * @returns Handler with imports and state management functions
 */
export function createPGliteWasmImports(
  options: PGliteWasmImportsOptions = {}
): PGliteWasmImportsHandler {
  const {
    keepRawResponse: initialKeepRawResponse = true,
    defaultBufferSize = DEFAULT_BUFFER_SIZE,
    maxBufferSize = MAX_BUFFER_SIZE,
    onMessage,
    debug = false
  } = options

  // ========================================================================
  // STATE
  // ========================================================================

  /** Reference to WASM module (set after instantiation) */
  let module: WasmModule | undefined

  /** Protocol parser for incoming messages */
  const protocolParser = new ProtocolParser()

  /** Whether to keep raw response bytes */
  let keepRawResponse = initialKeepRawResponse

  // Input state
  /** Input buffer for current query (PostgreSQL wire protocol bytes) */
  let inputBuffer: Uint8Array | undefined
  /** Current read position in input buffer */
  let inputOffset = 0

  // Output state
  /** Buffer for raw response bytes */
  let outputBuffer = new Uint8Array(defaultBufferSize)
  /** Current write position in output buffer */
  let outputOffset = 0
  /** Parsed protocol messages */
  let messages: BackendMessage[] = []

  // Debug counters
  let totalBytesRead = 0
  let totalBytesWritten = 0

  // ========================================================================
  // HELPER FUNCTIONS
  // ========================================================================

  const log = (...args: unknown[]) => {
    if (debug) {
      console.log('[pglite-wasm-imports]', ...args)
    }
  }

  /**
   * Ensure output buffer has enough capacity
   */
  const ensureOutputCapacity = (additionalBytes: number) => {
    const requiredSize = outputOffset + additionalBytes
    if (requiredSize <= outputBuffer.length) {
      return
    }

    // Calculate new size (1.5x current + required)
    let newSize = Math.ceil(outputBuffer.length * 1.5) + additionalBytes
    if (newSize > maxBufferSize) {
      newSize = maxBufferSize
      if (requiredSize > maxBufferSize) {
        throw new Error(
          `Output buffer would exceed maximum size (${maxBufferSize} bytes)`
        )
      }
    }

    log(`Growing output buffer from ${outputBuffer.length} to ${newSize}`)
    const newBuffer = new Uint8Array(newSize)
    newBuffer.set(outputBuffer.subarray(0, outputOffset))
    outputBuffer = newBuffer
  }

  // ========================================================================
  // IMPORT FUNCTIONS
  // ========================================================================

  const imports: PGliteWasmImports = {
    /**
     * Read callback implementation
     *
     * Called by WASM's recv() when PostgreSQL needs query input.
     * Copies data from our inputBuffer into WASM memory.
     */
    pglite_js_read: (bufferPtr: number, maxLength: number): number => {
      if (!module) {
        log('pglite_js_read called before module set')
        return 0
      }

      if (!inputBuffer) {
        return 0
      }

      const available = inputBuffer.length - inputOffset
      if (available === 0) {
        return 0
      }

      const length = Math.min(available, maxLength)
      module.HEAPU8.set(
        inputBuffer.subarray(inputOffset, inputOffset + length),
        bufferPtr
      )

      inputOffset += length
      totalBytesRead += length

      log(`Read ${length} bytes (offset: ${inputOffset}, total: ${totalBytesRead})`)

      return length
    },

    /**
     * Write callback implementation
     *
     * Called by WASM's send() when PostgreSQL has result data.
     * Copies data from WASM memory, parses protocol messages.
     */
    pglite_js_write: (bufferPtr: number, length: number): number => {
      if (!module) {
        log('pglite_js_write called before module set')
        return 0
      }

      // Get bytes from WASM memory
      const bytes = module.HEAPU8.subarray(bufferPtr, bufferPtr + length)

      // Parse protocol messages
      protocolParser.parse(bytes, (msg) => {
        messages.push(msg)
        if (onMessage) {
          onMessage(msg)
        }
      })

      // Store raw bytes if requested
      if (keepRawResponse) {
        ensureOutputCapacity(length)
        outputBuffer.set(bytes, outputOffset)
        outputOffset += length
      }

      totalBytesWritten += length

      log(`Wrote ${length} bytes (offset: ${outputOffset}, total: ${totalBytesWritten})`)

      return length
    }
  }

  // ========================================================================
  // HANDLER INTERFACE
  // ========================================================================

  return {
    imports,

    setModule(mod: WasmModule) {
      module = mod
      log('Module set')
    },

    setInput(data: Uint8Array) {
      inputBuffer = data
      inputOffset = 0
      log(`Input set: ${data.length} bytes`)
    },

    getOutput(): Uint8Array {
      if (outputOffset === 0) {
        return new Uint8Array(0)
      }
      return outputBuffer.subarray(0, outputOffset)
    },

    getMessages(): BackendMessage[] {
      return messages
    },

    reset() {
      inputBuffer = undefined
      inputOffset = 0
      outputOffset = 0
      messages = []

      // Reset output buffer to default size if it grew
      if (outputBuffer.length !== defaultBufferSize) {
        outputBuffer = new Uint8Array(defaultBufferSize)
      }

      log('State reset')
    },

    setKeepRawResponse(keep: boolean) {
      keepRawResponse = keep
    },

    getReadOffset: () => inputOffset,
    getWriteOffset: () => outputOffset,
    getTotalBytesRead: () => totalBytesRead,
    getTotalBytesWritten: () => totalBytesWritten
  }
}

// ============================================================================
// INSTANTIATION HELPERS
// ============================================================================

/**
 * Instantiate WASM module with PGlite imports
 *
 * Merges the PGlite import functions into Emscripten's imports
 * and instantiates the module.
 *
 * @param emscriptenImports - Imports from Emscripten
 * @param handler - PGlite imports handler
 * @param wasmModule - Pre-compiled WASM module
 * @returns Instantiated WASM instance and module
 */
export async function instantiateWasmWithImports(
  emscriptenImports: WebAssembly.Imports,
  handler: PGliteWasmImportsHandler,
  wasmModule: WebAssembly.Module
): Promise<{ instance: WebAssembly.Instance; module: WebAssembly.Module }> {
  // Merge our imports with Emscripten's
  const mergedImports: WebAssembly.Imports = {
    ...emscriptenImports,
    env: {
      ...(emscriptenImports.env as Record<string, unknown>),
      pglite_js_read: handler.imports.pglite_js_read,
      pglite_js_write: handler.imports.pglite_js_write
    }
  }

  const instance = await WebAssembly.instantiate(wasmModule, mergedImports)

  return { instance, module: wasmModule }
}

/**
 * Instantiate WASM from URL with PGlite imports
 *
 * Fetches the WASM module and instantiates it with PGlite imports.
 * For use in browser environments where streaming instantiation is available.
 *
 * @param wasmUrl - URL to the WASM module
 * @param emscriptenImports - Imports from Emscripten
 * @param handler - PGlite imports handler
 * @returns Instantiated WASM instance and module
 */
export async function instantiateWasmStreamingWithImports(
  wasmUrl: string | URL,
  emscriptenImports: WebAssembly.Imports,
  handler: PGliteWasmImportsHandler
): Promise<{ instance: WebAssembly.Instance; module: WebAssembly.Module }> {
  const mergedImports: WebAssembly.Imports = {
    ...emscriptenImports,
    env: {
      ...(emscriptenImports.env as Record<string, unknown>),
      pglite_js_read: handler.imports.pglite_js_read,
      pglite_js_write: handler.imports.pglite_js_write
    }
  }

  const { instance, module } = await WebAssembly.instantiateStreaming(
    fetch(wasmUrl),
    mergedImports
  )

  return { instance, module }
}

// ============================================================================
// COMPATIBILITY LAYER
// ============================================================================

/**
 * Check if WASM module has the required import declarations
 *
 * Validates that the WASM module was compiled with the WASM imports approach
 * by checking for the expected import entries.
 *
 * @param wasmModule - Compiled WASM module to check
 * @returns True if module expects pglite_js_read and pglite_js_write imports
 */
export function hasWasmImportsDeclarations(wasmModule: WebAssembly.Module): boolean {
  try {
    const imports = WebAssembly.Module.imports(wasmModule)
    const hasRead = imports.some(
      i => i.module === 'env' && i.name === 'pglite_js_read' && i.kind === 'function'
    )
    const hasWrite = imports.some(
      i => i.module === 'env' && i.name === 'pglite_js_write' && i.kind === 'function'
    )
    return hasRead && hasWrite
  } catch {
    return false
  }
}

/**
 * Get information about WASM module imports
 *
 * Returns details about what imports the WASM module expects.
 * Useful for debugging and validating the build.
 *
 * @param wasmModule - Compiled WASM module to inspect
 * @returns Array of import descriptors
 */
export function getWasmImports(
  wasmModule: WebAssembly.Module
): WebAssembly.ModuleImportDescriptor[] {
  return WebAssembly.Module.imports(wasmModule)
}
