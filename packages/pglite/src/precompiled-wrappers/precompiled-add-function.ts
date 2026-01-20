/**
 * Pre-compiled addFunction Implementation
 *
 * This module provides an alternative to Emscripten's addFunction that
 * works in environments that block runtime WASM compilation (like Cloudflare Workers).
 *
 * Instead of generating WASM bytecode at runtime, we:
 * 1. Ship pre-compiled wrapper modules for each signature
 * 2. At runtime, instantiate these modules with the JS callback
 * 3. Get the wrapper function from the instantiated module
 * 4. Add it to the WASM function table
 *
 * This is a drop-in replacement for mod.addFunction().
 */

import type { PostgresMod } from '../postgresMod';

// Pre-compiled wrapper modules as base64 (generated at build time)
// These are tiny WASM modules (~49 bytes each) that wrap JS functions
export const PRECOMPILED_WRAPPERS: Record<string, string> = {
  // 'iii' = int(int, int) - used for read/write callbacks in PGlite
  // Module structure:
  //   - Imports: (import "e" "f" (func (param i32 i32) (result i32)))
  //   - Exports: (export "f" (func $wrapper))
  //   - $wrapper: calls the import with both params and returns result
  'iii': 'AGFzbQEAAAABBwFgAn9/AX8CBwEBZQFmAAADAgEABwUBAWYAAQoKAQgAIAAgARAACw==',
};

/**
 * Decode a base64 string to Uint8Array
 */
function decodeBase64(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } else {
    // Node.js environment
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
}

/**
 * Cache for compiled WASM modules (one per signature)
 * WebAssembly.Module compilation is allowed - it's the bytecode generation that's blocked
 */
const moduleCache = new Map<string, WebAssembly.Module>();

/**
 * Get or compile a pre-compiled wrapper module
 */
async function getWrapperModule(signature: string): Promise<WebAssembly.Module> {
  let module = moduleCache.get(signature);
  if (!module) {
    const base64 = PRECOMPILED_WRAPPERS[signature];
    if (!base64) {
      throw new Error(`No pre-compiled wrapper for signature: ${signature}. ` +
        `Available signatures: ${Object.keys(PRECOMPILED_WRAPPERS).join(', ')}`);
    }
    const bytes = decodeBase64(base64);
    module = await WebAssembly.compile(bytes.buffer as ArrayBuffer);
    moduleCache.set(signature, module);
  }
  return module;
}

/**
 * Synchronous version for environments that need it
 */
function getWrapperModuleSync(signature: string): WebAssembly.Module {
  let module = moduleCache.get(signature);
  if (!module) {
    const base64 = PRECOMPILED_WRAPPERS[signature];
    if (!base64) {
      throw new Error(`No pre-compiled wrapper for signature: ${signature}. ` +
        `Available signatures: ${Object.keys(PRECOMPILED_WRAPPERS).join(', ')}`);
    }
    const bytes = decodeBase64(base64);
    module = new WebAssembly.Module(bytes.buffer as ArrayBuffer);
    moduleCache.set(signature, module);
  }
  return module;
}

/**
 * Track allocated function table slots for cleanup
 */
const allocatedSlots = new Map<number, WebAssembly.Instance>();

/**
 * Find a free slot in the WASM function table
 */
function findFreeTableSlot(table: WebAssembly.Table): number {
  // Strategy: Look for null slots in the table, or grow it
  const length = table.length;

  // First, look for an empty slot
  for (let i = 0; i < length; i++) {
    try {
      const func = table.get(i);
      if (func === null) {
        return i;
      }
    } catch {
      // Some slots may be unreadable, skip them
    }
  }

  // No empty slot found - grow the table
  // This requires ALLOW_TABLE_GROWTH in Emscripten build
  try {
    const oldLength = table.grow(1);
    return oldLength;
  } catch (e) {
    throw new Error(
      'Cannot find free slot in WASM function table and table growth is disabled. ' +
      'Build with -sALLOW_TABLE_GROWTH or reserve slots at compile time.'
    );
  }
}

/**
 * Pre-compiled addFunction - drops in for mod.addFunction()
 *
 * @param mod The Emscripten module
 * @param callback The JavaScript function to wrap
 * @param signature The function signature (e.g., 'iii')
 * @returns Function pointer (table index) that can be passed to C code
 */
export async function precompiledAddFunction(
  mod: PostgresMod,
  callback: (...args: any[]) => any,
  signature: string
): Promise<number> {
  // Get the pre-compiled wrapper module
  const wrapperModule = await getWrapperModule(signature);

  // Instantiate the wrapper with our JS callback as the import
  const imports = {
    e: { f: callback }
  };
  const instance = await WebAssembly.instantiate(wrapperModule, imports);

  // Get the wrapper function from the instance
  const wrapperFunc = instance.exports.f as WebAssembly.Global;

  // Get the main module's function table
  const table = mod.wasmTable;
  if (!table) {
    throw new Error('Module does not expose wasmTable. Build with -sEXPORTED_RUNTIME_METHODS=wasmTable');
  }

  // Find a free slot and add the wrapper
  const slot = findFreeTableSlot(table);
  table.set(slot, wrapperFunc);

  // Track the instance for cleanup
  allocatedSlots.set(slot, instance);

  return slot;
}

/**
 * Synchronous version of precompiledAddFunction
 */
export function precompiledAddFunctionSync(
  mod: PostgresMod,
  callback: (...args: any[]) => any,
  signature: string
): number {
  // Get the pre-compiled wrapper module
  const wrapperModule = getWrapperModuleSync(signature);

  // Instantiate the wrapper with our JS callback as the import
  const imports = {
    e: { f: callback }
  };
  const instance = new WebAssembly.Instance(wrapperModule, imports);

  // Get the wrapper function from the instance
  const wrapperFunc = instance.exports.f as WebAssembly.Global;

  // Get the main module's function table
  const table = mod.wasmTable;
  if (!table) {
    throw new Error('Module does not expose wasmTable. Build with -sEXPORTED_RUNTIME_METHODS=wasmTable');
  }

  // Find a free slot and add the wrapper
  const slot = findFreeTableSlot(table);
  table.set(slot, wrapperFunc);

  // Track the instance for cleanup
  allocatedSlots.set(slot, instance);

  return slot;
}

/**
 * Remove a function from the table (equivalent to mod.removeFunction)
 */
export function precompiledRemoveFunction(
  mod: PostgresMod,
  funcPtr: number
): void {
  const table = mod.wasmTable;
  if (!table) {
    throw new Error('Module does not expose wasmTable');
  }

  // Clear the slot
  try {
    table.set(funcPtr, null);
  } catch {
    // Some tables don't allow setting null, ignore
  }

  // Clean up our tracking
  allocatedSlots.delete(funcPtr);
}

/**
 * Create a drop-in replacement for mod.addFunction
 * This can be used to monkey-patch the module
 */
export function createAddFunctionReplacement(mod: PostgresMod) {
  return function addFunction(
    callback: (...args: any[]) => any,
    signature: string
  ): number {
    return precompiledAddFunctionSync(mod, callback, signature);
  };
}

/**
 * Patch a PostgresMod to use pre-compiled addFunction
 * Call this before any code uses mod.addFunction()
 */
export function patchModule(mod: PostgresMod): void {
  (mod as any).addFunction = createAddFunctionReplacement(mod);
  (mod as any).removeFunction = (funcPtr: number) => precompiledRemoveFunction(mod, funcPtr);
}
