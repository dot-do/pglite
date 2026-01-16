/**
 * PGlite with WASM Imports
 *
 * This is a modified version of pglite.ts that demonstrates how to use
 * the WASM imports approach instead of addFunction for Cloudflare Workers
 * compatibility.
 *
 * KEY CHANGES FROM ORIGINAL:
 *
 * 1. REMOVED: addFunction/removeFunction calls
 *    - No longer need: mod.addFunction(callback, 'iii')
 *    - No longer need: mod._set_read_write_cbs()
 *    - No longer need: patchModule() for pre-compiled wrappers
 *
 * 2. ADDED: WASM imports via instantiateWasm
 *    - Import handler created before module instantiation
 *    - Imports merged into Emscripten's imports in instantiateWasm
 *    - Module reference set after instantiation
 *
 * 3. SIMPLIFIED: Callback management
 *    - No function pointers to track
 *    - No cleanup needed on close
 *    - Import functions use closure state
 *
 * REQUIREMENTS:
 *
 * This approach requires a rebuilt PGlite WASM module with the following changes:
 * 1. Replace pglite-comm.h with pglite-comm-imports.h
 * 2. Remove ALLOW_TABLE_GROWTH from Emscripten build flags
 * 3. Remove addFunction/removeFunction from EXPORTED_RUNTIME_METHODS
 *
 * @module pglite-with-imports
 */

import { Mutex } from 'async-mutex'
import { Parser as ProtocolParser, serialize } from '@electric-sql/pg-protocol'
import type {
  BackendMessage,
  CommandCompleteMessage,
  DatabaseError,
  NoticeMessage,
  NotificationResponseMessage,
} from '@electric-sql/pg-protocol/messages'

import {
  createPGliteWasmImports,
  instantiateWasmWithImports,
  type PGliteWasmImportsHandler
} from './pglite-wasm-imports'

/**
 * Minimal PostgresMod interface for demonstration
 */
interface PostgresModWasmImports {
  HEAPU8: Uint8Array
  HEAP8: Int8Array
  FS: any
  _pgl_initdb: () => number
  _pgl_backend: () => void
  _pgl_shutdown: () => void
  _interactive_one: (length: number, peek: number) => void

  // NOTE: These are NOT needed with WASM imports approach:
  // _set_read_write_cbs: (read_cb: number, write_cb: number) => void
  // addFunction: (cb: Function, signature: string) => number
  // removeFunction: (f: number) => void
}

/**
 * Minimal options interface for demonstration
 */
interface PGliteOptionsWasmImports {
  wasmModule?: WebAssembly.Module
  fsBundle?: Blob
  debug?: number
}

/**
 * Demonstrates how to initialize PGlite using WASM imports
 *
 * This is a simplified version showing only the initialization flow.
 * A full implementation would include all PGlite features.
 */
export async function createPGliteWithWasmImports(
  options: PGliteOptionsWasmImports = {}
): Promise<{
  mod: PostgresModWasmImports
  importsHandler: PGliteWasmImportsHandler
  execProtocolRawSync: (message: Uint8Array) => Uint8Array
}> {
  // ========================================================================
  // STEP 1: Create WASM imports handler BEFORE module instantiation
  // ========================================================================

  const importsHandler = createPGliteWasmImports({
    debug: (options.debug ?? 0) > 0,
    onMessage: (msg) => {
      // Optional: Handle messages as they arrive
      // This is called during the write callback
    }
  })

  // ========================================================================
  // STEP 2: Configure Emscripten options with custom instantiateWasm
  // ========================================================================

  const emscriptenOpts: any = {
    // ... other Emscripten options ...

    /**
     * Custom WASM instantiation that includes our imports
     *
     * This is the key integration point. We intercept Emscripten's
     * WASM instantiation and merge our import functions before
     * instantiating the module.
     */
    instantiateWasm: (
      emscriptenImports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ) => {
      if (!options.wasmModule) {
        throw new Error(
          'wasmModule is required for WASM imports approach. ' +
          'In Cloudflare Workers, import the WASM module and pass it as wasmModule option.'
        )
      }

      // Instantiate with merged imports
      instantiateWasmWithImports(
        emscriptenImports,
        importsHandler,
        options.wasmModule
      ).then(({ instance, module }) => {
        successCallback(instance, module)
      })

      // Return empty object - actual instance provided via callback
      return {}
    }
  }

  // ========================================================================
  // STEP 3: Load the module using PostgresModFactory
  // ========================================================================

  // In actual implementation, this would be:
  // const mod = await PostgresModFactory(emscriptenOpts)

  // For demonstration, we'll show what the module would look like:
  const mod = await loadModulePlaceholder(emscriptenOpts)

  // ========================================================================
  // STEP 4: Set module reference AFTER instantiation
  // ========================================================================

  // This must be done after the module is instantiated because
  // the imports need access to WASM memory (HEAPU8).
  importsHandler.setModule(mod)

  // ========================================================================
  // STEP 5: NO addFunction calls needed!
  // ========================================================================

  // ORIGINAL CODE (removed):
  // this.#pglite_write = this.mod.addFunction((ptr, length) => { ... }, 'iii')
  // this.#pglite_read = this.mod.addFunction((ptr, max_length) => { ... }, 'iii')
  // this.mod._set_read_write_cbs(this.#pglite_read, this.#pglite_write)

  // With WASM imports, the callbacks are already bound during instantiation!
  // recv() and send() in the C code directly call our imported functions.

  // ========================================================================
  // STEP 6: Return module with query execution helper
  // ========================================================================

  return {
    mod,
    importsHandler,

    /**
     * Execute PostgreSQL wire protocol message synchronously
     *
     * This replaces execProtocolRawSync in the original pglite.ts.
     * Note how simple it is - no function pointer management needed.
     */
    execProtocolRawSync(message: Uint8Array): Uint8Array {
      // Reset state for new query
      importsHandler.reset()

      // Set input data
      importsHandler.setInput(message)

      // Execute - WASM will call our imports directly
      mod._interactive_one(message.length, message[0])

      // Return raw output
      return importsHandler.getOutput()
    }
  }
}

