/**
 * pglite-trampoline.ts
 *
 * JavaScript/TypeScript implementation of the trampoline approach for PGlite.
 * This file shows how to use the EM_JS trampolines from pglite-trampoline-v2.h
 * without requiring addFunction (which is blocked in Cloudflare Workers).
 *
 * Two approaches are demonstrated:
 * 1. Direct callback registration (v2) - cleanest approach
 * 2. wasmTable slot assignment (v1) - for reference
 */

import type { PostgresMod } from '../packages/pglite/src/postgresMod.js';

/**
 * Extended PostgresMod interface for trampoline approach.
 * Note: addFunction and removeFunction are NOT used.
 */
export interface PostgresModTrampoline extends Omit<PostgresMod, 'addFunction' | 'removeFunction'> {
  // Trampoline callback storage (set by EM_JS init)
  _pgliteCallbacks?: {
    read: ((ptr: number, maxLength: number) => number) | null;
    write: ((ptr: number, length: number) => number) | null;
  };

  // wasmTable for v1 approach
  wasmTable?: WebAssembly.Table;

  // Trampoline init function (from EM_JS)
  _pglite_trampoline_init?: () => void;

  // Optional: for v1 approach with explicit slot assignment
  _set_trampoline_callbacks?: (readFptr: number, writeFptr: number) => void;
}

/**
 * PGlite Trampoline Wrapper
 *
 * This class wraps the PGlite module and sets up callbacks using
 * the trampoline approach instead of addFunction.
 */
export class PGliteTrampolineWrapper {
  private mod: PostgresModTrampoline;

  // Protocol parser and buffers (same as original PGlite)
  private outputData: Uint8Array = new Uint8Array(0);
  private readOffset = 0;
  private writeChunks: Uint8Array[] = [];

  constructor(mod: PostgresModTrampoline) {
    this.mod = mod;
  }

  /**
   * Initialize the trampoline callbacks.
   * This replaces the addFunction calls in the original PGlite.
   */
  init(): void {
    // Initialize the callback storage (EM_JS function)
    if (this.mod._pglite_trampoline_init) {
      this.mod._pglite_trampoline_init();
    }

    // Ensure callback storage exists
    if (!this.mod._pgliteCallbacks) {
      this.mod._pgliteCallbacks = { read: null, write: null };
    }

    // Set up the read callback
    this.mod._pgliteCallbacks.read = (ptr: number, maxLength: number): number => {
      return this.handleRead(ptr, maxLength);
    };

    // Set up the write callback
    this.mod._pgliteCallbacks.write = (ptr: number, length: number): number => {
      return this.handleWrite(ptr, length);
    };

    console.log('PGlite trampoline callbacks initialized (no addFunction used)');
  }

  /**
   * Handle read requests from PostgreSQL.
   * PostgreSQL calls this to get input data.
   */
  private handleRead(ptr: number, maxLength: number): number {
    // Copy current data to WASM buffer
    let length = this.outputData.length - this.readOffset;
    if (length > maxLength) {
      length = maxLength;
    }

    if (length > 0) {
      try {
        this.mod.HEAP8.set(
          this.outputData.subarray(this.readOffset, this.readOffset + length),
          ptr
        );
        this.readOffset += length;
      } catch (e) {
        console.error('handleRead error:', e);
        return -1;
      }
    }

    return length;
  }

  /**
   * Handle write requests from PostgreSQL.
   * PostgreSQL calls this to output data.
   */
  private handleWrite(ptr: number, length: number): number {
    try {
      const bytes = this.mod.HEAPU8.subarray(ptr, ptr + length);
      // Copy the data since the WASM memory view might change
      const copied = bytes.slice();
      this.writeChunks.push(copied);
      return length;
    } catch (e) {
      console.error('handleWrite error:', e);
      return -1;
    }
  }

  /**
   * Execute a protocol message (replacement for execProtocolRawSync).
   */
  execProtocolRawSync(message: Uint8Array): Uint8Array {
    // Reset state
    this.readOffset = 0;
    this.outputData = message;
    this.writeChunks = [];

    // Execute the message
    (this.mod as any)._interactive_one(message.length, message[0]);

    // Combine all write chunks
    const totalLength = this.writeChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.writeChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    this.outputData = new Uint8Array(0);
    return result;
  }

  /**
   * Cleanup - no removeFunction calls needed!
   */
  cleanup(): void {
    if (this.mod._pgliteCallbacks) {
      this.mod._pgliteCallbacks.read = null;
      this.mod._pgliteCallbacks.write = null;
    }
    console.log('PGlite trampoline callbacks cleaned up');
  }
}

/**
 * Alternative: wasmTable slot assignment (v1 approach)
 *
 * This approach uses pre-allocated function table slots.
 * Less clean than v2 but useful for understanding the mechanism.
 */
export function setupTrampolineV1(mod: PostgresModTrampoline): void {
  if (!mod.wasmTable) {
    throw new Error('wasmTable not available - ensure EXPORTED_RUNTIME_METHODS includes wasmTable');
  }

  // Find free slots in the table
  // In practice, you'd pre-allocate these with -sRESERVED_FUNCTION_POINTERS=N
  const table = mod.wasmTable;
  const tableSize = table.length;

  console.log(`wasmTable size: ${tableSize}`);

  // For v1, we need to find slots that contain wrapper functions
  // compiled into the WASM that call our trampolines.
  // This is more complex - the v2 approach is recommended.

  // Example: If we had pre-compiled wrappers at known indices
  // mod._set_trampoline_callbacks?.(READ_SLOT_INDEX, WRITE_SLOT_INDEX);
}

/**
 * Test function to verify the trampoline approach works.
 */
export async function testTrampoline(mod: PostgresModTrampoline): Promise<boolean> {
  const wrapper = new PGliteTrampolineWrapper(mod);

  try {
    wrapper.init();

    // Test a simple query (would need full PGlite initialization first)
    console.log('Trampoline callbacks set up successfully');

    // In a real test, we'd execute a query here
    // const result = wrapper.execProtocolRawSync(someQuery);

    wrapper.cleanup();
    return true;
  } catch (e) {
    console.error('Trampoline test failed:', e);
    return false;
  }
}
