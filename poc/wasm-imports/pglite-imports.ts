/**
 * PGlite WASM Imports POC
 *
 * This module demonstrates how to provide PGlite's read/write callbacks as
 * WASM imports instead of using Emscripten's addFunction (which requires
 * runtime WASM code generation and is blocked in Cloudflare Workers).
 *
 * KEY CONCEPT: WASM imports are functions declared in the WASM module that
 * must be provided by the host environment (JavaScript) at instantiation time.
 * Unlike addFunction, this doesn't require any runtime code generation.
 *
 * USAGE:
 *   1. Import createPGliteImportHandler from this module
 *   2. Create a handler: const handler = createPGliteImportHandler()
 *   3. Pass handler.imports to WebAssembly.instantiate via instantiateWasm
 *   4. Before queries: handler.setInput(queryBytes)
 *   5. After queries: handler.getOutput() returns result bytes
 *
 * @module pglite-imports
 */

/**
 * WASM import function signatures
 *
 * These match the C declarations in pglite-comm-imports.h:
 *   extern ssize_t pglite_js_read(void *buffer, size_t max_length);
 *   extern ssize_t pglite_js_write(void *buffer, size_t length);
 */
export interface PGliteWasmImports {
  /**
   * Read callback - WASM calls this to get data from JavaScript
   *
   * @param bufferPtr - Pointer to WASM memory where data should be written
   * @param maxLength - Maximum bytes to read
   * @returns Number of bytes actually read
   */
  pglite_js_read: (bufferPtr: number, maxLength: number) => number

  /**
   * Write callback - WASM calls this to send data to JavaScript
   *
   * @param bufferPtr - Pointer to WASM memory containing data to send
   * @param length - Number of bytes to write
   * @returns Number of bytes actually written
   */
  pglite_js_write: (bufferPtr: number, length: number) => number
}

/**
 * Interface for accessing WASM memory
 * This is a subset of the Emscripten module interface we need
 */
export interface WasmMemory {
  /** WASM heap as Uint8Array view */
  HEAPU8: Uint8Array
}

/**
 * Handler for PGlite WASM imports
 *
 * This object manages the callback state and provides the import functions
 * that will be bound to the WASM module at instantiation time.
 */
export interface PGliteImportHandler {
  /**
   * The import functions to provide to WebAssembly.instantiate
   *
   * Add these to your imports object under the "env" namespace:
   * ```
   * const imports = {
   *   env: {
   *     ...otherImports,
   *     ...handler.imports
   *   }
   * }
   * ```
   */
  imports: PGliteWasmImports

  /**
   * Set the WASM module reference
   *
   * Must be called after instantiation to allow imports to access WASM memory.
   * The module is not available until instantiation completes, but imports
   * need it to read/write memory. This circular dependency is handled by
   * having imports check for the module being set.
   *
   * @param mod - The instantiated Emscripten module
   */
  setModule: (mod: WasmMemory) => void

  /**
   * Set the input data for the next query
   *
   * Call this BEFORE executing a query via _interactive_one.
   * The import functions will read from this buffer when WASM calls recv().
   *
   * @param data - Query input bytes (PostgreSQL wire protocol)
   */
  setInput: (data: Uint8Array) => void

  /**
   * Get the output data from the last query
   *
   * Call this AFTER executing a query via _interactive_one.
   * Returns all data that WASM wrote via send().
   *
   * @returns Array of output chunks (can be concatenated for full output)
   */
  getOutput: () => Uint8Array[]

  /**
   * Reset state for the next query
   *
   * Clears input buffer, read position, and output chunks.
   */
  reset: () => void

  /**
   * Get current read position (for debugging)
   */
  getReadPosition: () => number

  /**
   * Get total bytes read (for debugging)
   */
  getTotalBytesRead: () => number

  /**
   * Get total bytes written (for debugging)
   */
  getTotalBytesWritten: () => number
}