/**
 * Demonstrates the close sequence with WASM imports
 *
 * Note how much simpler this is - no function pointer cleanup needed.
 */
export async function closePGliteWithWasmImports(
  mod: PostgresModWasmImports,
  importsHandler: PGliteWasmImportsHandler
): Promise<void> {
  // Shutdown PostgreSQL
  mod._pgl_shutdown()

  // ORIGINAL CODE (removed):
  // if (this.#pglite_read !== -1) {
  //   this.mod.removeFunction(this.#pglite_read)
  // }
  // if (this.#pglite_write !== -1) {
  //   this.mod.removeFunction(this.#pglite_write)
  // }

  // With WASM imports, there's nothing to clean up!
  // The import functions are just JavaScript closures.
}

// ============================================================================
// PLACEHOLDER FUNCTION (for demonstration only)
// ============================================================================

async function loadModulePlaceholder(opts: any): Promise<PostgresModWasmImports> {
  // This is a placeholder. In actual implementation, you would use:
  // return await PostgresModFactory(opts)

  throw new Error(
    'This is a demonstration file. To use WASM imports, you need to:\n' +
    '1. Rebuild PGlite WASM with pglite-comm-imports.h\n' +
    '2. Import the actual PostgresModFactory and built WASM module'
  )
}

// ============================================================================
// EXAMPLE: How the main init function would look in actual pglite.ts
// ============================================================================

/**
 * Example init function showing WASM imports integration in context
 *
 * This shows how #init() in pglite.ts would be modified.
 * Key changes are marked with "WASM IMPORTS:" comments.
 */
async function exampleInit(options: PGliteOptionsWasmImports): Promise<void> {
  // WASM IMPORTS: Create handler BEFORE module instantiation
  const importsHandler = createPGliteWasmImports()

  const emscriptenOpts: any = {
    // ... other options ...

    // WASM IMPORTS: Custom instantiateWasm with our imports
    instantiateWasm: (
      imports: WebAssembly.Imports,
      callback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ) => {
      instantiateWasmWithImports(imports, importsHandler, options.wasmModule!)
        .then(({ instance, module }) => callback(instance, module))
      return {}
    }
  }

  // Load module (this would use PostgresModFactory)
  // const mod = await PostgresModFactory(emscriptenOpts)

  // WASM IMPORTS: Set module reference AFTER instantiation
  // importsHandler.setModule(mod)

  // WASM IMPORTS: NO addFunction calls!
  // REMOVED: this.#pglite_write = this.mod.addFunction(...)
  // REMOVED: this.#pglite_read = this.mod.addFunction(...)
  // REMOVED: this.mod._set_read_write_cbs(...)

  // Initialize database
  // const idb = mod._pgl_initdb()
  // mod._pgl_backend()

  // The rest of initialization is unchanged...
}

// ============================================================================
// EXAMPLE: How execProtocolRawSync would look
// ============================================================================

/**
 * Example showing how execProtocolRawSync would work with WASM imports
 *
 * The key difference: no #pglite_read/#pglite_write management
 */
function exampleExecProtocolRawSync(
  mod: PostgresModWasmImports,
  importsHandler: PGliteWasmImportsHandler,
  message: Uint8Array
): Uint8Array {
  // Reset for new query
  importsHandler.reset()

  // Set input (replaces #outputData and #readOffset management)
  importsHandler.setInput(message)

  // Execute - recv/send will use our imports
  mod._interactive_one(message.length, message[0])

  // Get output (replaces #inputData and #writeOffset management)
  return importsHandler.getOutput()
}
