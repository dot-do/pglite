# SPIKE: Memory Polling Alternative to addFunction Callbacks in PGlite

**Date**: 2026-01-15
**Status**: ANALYSIS COMPLETE
**Project**: Native Iceberg TS Module for Cloudflare Workers

---

## Executive Summary

This spike investigates whether PGlite can be modified to avoid Emscripten's `addFunction` which requires runtime WASM compilation (blocked in Cloudflare Workers). The investigation reveals **three potential architectural alternatives**:

1. **Memory Polling** - Replace function callbacks with shared memory buffers
2. **Pre-registered Static Function Pointers** - Define callbacks at compile time
3. **Emscripten `--allow-table-growth=0` with Static Table** - Pre-allocate function table slots

**Conclusion**: All three approaches are technically feasible but require significant C-level modifications to the postgres-pglite fork. The **Memory Polling** approach offers the cleanest separation of concerns but requires the most extensive changes. The **Static Function Table** approach is likely the lowest-effort path forward.

---

## Table of Contents

1. [Background](#background)
2. [Current PGlite Architecture](#current-pglite-architecture)
3. [The addFunction Problem](#the-addfunction-problem)
4. [Alternative 1: Memory Polling](#alternative-1-memory-polling)
5. [Alternative 2: Pre-registered Static Function Pointers](#alternative-2-pre-registered-static-function-pointers)
6. [Alternative 3: Static Function Table](#alternative-3-static-function-table)
7. [Implementation Complexity Analysis](#implementation-complexity-analysis)
8. [Recommendation](#recommendation)
9. [Next Steps](#next-steps)

---

## Background

### The Problem

PGlite uses Emscripten's `addFunction` to create JavaScript callbacks that PostgreSQL's C code can invoke. This requires runtime WASM code generation, which Cloudflare Workers blocks for security reasons:

```
Error: WebAssembly.Module(): Wasm code generation disallowed by embedder
```

This is the same policy that blocks `eval()` and `new Function()`.

### Files Analyzed

| File | Purpose |
|------|---------|
| `packages/pglite/src/pglite.ts` | JavaScript side - creates callbacks |
| `packages/pglite/src/postgresMod.ts` | TypeScript interface definitions |
| `postgres-pglite/pglite/includes/pglite-comm.h` | C side - callback registration |
| `postgres-pglite/pglite-wasm/interactive_one.c` | C side - query execution loop |
| `postgres-pglite/src/backend/libpq/pqcomm.c` | PostgreSQL I/O buffer management |
| `postgres-pglite/src/backend/libpq/be-secure.c` | Raw recv/send calls |

---

## Current PGlite Architecture

### Communication Flow

```
JavaScript                          PostgreSQL WASM (C)
-----------                         -------------------

 execProtocol()
    |
    v
 #pglite_read = mod.addFunction(...)  <-- Runtime WASM generation!
 #pglite_write = mod.addFunction(...) <-- Runtime WASM generation!
    |
    v
 mod._set_read_write_cbs(read, write)
    |
    +---------------------------------> set_read_write_cbs()
                                            |
                                            v
                                        pglite_read = read_cb  // function pointer
                                        pglite_write = write_cb
                                            |
                                            v
                                        recv() calls pglite_read()
                                        send() calls pglite_write()
```

### Key Code Sections

#### JavaScript Side (pglite.ts:390-449)

```typescript
// set the write callback
this.#pglite_write = this.mod.addFunction((ptr: any, length: number) => {
  let bytes = this.mod!.HEAPU8.subarray(ptr, ptr + length);
  this.#protocolParser.parse(bytes, (msg) => {
    this.#parse(msg);
  });
  // ... buffer management
  return length;
}, 'iii');

// set the read callback
this.#pglite_read = this.mod.addFunction((ptr: any, max_length: number) => {
  // copy current data to wasm buffer
  let length = this.#outputData.length - this.#readOffset;
  // ... copy data to HEAP8
  return length;
}, 'iii');

this.mod._set_read_write_cbs(this.#pglite_read, this.#pglite_write);
```

#### C Side (pglite-comm.h:15-30)

```c
// Function pointer types
typedef ssize_t (*pglite_read_t)(void *buffer, size_t max_length);
typedef ssize_t (*pglite_write_t)(void *buffer, size_t length);

// Global function pointers
pglite_read_t pglite_read;
pglite_write_t pglite_write;

// Registration function (exported to JavaScript)
__attribute__((export_name("set_read_write_cbs")))
void set_read_write_cbs(pglite_read_t read_cb, pglite_write_t write_cb) {
    pglite_read = read_cb;
    pglite_write = write_cb;
}
```

#### C Usage (pglite-comm.h:56-66)

```c
ssize_t EMSCRIPTEN_KEEPALIVE recv(int __fd, void *__buf, size_t __n, int __flags) {
    ssize_t got = pglite_read(__buf, __n);
    return got;
}

ssize_t EMSCRIPTEN_KEEPALIVE send(int __fd, const void *__buf, size_t __n, int __flags) {
    ssize_t wrote = pglite_write(__buf, __n);
    return wrote;
}
```

---

## The addFunction Problem

### How addFunction Works

1. JavaScript calls `mod.addFunction(jsFunc, signature)`
2. Emscripten generates new WASM bytecode at runtime
3. New WASM is compiled into a function that:
   - Reads parameters from WASM stack
   - Calls back into JavaScript
   - Returns result to WASM

### Why Workers Block It

Cloudflare Workers uses the same security model as CSP's `unsafe-eval` restriction:

```
Content-Security-Policy: script-src 'self'  // No dynamic code
```

Runtime WASM compilation is equivalent to `eval()` - it can execute arbitrary code.

### Current Build Flags (build-pglite.sh:86-94)

```bash
EXPORTED_RUNTIME_METHODS="MEMFS,IDBFS,FS,setValue,getValue,UTF8ToString,
                          stringToNewUTF8,stringToUTF8OnStack,
                          addFunction,removeFunction,wasmTable"

PGLITE_EMSCRIPTEN_FLAGS="... -sALLOW_TABLE_GROWTH -sALLOW_MEMORY_GROWTH ..."
```

The `ALLOW_TABLE_GROWTH` flag enables `addFunction` to work by allowing the WASM function table to grow at runtime.

---

## Alternative 1: Memory Polling

### Concept

Replace function callbacks with a shared memory buffer that both JavaScript and WASM poll:

```
JavaScript                    Shared Memory                    WASM
-----------                   -------------                    ----

                              +------------------+
write data to buffer ------> | Input Buffer     | <------ C polls for data
                              | - data_ptr       |
                              | - data_len       |
                              | - ready_flag     |
                              +------------------+

                              +------------------+
read data from buffer <----- | Output Buffer    | ------> C writes results
                              | - data_ptr       |
                              | - data_len       |
                              | - ready_flag     |
                              +------------------+

                              +------------------+
signal operation -----+      | Control Block    |
                      +----> | - op_type        |
wait for completion <------  | - status         |
                              | - error_code     |
                              +------------------+
```

### Implementation Approach

#### 1. Define Shared Memory Structure (C side)

```c
// pglite-comm-polling.h

typedef struct {
    volatile uint32_t ready;      // 0 = empty, 1 = data ready
    volatile uint32_t length;     // data length
    uint8_t data[65536];          // 64KB buffer
} PGliteBuffer;

typedef struct {
    volatile uint32_t operation;  // 0 = none, 1 = read, 2 = write
    volatile uint32_t status;     // 0 = pending, 1 = complete, 2 = error
    volatile int32_t result;      // bytes read/written or error code
} PGliteControl;

// Global shared memory (exported)
__attribute__((export_name("pglite_input_buffer")))
PGliteBuffer pglite_input_buffer;

__attribute__((export_name("pglite_output_buffer")))
PGliteBuffer pglite_output_buffer;

__attribute__((export_name("pglite_control")))
PGliteControl pglite_control;
```

#### 2. Polling Implementation (C side)

```c
// Modified recv() - polls input buffer
ssize_t recv(int fd, void *buf, size_t n, int flags) {
    // Signal we need data
    pglite_control.operation = 1;  // READ
    pglite_control.status = 0;     // PENDING

    // Poll for JavaScript to provide data
    // In WASM, this would yield to JavaScript via Asyncify or similar
    while (pglite_input_buffer.ready == 0) {
        emscripten_sleep(0);  // Yield to JavaScript
    }

    // Copy data from shared buffer
    uint32_t len = pglite_input_buffer.length;
    if (len > n) len = n;
    memcpy(buf, pglite_input_buffer.data, len);

    // Mark buffer as consumed
    pglite_input_buffer.ready = 0;
    pglite_control.status = 1;  // COMPLETE
    pglite_control.result = len;

    return len;
}

// Modified send() - writes to output buffer
ssize_t send(int fd, const void *buf, size_t n, int flags) {
    // Wait for output buffer to be available
    while (pglite_output_buffer.ready != 0) {
        emscripten_sleep(0);
    }

    // Copy data to shared buffer
    uint32_t len = n;
    if (len > sizeof(pglite_output_buffer.data)) {
        len = sizeof(pglite_output_buffer.data);
    }
    memcpy(pglite_output_buffer.data, buf, len);
    pglite_output_buffer.length = len;
    pglite_output_buffer.ready = 1;

    pglite_control.operation = 2;  // WRITE
    pglite_control.status = 1;     // COMPLETE
    pglite_control.result = len;

    return len;
}
```

#### 3. JavaScript Polling Loop

```typescript
// No addFunction needed!

class PGlitePolling {
  private inputBufferPtr: number;
  private outputBufferPtr: number;
  private controlPtr: number;

  async init() {
    // Get pointers to exported symbols
    this.inputBufferPtr = this.mod._pglite_input_buffer;
    this.outputBufferPtr = this.mod._pglite_output_buffer;
    this.controlPtr = this.mod._pglite_control;
  }

  // Write data for PostgreSQL to read
  writeInput(data: Uint8Array) {
    const heap = this.mod.HEAPU8;
    const bufferDataPtr = this.inputBufferPtr + 8; // offset past ready+length

    heap.set(data, bufferDataPtr);
    this.mod.HEAPU32[this.inputBufferPtr / 4 + 1] = data.length; // length
    this.mod.HEAPU32[this.inputBufferPtr / 4] = 1; // ready = true
  }

  // Read output from PostgreSQL
  readOutput(): Uint8Array | null {
    const readyPtr = this.outputBufferPtr / 4;
    const lengthPtr = this.outputBufferPtr / 4 + 1;
    const dataPtr = this.outputBufferPtr + 8;

    if (this.mod.HEAPU32[readyPtr] === 0) {
      return null; // No data available
    }

    const length = this.mod.HEAPU32[lengthPtr];
    const data = this.mod.HEAPU8.slice(dataPtr, dataPtr + length);

    // Mark as consumed
    this.mod.HEAPU32[readyPtr] = 0;

    return data;
  }

  // Run a query with polling
  async execProtocol(message: Uint8Array): Promise<Uint8Array[]> {
    const results: Uint8Array[] = [];

    // Send input
    this.writeInput(message);

    // Execute query
    this.mod._interactive_one(message.length, message[0]);

    // Poll for output
    while (true) {
      const output = this.readOutput();
      if (output) {
        results.push(output);
      }

      // Check if operation complete
      const status = this.mod.HEAPU32[this.controlPtr / 4 + 1];
      if (status === 1) break; // COMPLETE
      if (status === 2) throw new Error('Query error');

      await new Promise(r => setTimeout(r, 0)); // Yield
    }

    return results;
  }
}
```

### Pros and Cons

| Pros | Cons |
|------|------|
| No dynamic WASM needed | Requires Asyncify for blocking waits |
| Clean separation of concerns | More complex state machine |
| Works in Workers | Higher latency per operation |
| Debuggable memory layout | Buffer size limitations |
| No function table growth | Requires C code changes |

### Required Build Changes

```bash
# Add Asyncify for yielding
PGLITE_EMSCRIPTEN_FLAGS="$PGLITE_EMSCRIPTEN_FLAGS -sASYNCIFY"

# Remove table growth
# Remove: -sALLOW_TABLE_GROWTH

# Export buffer symbols
EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS,_pglite_input_buffer,_pglite_output_buffer,_pglite_control"
```

---

## Alternative 2: Pre-registered Static Function Pointers

### Concept

Define all possible callback functions at compile time in C, then select which one to use at runtime:

```c
// Define all possible callbacks at compile time
__attribute__((export_name("static_read_callback")))
ssize_t static_read_callback(void *buffer, size_t max_length) {
    // Read from pre-defined shared buffer
    return pglite_static_read(buffer, max_length);
}

__attribute__((export_name("static_write_callback")))
ssize_t static_write_callback(void *buffer, size_t length) {
    // Write to pre-defined shared buffer
    return pglite_static_write(buffer, length);
}

// At init, use these pre-compiled functions
void pglite_init() {
    pglite_read = static_read_callback;
    pglite_write = static_write_callback;
}
```

### Implementation

#### 1. Static Callbacks with Shared Buffers (C)

```c
// pglite-static-callbacks.h

// Shared buffers for data exchange
static uint8_t g_read_buffer[1024 * 1024];  // 1MB
static volatile size_t g_read_length = 0;
static volatile size_t g_read_offset = 0;

static uint8_t g_write_buffer[1024 * 1024];
static volatile size_t g_write_length = 0;

// Pre-compiled read callback
ssize_t pglite_static_read_impl(void *buffer, size_t max_length) {
    size_t available = g_read_length - g_read_offset;
    if (available == 0) return 0;

    size_t to_copy = available < max_length ? available : max_length;
    memcpy(buffer, g_read_buffer + g_read_offset, to_copy);
    g_read_offset += to_copy;

    return to_copy;
}

// Pre-compiled write callback
ssize_t pglite_static_write_impl(void *buffer, size_t length) {
    if (g_write_length + length > sizeof(g_write_buffer)) {
        // Buffer full - would need to flush
        return -1;
    }

    memcpy(g_write_buffer + g_write_length, buffer, length);
    g_write_length += length;

    return length;
}

// Export buffer pointers for JavaScript access
__attribute__((export_name("get_read_buffer")))
void* get_read_buffer() { return g_read_buffer; }

__attribute__((export_name("get_write_buffer")))
void* get_write_buffer() { return g_write_buffer; }

// Initialize with static callbacks
__attribute__((export_name("pglite_static_init")))
void pglite_static_init() {
    pglite_read = pglite_static_read_impl;
    pglite_write = pglite_static_write_impl;
}

// JavaScript calls these to set data before query
__attribute__((export_name("set_read_data")))
void set_read_data(size_t length) {
    g_read_length = length;
    g_read_offset = 0;
}

// JavaScript calls this to get write results
__attribute__((export_name("get_write_length")))
size_t get_write_length() {
    return g_write_length;
}

__attribute__((export_name("reset_write_buffer")))
void reset_write_buffer() {
    g_write_length = 0;
}
```

#### 2. JavaScript Usage (No addFunction)

```typescript
class PGliteStatic {
  async init() {
    // Initialize with pre-compiled static callbacks
    this.mod._pglite_static_init();

    // Get buffer pointers
    this.readBufferPtr = this.mod._get_read_buffer();
    this.writeBufferPtr = this.mod._get_write_buffer();
  }

  async execProtocol(message: Uint8Array): Promise<Uint8Array> {
    // Copy input to read buffer
    this.mod.HEAPU8.set(message, this.readBufferPtr);
    this.mod._set_read_data(message.length);

    // Reset write buffer
    this.mod._reset_write_buffer();

    // Execute (PostgreSQL will use static callbacks)
    this.mod._interactive_one(message.length, message[0]);

    // Get output from write buffer
    const writeLength = this.mod._get_write_length();
    const result = this.mod.HEAPU8.slice(
      this.writeBufferPtr,
      this.writeBufferPtr + writeLength
    );

    return result;
  }
}
```

### Pros and Cons

| Pros | Cons |
|------|------|
| Simple implementation | Fixed buffer sizes |
| No Asyncify needed | Less flexible than callbacks |
| Minimal C changes | Synchronous only |
| Works in Workers | Requires all data upfront |
| No function table growth | Memory waste if buffers unused |

---

## Alternative 3: Static Function Table

### Concept

Use Emscripten's static function table to pre-allocate slots at compile time, then assign JavaScript functions to those slots without runtime WASM generation.

### Build Flag Changes

```bash
# Pre-allocate function table slots
-sALLOW_TABLE_GROWTH=0          # Disable dynamic growth
-sINITIAL_TABLE=64              # Pre-allocate 64 slots

# Export table for JavaScript manipulation
EXPORTED_RUNTIME_METHODS="...,wasmTable,addFunction"

# Use table64 mode (experimental)
-sWASM_TABLE64=1
```

### How It Works

1. WASM module is compiled with a fixed-size function table
2. Some slots are reserved and unused at startup
3. JavaScript can write function references to these slots
4. No new WASM compilation needed - just table[index] = function

### Implementation Check

Looking at the current Emscripten output, we need to verify if the `wasmTable` is directly accessible and modifiable.

```typescript
// Theoretical approach (needs verification)
class PGliteStaticTable {
  private readSlot: number = 0;  // Pre-allocated slot
  private writeSlot: number = 1; // Pre-allocated slot

  init() {
    // Get the WASM table
    const table = this.mod.wasmTable;

    // Create wrapper functions that don't require addFunction
    // This is where the challenge lies - we need functions
    // that can be called from WASM

    // Option A: Use pre-compiled C wrappers
    // The C code calls slot N, JavaScript sets what slot N does

    // Option B: Use JS-to-WASM bridges (if supported)
  }
}
```

### The Catch

Even with a static table, we still need a way to make JavaScript functions callable from WASM. The options are:

1. **Pre-compiled C wrappers** (Alternative 2 with static slots)
2. **WebAssembly.Function** (not widely supported, needs investigation)
3. **Import-based callbacks** (defined at module instantiation)

### Import-Based Callbacks Approach

```javascript
// Define callbacks at instantiation time
const imports = {
  env: {
    pglite_js_read: (bufferPtr, maxLength) => {
      // This function is available from module start
      // No addFunction needed
      const data = currentQueryInput;
      const len = Math.min(data.length, maxLength);
      this.heap.set(data.subarray(0, len), bufferPtr);
      return len;
    },
    pglite_js_write: (bufferPtr, length) => {
      // Capture output
      const data = this.heap.slice(bufferPtr, bufferPtr + length);
      currentQueryOutput.push(data);
      return length;
    }
  }
};

// Instantiate with imports
const instance = await WebAssembly.instantiate(wasmModule, imports);
```

Then in C:

```c
// pglite-imports.h

// Declare as imports (provided by JavaScript at instantiation)
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_read")))
extern ssize_t pglite_js_read(void *buffer, size_t max_length);

__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_write")))
extern ssize_t pglite_js_write(void *buffer, size_t length);

// Use directly without function pointers
ssize_t recv(int fd, void *buf, size_t n, int flags) {
    return pglite_js_read(buf, n);
}

ssize_t send(int fd, const void *buf, size_t n, int flags) {
    return pglite_js_write(buf, n);
}
```

### Pros and Cons

| Pros | Cons |
|------|------|
| No runtime WASM generation | Requires recompilation |
| Callbacks defined at instantiation | Less dynamic flexibility |
| Works in Workers | Import functions must be known upfront |
| True JavaScript callbacks | Changes Emscripten instantiation flow |

---

## Implementation Complexity Analysis

### Effort Comparison

| Approach | C Changes | JS Changes | Build Changes | Testing | Total Effort |
|----------|-----------|------------|---------------|---------|--------------|
| Memory Polling | High | High | Medium | High | **~3-4 weeks** |
| Static Callbacks | Medium | Low | Low | Medium | **~1-2 weeks** |
| Import Callbacks | Medium | Medium | High | Medium | **~2-3 weeks** |

### Risk Assessment

| Approach | Risk Level | Main Risks |
|----------|------------|------------|
| Memory Polling | Medium | Asyncify complexity, performance overhead |
| Static Callbacks | Low | Buffer sizing, memory usage |
| Import Callbacks | Medium | Emscripten compatibility, instantiation changes |

---

## Recommendation

### Short Term (Lowest Effort)

**Use Static Callbacks (Alternative 2)**

1. Modify `pglite-comm.h` to use pre-compiled read/write implementations
2. Export buffer pointers and control functions
3. Update JavaScript to use direct memory operations
4. Remove `addFunction` and `removeFunction` usage
5. Build without `ALLOW_TABLE_GROWTH`

**Estimated Time**: 1-2 weeks

### Medium Term (Best Architecture)

**Use Import Callbacks (Alternative 3)**

1. Define `pglite_js_read` and `pglite_js_write` as WASM imports
2. Modify Emscripten build to accept these imports
3. Update JavaScript instantiation to provide callback implementations
4. Remove all dynamic function pointer registration

**Estimated Time**: 2-3 weeks

### Long Term (Most Flexible)

**Memory Polling with Asyncify (Alternative 1)**

Only if we need:
- Streaming results
- True async I/O
- Complex bidirectional communication

**Estimated Time**: 3-4 weeks

---

## Next Steps

### Immediate Actions

1. **Fork postgres-pglite** for Cloudflare Workers modifications
2. **Create proof-of-concept** with Static Callbacks approach
3. **Benchmark** memory-based communication vs callback overhead
4. **Test in Miniflare** before deploying to Workers

### Implementation Order

```
Phase 1: Static Callbacks (1 week)
  - Modify pglite-comm.h
  - Update build flags
  - Basic JavaScript integration

Phase 2: Testing (3-4 days)
  - Unit tests for new communication
  - Integration tests with Workers
  - Performance benchmarks

Phase 3: Import Callbacks (optional, 2 weeks)
  - If Static Callbacks prove limiting
  - Redefine as WASM imports
  - Update instantiation flow
```

### Files to Modify

| File | Changes |
|------|---------|
| `postgres-pglite/pglite/includes/pglite-comm.h` | Add static callbacks, buffers |
| `postgres-pglite/build-pglite.sh` | Remove ALLOW_TABLE_GROWTH |
| `packages/pglite/src/pglite.ts` | Remove addFunction, use memory ops |
| `packages/pglite/src/postgresMod.ts` | Update type definitions |

---

## Appendix: Code Snippets

### A. Minimal Static Callback Implementation

```c
// pglite-comm-static.h
#ifndef PGLITE_COMM_STATIC_H
#define PGLITE_COMM_STATIC_H

#include <stdint.h>
#include <string.h>

#define PGLITE_BUFFER_SIZE (1024 * 1024)

// Input buffer (JS writes here, C reads from here)
static uint8_t g_input_buffer[PGLITE_BUFFER_SIZE];
static volatile size_t g_input_length = 0;
static volatile size_t g_input_offset = 0;

// Output buffer (C writes here, JS reads from here)
static uint8_t g_output_buffer[PGLITE_BUFFER_SIZE];
static volatile size_t g_output_length = 0;

// Exported functions for JavaScript
__attribute__((export_name("pglite_get_input_buffer")))
void* pglite_get_input_buffer(void) { return g_input_buffer; }

__attribute__((export_name("pglite_get_output_buffer")))
void* pglite_get_output_buffer(void) { return g_output_buffer; }

__attribute__((export_name("pglite_set_input_length")))
void pglite_set_input_length(size_t len) {
    g_input_length = len;
    g_input_offset = 0;
}

__attribute__((export_name("pglite_get_output_length")))
size_t pglite_get_output_length(void) { return g_output_length; }

__attribute__((export_name("pglite_reset_output")))
void pglite_reset_output(void) { g_output_length = 0; }

// Internal read (called by recv)
static ssize_t pglite_static_read(void *buf, size_t n) {
    size_t available = g_input_length - g_input_offset;
    if (available == 0) return 0;

    size_t to_copy = (available < n) ? available : n;
    memcpy(buf, g_input_buffer + g_input_offset, to_copy);
    g_input_offset += to_copy;
    return to_copy;
}

// Internal write (called by send)
static ssize_t pglite_static_write(const void *buf, size_t n) {
    size_t available = PGLITE_BUFFER_SIZE - g_output_length;
    if (available == 0) return -1; // ENOSPC

    size_t to_copy = (n < available) ? n : available;
    memcpy(g_output_buffer + g_output_length, buf, to_copy);
    g_output_length += to_copy;
    return to_copy;
}

// Override recv/send to use static buffers
#define recv(fd, buf, n, flags) pglite_static_read(buf, n)
#define send(fd, buf, n, flags) pglite_static_write(buf, n)

#endif
```

### B. JavaScript Without addFunction

```typescript
class PGliteStaticComm {
  private mod: PostgresMod;
  private inputBufferPtr: number = 0;
  private outputBufferPtr: number = 0;

  async init(mod: PostgresMod) {
    this.mod = mod;
    this.inputBufferPtr = mod._pglite_get_input_buffer();
    this.outputBufferPtr = mod._pglite_get_output_buffer();
  }

  async execProtocol(message: Uint8Array): Promise<Uint8Array> {
    // Write input
    this.mod.HEAPU8.set(message, this.inputBufferPtr);
    this.mod._pglite_set_input_length(message.length);

    // Reset output
    this.mod._pglite_reset_output();

    // Execute query
    this.mod._interactive_one(message.length, message[0]);

    // Read output
    const outputLength = this.mod._pglite_get_output_length();
    const result = this.mod.HEAPU8.slice(
      this.outputBufferPtr,
      this.outputBufferPtr + outputLength
    );

    return result;
  }
}
```

---

## POC Implementation

A working proof-of-concept has been created in `spike-memory-polling/`:

### Files Created

| File | Purpose |
|------|---------|
| `pglite-comm-polling.h` | C header with shared memory structures |
| `test-wasm.c` | Minimal WASM module for testing |
| `pglite-polling.ts` | TypeScript polling interface |
| `mock-wasm.ts` | Pure TS mock for testing without Emscripten |
| `test-mock.ts` | Integration tests |
| `CHANGES_REQUIRED.md` | Detailed modification guide for postgres-pglite |

### Running the POC

```bash
cd spike-memory-polling
npm install
npm test
```

### Test Results

All 6 tests pass:

1. **Simple Message Round-Trip** - Text transformed correctly
2. **Binary Data Round-Trip** - Non-text data handled
3. **Multi-Row Response** - Multiple messages in single call
4. **Status Checking** - Control block tracking works
5. **Large Message** - Near-buffer-limit messages work
6. **Error Handling** - Errors properly detected

### Key Takeaways

1. **Memory Layout Works** - The shared buffer approach with 8-byte headers (status + length) is clean and easy to work with from both C and TypeScript.

2. **No addFunction Needed** - The entire communication flow uses only:
   - Exported buffer accessor functions
   - Direct memory read/write via `HEAPU8`
   - No function pointers or `wasmTable`

3. **PostgreSQL Protocol Compatible** - The message framing (type byte + length + payload) maps directly to PostgreSQL wire protocol.

4. **Synchronous First** - The POC is synchronous. Adding Asyncify for true async would require:
   - `-sASYNCIFY` build flag
   - `emscripten_sleep(0)` calls in C for yielding

---

*Spike completed 2026-01-15*
*POC implemented and tested 2026-01-15*
