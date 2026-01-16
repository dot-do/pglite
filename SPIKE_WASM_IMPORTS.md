# SPIKE 5: WASM Imports Instead of addFunction

**Date**: 2026-01-15
**Status**: POC COMPLETE
**Project**: Native Iceberg TS Module for Cloudflare Workers

---

## Executive Summary

This spike investigates using WASM imports to define PGlite's read/write callbacks at module instantiation time, eliminating the need for `addFunction` which requires runtime WASM compilation (blocked in Cloudflare Workers).

**Key Finding**: WASM imports are the **cleanest architectural solution** for Cloudflare Workers compatibility. By declaring JavaScript functions as imports in the C code, they become available immediately when the WASM module instantiates - no function table growth or dynamic code generation required.

**Recommendation**: This approach requires C-level modifications but provides a fundamentally correct solution that aligns with WebAssembly's import/export model.

---

## Table of Contents

1. [Background](#background)
2. [Current Architecture](#current-architecture)
3. [WASM Imports Approach](#wasm-imports-approach)
4. [Implementation Design](#implementation-design)
5. [Emscripten Build Changes](#emscripten-build-changes)
6. [JavaScript Integration](#javascript-integration)
7. [Minimal POC](#minimal-poc)
8. [Migration Path](#migration-path)
9. [Tradeoffs and Considerations](#tradeoffs-and-considerations)

---

## Background

### The Problem

PGlite currently uses Emscripten's `addFunction` to dynamically create JavaScript callbacks that PostgreSQL's C code can invoke:

```typescript
// Current approach - BLOCKED in Cloudflare Workers
this.#pglite_write = this.mod.addFunction((ptr: any, length: number) => {
  // callback implementation
}, 'iii')

this.mod._set_read_write_cbs(this.#pglite_read, this.#pglite_write)
```

This fails in Cloudflare Workers with:
```
Error: WebAssembly.Module(): Wasm code generation disallowed by embedder
```

### Why WASM Imports?

WASM modules can declare functions they **import** from the host environment. These imports are provided at instantiation time - before any WASM code runs. This is fundamentally different from `addFunction`:

| Approach | When Defined | Requires Code Gen | Workers Compatible |
|----------|--------------|-------------------|-------------------|
| `addFunction` | Runtime | Yes | No |
| WASM Imports | Instantiation | No | **Yes** |

---

## Current Architecture

### Flow Diagram

```
JavaScript                              WASM (C)
-----------                             --------

PostgresModFactory()
    |
    +---> WebAssembly.instantiate(wasmBytes, imports)
              |
              +---> Module initialized
                        |
    <-------------------+
    |
mod.addFunction(readCallback, 'iii')  <--- RUNTIME WASM CODE GEN!
mod.addFunction(writeCallback, 'iii') <--- RUNTIME WASM CODE GEN!
    |
    +---> mod._set_read_write_cbs(read, write)
              |
              +---> pglite_read = read_cb   // Store function pointers
              |     pglite_write = write_cb
              |
              +---> recv() calls pglite_read()
                    send() calls pglite_write()
```

### Current C Code (pglite-comm.h)

```c
// Function pointer types
typedef ssize_t (*pglite_read_t)(void *buffer, size_t max_length);
typedef ssize_t (*pglite_write_t)(void *buffer, size_t length);

// Global function pointers - set at runtime
pglite_read_t pglite_read;
pglite_write_t pglite_write;

// Registration function called from JavaScript
__attribute__((export_name("set_read_write_cbs")))
void set_read_write_cbs(pglite_read_t read_cb, pglite_write_t write_cb) {
    pglite_read = read_cb;
    pglite_write = write_cb;
}

// These use the function pointers
ssize_t recv(int __fd, void *__buf, size_t __n, int __flags) {
    return pglite_read(__buf, __n);
}

ssize_t send(int __fd, const void *__buf, size_t __n, int __flags) {
    return pglite_write(__buf, __n);
}
```

---

## WASM Imports Approach

### New Flow Diagram

```
JavaScript                              WASM (C)
-----------                             --------

// Define callbacks BEFORE instantiation
const imports = {
  env: {
    pglite_js_read: readCallback,    <--- No code gen!
    pglite_js_write: writeCallback   <--- No code gen!
  }
}
    |
    +---> WebAssembly.instantiate(wasmBytes, imports)
              |
              +---> Import functions bound during instantiation
              |
              +---> Module initialized with callbacks already available
              |
              +---> recv() calls pglite_js_read()  // Direct import call
                    send() calls pglite_js_write() // Direct import call
```

### Key Insight

With WASM imports, the JavaScript functions are declared as **external dependencies** of the WASM module. They must be provided at instantiation time, making them immediately available without any runtime code generation.

---

## Implementation Design

### Modified C Code (pglite-comm-imports.h)

```c
#if defined(__EMSCRIPTEN__)

#ifndef PGLITE_COMM_IMPORTS_H
#define PGLITE_COMM_IMPORTS_H

#include <emscripten/emscripten.h>

// Declare read/write as WASM imports (provided by JavaScript at instantiation)
// These are bound BEFORE any WASM code runs
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_read")))
extern ssize_t pglite_js_read(void *buffer, size_t max_length);

__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_write")))
extern ssize_t pglite_js_write(void *buffer, size_t length);

// Override socket functions to use imports directly
// No function pointers needed - direct calls to imported functions
ssize_t EMSCRIPTEN_KEEPALIVE
recv(int __fd, void *__buf, size_t __n, int __flags) {
    // Direct call to imported JavaScript function
    return pglite_js_read(__buf, __n);
}

ssize_t EMSCRIPTEN_KEEPALIVE
send(int __fd, const void *__buf, size_t __n, int __flags) {
    // Direct call to imported JavaScript function
    return pglite_js_write(__buf, __n);
}

// set_read_write_cbs is NO LONGER NEEDED
// The callbacks are provided at instantiation time

// ... rest of dummy socket functions unchanged ...
int EMSCRIPTEN_KEEPALIVE fcntl(int __fd, int __cmd, ...) { return 0; }
int EMSCRIPTEN_KEEPALIVE setsockopt(int __fd, int __level, int __optname,
    const void *__optval, socklen_t __optlen) { return 0; }
// etc.

#endif // PGLITE_COMM_IMPORTS_H
#endif // __EMSCRIPTEN__
```

### Why This Works

1. `__attribute__((import_module("env")))` - Declares the function comes from the "env" import namespace
2. `__attribute__((import_name("pglite_js_read")))` - Specifies the exact import name
3. `extern` - Tells the compiler the function is defined elsewhere (in JavaScript)
4. At compile time, Emscripten generates a WASM module that **requires** these imports
5. At instantiation time, JavaScript provides the implementations

---

## Emscripten Build Changes

### Current Build Flags (build-pglite.sh)

```bash
# Current: Enables dynamic function table growth
EXPORTED_RUNTIME_METHODS="MEMFS,IDBFS,FS,...,addFunction,removeFunction,wasmTable"
-sALLOW_TABLE_GROWTH -sALLOW_MEMORY_GROWTH
```

### New Build Flags

```bash
# Remove addFunction/removeFunction (no longer needed)
EXPORTED_RUNTIME_METHODS="MEMFS,IDBFS,FS,setValue,getValue,UTF8ToString,stringToNewUTF8,stringToUTF8OnStack"

# Remove ALLOW_TABLE_GROWTH (no longer needed for callbacks)
# Keep ALLOW_MEMORY_GROWTH for PostgreSQL's memory needs
-sALLOW_MEMORY_GROWTH

# Emscripten will automatically handle imports declared in C code
# No additional flags needed for import functions
```

### Import Validation

Emscripten validates at link time that all imports are properly declared. If the JavaScript doesn't provide a required import, instantiation fails with a clear error:

```
LinkError: WebAssembly.instantiate(): Import #0 module="env" function="pglite_js_read" error: function import requires a callable
```

---

## JavaScript Integration

### Emscripten Module Override

```typescript
// packages/pglite/src/pglite.ts

import PostgresModFactory, { type PostgresMod } from './postgresMod.js'

async #init(options: PGliteOptions) {
  // Create callback state (closure variables)
  let outputData: Uint8Array = new Uint8Array(0)
  let readOffset = 0

  // These will be set before queries
  let currentReadBuffer: Uint8Array | undefined
  let writeChunks: Uint8Array[] = []

  // Define the import functions BEFORE module instantiation
  const pgliteImports = {
    // Read callback - called by WASM to get data from JavaScript
    pglite_js_read: (bufferPtr: number, maxLength: number): number => {
      if (!currentReadBuffer) return 0

      const available = currentReadBuffer.length - readOffset
      if (available === 0) return 0

      const length = Math.min(available, maxLength)
      const mod = this.mod! // Available after instantiation
      mod.HEAPU8.set(
        currentReadBuffer.subarray(readOffset, readOffset + length),
        bufferPtr
      )
      readOffset += length
      return length
    },

    // Write callback - called by WASM to send data to JavaScript
    pglite_js_write: (bufferPtr: number, length: number): number => {
      const mod = this.mod! // Available after instantiation
      const bytes = mod.HEAPU8.subarray(bufferPtr, bufferPtr + length)

      // Parse protocol messages
      this.#protocolParser.parse(bytes, (msg) => {
        this.#parse(msg)
      })

      // Store raw response if needed
      if (this.#keepRawResponse) {
        writeChunks.push(bytes.slice())
      }

      return length
    }
  }

  // Provide imports when creating the module
  let emscriptenOpts: Partial<PostgresMod> = {
    // ... other options ...

    // Override instantiateWasm to include our imports
    instantiateWasm: (imports, successCallback) => {
      // Merge our imports with Emscripten's default imports
      const mergedImports = {
        ...imports,
        env: {
          ...imports.env,
          ...pgliteImports // Add our callback imports
        }
      }

      instantiateWasm(mergedImports, options.wasmModule).then(
        ({ instance, module }) => {
          successCallback(instance, module)
        }
      )
      return {}
    },
    // ... rest of options ...
  }

  // Module instantiation happens here - imports are bound during this call
  this.mod = await PostgresModFactory(emscriptenOpts)

  // NO LONGER NEEDED:
  // this.#pglite_read = this.mod.addFunction(...)
  // this.#pglite_write = this.mod.addFunction(...)
  // this.mod._set_read_write_cbs(...)
}

// Query execution remains the same
async execProtocol(message: Uint8Array) {
  // Set the read buffer for this query
  currentReadBuffer = message
  readOffset = 0
  writeChunks = []

  // Execute - WASM will call our imported functions directly
  this.mod._interactive_one(message.length, message[0])

  // ... process results ...
}
```

### Updated Type Definitions

```typescript
// packages/pglite/src/postgresMod.ts

export interface PostgresMod
  extends Omit<EmscriptenModule, 'preInit' | 'preRun' | 'postRun'> {
  // ... existing properties ...

  // REMOVED: _set_read_write_cbs - no longer needed
  // REMOVED: addFunction - no longer needed for callbacks
  // REMOVED: removeFunction - no longer needed for callbacks

  // Import functions are automatically available but not directly callable from JS
  // They're called internally by recv/send
}
```

---

## Minimal POC

### Directory Structure

```
packages/pglite-fork/
  poc/
    wasm-imports/
      README.md
      pglite-comm-imports.h    # Modified C header
      pglite-imports.ts        # Modified TypeScript
      test-imports.ts          # Test file
```

### POC C Header (pglite-comm-imports.h)

```c
// POC: WASM imports for PGlite callbacks
// This replaces the dynamic function pointer approach

#if defined(__EMSCRIPTEN__)
#ifndef PGLITE_COMM_IMPORTS_H
#define PGLITE_COMM_IMPORTS_H

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stddef.h>

// ============================================================================
// WASM IMPORT DECLARATIONS
// These functions are provided by JavaScript at instantiation time
// ============================================================================

// Read data FROM JavaScript into WASM buffer
// Called when PostgreSQL needs to read query input
// Parameters:
//   buffer: Pointer to WASM memory where data should be written
//   max_length: Maximum bytes to read
// Returns: Number of bytes actually read, or 0 if no data available
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_read")))
extern ssize_t pglite_js_read(void *buffer, size_t max_length);

// Write data TO JavaScript from WASM buffer
// Called when PostgreSQL needs to send query results
// Parameters:
//   buffer: Pointer to WASM memory containing data to send
//   length: Number of bytes to write
// Returns: Number of bytes actually written
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_write")))
extern ssize_t pglite_js_write(void *buffer, size_t length);

// ============================================================================
// SOCKET FUNCTION OVERRIDES
// These redirect standard socket calls to our imported functions
// ============================================================================

ssize_t EMSCRIPTEN_KEEPALIVE
recv(int __fd, void *__buf, size_t __n, int __flags) {
    // Delegate to JavaScript import
    return pglite_js_read(__buf, __n);
}

ssize_t EMSCRIPTEN_KEEPALIVE
send(int __fd, const void *__buf, size_t __n, int __flags) {
    // Delegate to JavaScript import
    return pglite_js_write((void*)__buf, __n);
}

// ============================================================================
// REMOVED: set_read_write_cbs
// This function is no longer needed - callbacks are set at instantiation time
// ============================================================================

// Stub implementations for other socket functions (unchanged)
int EMSCRIPTEN_KEEPALIVE fcntl(int __fd, int __cmd, ...) { return 0; }
int EMSCRIPTEN_KEEPALIVE setsockopt(int __fd, int __level, int __optname,
    const void *__optval, socklen_t __optlen) { return 0; }
int EMSCRIPTEN_KEEPALIVE getsockopt(int __fd, int __level, int __optname,
    void *__restrict __optval, socklen_t *__restrict __optlen) { return 0; }
int EMSCRIPTEN_KEEPALIVE getsockname(int __fd, struct sockaddr *__addr,
    socklen_t *__restrict __len) { return 0; }
int EMSCRIPTEN_KEEPALIVE connect(int socket, const struct sockaddr *address,
    socklen_t address_len) { return 0; }

struct pollfd { int fd; short events; short revents; };
int EMSCRIPTEN_KEEPALIVE poll(struct pollfd fds[], ssize_t nfds, int timeout) {
    return nfds;
}

#endif // PGLITE_COMM_IMPORTS_H
#endif // __EMSCRIPTEN__
```

### POC TypeScript (pglite-imports.ts)

```typescript
/**
 * POC: WASM Imports for PGlite Callbacks
 *
 * This demonstrates how to provide read/write callbacks as WASM imports
 * instead of using addFunction (which requires runtime code generation).
 */

import { Parser as ProtocolParser } from '@electric-sql/pg-protocol'
import type { BackendMessage } from '@electric-sql/pg-protocol/messages'

/**
 * WASM Import function signatures
 * These match the C declarations in pglite-comm-imports.h
 */
interface PGliteWasmImports {
  pglite_js_read: (bufferPtr: number, maxLength: number) => number
  pglite_js_write: (bufferPtr: number, length: number) => number
}

/**
 * Creates the WASM import functions for PGlite
 *
 * These functions close over the module reference and query state,
 * allowing them to access WASM memory and track I/O.
 */
export function createPGliteImports(
  getModule: () => { HEAPU8: Uint8Array } | undefined
): {
  imports: PGliteWasmImports
  setQueryInput: (data: Uint8Array) => void
  getQueryOutput: () => Uint8Array[]
  getMessages: () => BackendMessage[]
  reset: () => void
} {
  // Query state (closed over by import functions)
  let inputBuffer: Uint8Array | undefined
  let inputOffset = 0
  let outputChunks: Uint8Array[] = []
  let messages: BackendMessage[] = []

  const parser = new ProtocolParser()

  const imports: PGliteWasmImports = {
    /**
     * Read callback - called by WASM to get query input data
     *
     * This is called by recv() in the C code when PostgreSQL
     * wants to read the next part of the query message.
     */
    pglite_js_read: (bufferPtr: number, maxLength: number): number => {
      const mod = getModule()
      if (!mod || !inputBuffer) return 0

      const available = inputBuffer.length - inputOffset
      if (available === 0) return 0

      const length = Math.min(available, maxLength)
      mod.HEAPU8.set(
        inputBuffer.subarray(inputOffset, inputOffset + length),
        bufferPtr
      )
      inputOffset += length

      return length
    },

    /**
     * Write callback - called by WASM to send query results
     *
     * This is called by send() in the C code when PostgreSQL
     * wants to send result data back to the client.
     */
    pglite_js_write: (bufferPtr: number, length: number): number => {
      const mod = getModule()
      if (!mod) return 0

      // Copy data from WASM memory
      const bytes = mod.HEAPU8.slice(bufferPtr, bufferPtr + length)
      outputChunks.push(bytes)

      // Parse PostgreSQL protocol messages
      parser.parse(bytes, (msg) => {
        messages.push(msg)
      })

      return length
    }
  }

  return {
    imports,

    /**
     * Set the input data for the next query
     * Call this before executing a query via _interactive_one
     */
    setQueryInput: (data: Uint8Array) => {
      inputBuffer = data
      inputOffset = 0
    },

    /**
     * Get raw output chunks from the last query
     */
    getQueryOutput: () => outputChunks,

    /**
     * Get parsed protocol messages from the last query
     */
    getMessages: () => messages,

    /**
     * Reset state for next query
     */
    reset: () => {
      inputBuffer = undefined
      inputOffset = 0
      outputChunks = []
      messages = []
    }
  }
}

/**
 * Example: How to use with PostgresModFactory
 */
export async function createPGliteWithImports(
  PostgresModFactory: (opts: any) => Promise<any>,
  wasmModule?: WebAssembly.Module
) {
  let mod: any

  // Create import handlers
  const { imports, setQueryInput, getQueryOutput, getMessages, reset } =
    createPGliteImports(() => mod)

  // Configure module with import functions
  mod = await PostgresModFactory({
    instantiateWasm: (
      emscriptenImports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ) => {
      // Merge our imports with Emscripten's
      const mergedImports = {
        ...emscriptenImports,
        env: {
          ...emscriptenImports.env,
          // Add our callback imports
          pglite_js_read: imports.pglite_js_read,
          pglite_js_write: imports.pglite_js_write
        }
      }

      // Instantiate with merged imports
      if (wasmModule) {
        WebAssembly.instantiate(wasmModule, mergedImports)
          .then((instance) => successCallback(instance, wasmModule))
      } else {
        throw new Error('wasmModule required for this POC')
      }

      return {}
    }
  })

  // Return enhanced module with query helpers
  return {
    mod,

    /**
     * Execute a query using the imported callbacks
     *
     * NO addFunction CALLS - callbacks were set at instantiation!
     */
    async execQuery(message: Uint8Array) {
      reset()
      setQueryInput(message)

      // Execute query - recv/send will use our imported functions
      mod._interactive_one(message.length, message[0])

      return {
        raw: getQueryOutput(),
        messages: getMessages()
      }
    }
  }
}
```

---

## Migration Path

### Phase 1: Fork and Modify C Code (1-2 days)

1. Create `pglite-comm-imports.h` with import declarations
2. Modify build to include new header
3. Keep `pglite-comm.h` for backward compatibility
4. Use preprocessor flag to select mode: `PGLITE_USE_IMPORTS`

### Phase 2: Update Build System (1 day)

1. Create new build target for import-based version
2. Remove `ALLOW_TABLE_GROWTH` from Workers build
3. Remove `addFunction`/`removeFunction` from exports
4. Test WASM output validates imports correctly

### Phase 3: Update JavaScript (1-2 days)

1. Modify `pglite.ts` to use import-based callbacks
2. Update `instantiateWasm` to provide imports
3. Remove `addFunction`/`removeFunction` calls
4. Remove `_set_read_write_cbs` call
5. Update TypeScript interfaces

### Phase 4: Testing (2-3 days)

1. Unit tests for import function behavior
2. Integration tests with actual queries
3. Test in Cloudflare Workers (Miniflare)
4. Performance comparison with original approach
5. Edge cases: large queries, streaming, errors

### Phase 5: Cleanup (1 day)

1. Remove backward compatibility code
2. Update documentation
3. Remove unused exports from WASM build

**Total Estimated Time**: 1-2 weeks

---

## Tradeoffs and Considerations

### Advantages

| Advantage | Description |
|-----------|-------------|
| **Workers Compatible** | No runtime code generation required |
| **Cleaner Architecture** | Callbacks defined at natural point (instantiation) |
| **Better Type Safety** | Import signatures validated at link time |
| **Smaller WASM** | No function table growth machinery needed |
| **Debuggable** | Clear import/export contract visible in WASM |

### Disadvantages

| Disadvantage | Description |
|--------------|-------------|
| **C Changes Required** | Must modify postgres-pglite fork |
| **Rebuild Required** | Cannot use existing PGlite WASM builds |
| **Less Dynamic** | Callbacks must be known at instantiation |
| **Import Order** | Must ensure imports provided before any code runs |

### Comparison with Other Approaches

| Approach | C Changes | JS Changes | Build Changes | Workers Ready |
|----------|-----------|------------|---------------|---------------|
| **WASM Imports** | Medium | Medium | Low | Yes |
| Static Callbacks | Medium | Low | Low | Yes |
| Memory Polling | High | High | Medium | Yes |
| Current (addFunction) | None | None | None | **No** |

### Why WASM Imports is Best

1. **Architecturally Correct**: Uses WASM's native import mechanism
2. **No Workarounds**: Unlike memory polling or static buffers
3. **Maintains Flexibility**: JavaScript can still define any callback behavior
4. **Future Proof**: Standard WASM pattern supported everywhere
5. **Performance**: Direct function calls, no pointer indirection

---

## Appendix: How Emscripten Handles Imports

### C Code to WASM Import

When you write:

```c
__attribute__((import_module("env")))
__attribute__((import_name("my_import")))
extern int my_import(int x);
```

Emscripten generates WASM that looks like (in WAT text format):

```wat
(import "env" "my_import" (func $my_import (param i32) (result i32)))
```

### JavaScript Instantiation

The JavaScript must provide this import:

```javascript
const imports = {
  env: {
    my_import: (x) => x * 2  // Implementation
  }
}

const instance = await WebAssembly.instantiate(wasmModule, imports)
```

### What Happens at Instantiation

1. WASM runtime validates all imports are provided
2. Import functions are bound to WASM's import table
3. Module instantiation completes
4. WASM code can now call imports like regular functions

No code generation. No dynamic tables. Just function references.

---

## Conclusion

The WASM imports approach is the **recommended solution** for making PGlite compatible with Cloudflare Workers. While it requires C-level modifications, it provides:

1. **Correct Architecture**: Uses WASM as designed
2. **Full Compatibility**: Works in all environments including Workers
3. **Clean Codebase**: Removes need for `addFunction` complexity
4. **Maintainable**: Standard pattern understood by WASM developers

The implementation effort (1-2 weeks) is justified by the architectural improvements and guaranteed Workers compatibility.

---

*Spike completed 2026-01-15*