/**
 * Creates a PGlite import handler
 *
 * This factory function creates the import functions and state management
 * needed to handle PGlite's read/write callbacks via WASM imports.
 *
 * @example
 * ```typescript
 * const handler = createPGliteImportHandler()
 *
 * // Instantiate WASM with imports
 * const mod = await PostgresModFactory({
 *   instantiateWasm: (imports, callback) => {
 *     const merged = {
 *       ...imports,
 *       env: { ...imports.env, ...handler.imports }
 *     }
 *     WebAssembly.instantiate(wasmModule, merged)
 *       .then(instance => callback(instance, wasmModule))
 *     return {}
 *   }
 * })
 *
 * // Set module reference after instantiation
 * handler.setModule(mod)
 *
 * // Execute query
 * handler.setInput(queryBytes)
 * mod._interactive_one(queryBytes.length, queryBytes[0])
 * const results = handler.getOutput()
 * handler.reset()
 * ```
 *
 * @returns PGliteImportHandler instance
 */
export function createPGliteImportHandler(): PGliteImportHandler {
  // ============================================================================
  // STATE
  // ============================================================================

  /** Reference to WASM module (set after instantiation) */
  let module: WasmMemory | undefined

  /** Input buffer for current query */
  let inputBuffer: Uint8Array | undefined

  /** Current read position in input buffer */
  let inputOffset = 0

  /** Output chunks from current query */
  let outputChunks: Uint8Array[] = []

  /** Debug counters */
  let totalBytesRead = 0
  let totalBytesWritten = 0

  // ============================================================================
  // IMPORT FUNCTIONS
  // ============================================================================

  const imports: PGliteWasmImports = {
    /**
     * Read callback implementation
     *
     * Called by WASM's recv() when PostgreSQL needs query input.
     * Copies data from our inputBuffer into WASM memory.
     */
    pglite_js_read: (bufferPtr: number, maxLength: number): number => {
      // Check module is set
      if (!module) {
        console.warn('pglite_js_read called before module set')
        return 0
      }

      // Check we have input data
      if (!inputBuffer) {
        return 0
      }

      // Calculate available bytes
      const available = inputBuffer.length - inputOffset
      if (available === 0) {
        return 0
      }

      // Determine how much to read
      const length = Math.min(available, maxLength)

      // Copy data to WASM memory
      module.HEAPU8.set(
        inputBuffer.subarray(inputOffset, inputOffset + length),
        bufferPtr
      )

      // Update position
      inputOffset += length
      totalBytesRead += length

      return length
    },

    /**
     * Write callback implementation
     *
     * Called by WASM's send() when PostgreSQL has result data.
     * Copies data from WASM memory into our outputChunks array.
     */
    pglite_js_write: (bufferPtr: number, length: number): number => {
      // Check module is set
      if (!module) {
        console.warn('pglite_js_write called before module set')
        return 0
      }

      // Copy data from WASM memory (slice creates a copy)
      const bytes = module.HEAPU8.slice(bufferPtr, bufferPtr + length)
      outputChunks.push(bytes)

      // Update counter
      totalBytesWritten += length

      return length
    }
  }

  // ============================================================================
  // HANDLER INTERFACE
  // ============================================================================

  return {
    imports,

    setModule: (mod: WasmMemory) => {
      module = mod
    },

    setInput: (data: Uint8Array) => {
      inputBuffer = data
      inputOffset = 0
    },

    getOutput: () => outputChunks,

    reset: () => {
      inputBuffer = undefined
      inputOffset = 0
      outputChunks = []
    },

    getReadPosition: () => inputOffset,
    getTotalBytesRead: () => totalBytesRead,
    getTotalBytesWritten: () => totalBytesWritten
  }
}

/**
 * Merges PGlite imports into Emscripten's import object
 *
 * Helper function to properly merge the import functions into
 * Emscripten's import structure.
 *
 * @param emscriptenImports - Original imports from Emscripten
 * @param pgliteImports - PGlite import functions
 * @returns Merged imports object
 */
export function mergePGliteImports(
  emscriptenImports: WebAssembly.Imports,
  pgliteImports: PGliteWasmImports
): WebAssembly.Imports {
  return {
    ...emscriptenImports,
    env: {
      ...(emscriptenImports.env as Record<string, unknown>),
      pglite_js_read: pgliteImports.pglite_js_read,
      pglite_js_write: pgliteImports.pglite_js_write
    }
  }
}

/**
 * Type guard to check if an object has WASM memory interface
 *
 * @param obj - Object to check
 * @returns True if object has HEAPU8 property
 */
export function hasWasmMemory(obj: unknown): obj is WasmMemory {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'HEAPU8' in obj &&
    obj.HEAPU8 instanceof Uint8Array
  )
}
