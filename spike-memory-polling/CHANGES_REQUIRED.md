# Required Changes to postgres-pglite for Memory Polling

This document outlines the specific modifications needed to the postgres-pglite fork
to implement the memory polling approach as an alternative to `addFunction` callbacks.

## Overview

The current PGlite architecture uses Emscripten's `addFunction` to create runtime
WASM callbacks for `recv()` and `send()`. This requires dynamic WASM code generation,
which is blocked in Cloudflare Workers.

The memory polling approach replaces these callbacks with shared memory buffers,
eliminating the need for runtime code generation.

---

## File-by-File Changes

### 1. `postgres-pglite/pglite/includes/pglite-comm.h`

**Current Implementation:**
```c
// Function pointer types for callbacks
typedef ssize_t (*pglite_read_t)(void *buffer, size_t max_length);
typedef ssize_t (*pglite_write_t)(void *buffer, size_t length);

// Global function pointers (set by JavaScript via addFunction)
pglite_read_t pglite_read;
pglite_write_t pglite_write;

// Registration function
void set_read_write_cbs(pglite_read_t read_cb, pglite_write_t write_cb);

// Socket overrides using callbacks
ssize_t recv(int __fd, void *__buf, size_t __n, int __flags) {
    return pglite_read(__buf, __n);  // <-- Calls JS via function pointer
}
```

**Required Changes:**

Add a compile-time switch to use polling instead of callbacks:

```c
#ifndef PGLITE_USE_POLLING
// Original callback-based implementation
// ... existing code ...

#else
// Memory polling implementation
#include "pglite-comm-polling.h"

// Replace recv/send to use polling buffers
ssize_t recv(int __fd, void *__buf, size_t __n, int __flags) {
    return pglite_polling_read(__buf, __n);
}

ssize_t send(int __fd, const void *__buf, size_t __n, int __flags) {
    ssize_t result = pglite_polling_write(__buf, __n);
    pglite_polling_flush();
    return result;
}
#endif
```

### 2. New File: `postgres-pglite/pglite/includes/pglite-comm-polling.h`

Create this new header with the shared memory structures and polling functions.
See `spike-memory-polling/pglite-comm-polling.h` for the full implementation.

Key components:
- `PGliteBuffer` struct with status, length, and data array
- `PGliteControl` struct for operation tracking
- Exported buffer accessor functions
- `pglite_polling_read()` and `pglite_polling_write()` implementations

### 3. `postgres-pglite/pglite-wasm/build.sh`

**Current Build Flags (line 269):**
```bash
-sALLOW_TABLE_GROWTH -sALLOW_MEMORY_GROWTH -sERROR_ON_UNDEFINED_SYMBOLS=0 \
```

**Required Changes:**

Add a build mode switch:

```bash
if ${PGLITE_POLLING:-false}; then
    # Polling mode - no table growth needed
    TABLE_FLAGS=""
    EXTRA_CFLAGS="-DPGLITE_USE_POLLING"
    EXTRA_EXPORTS=",'_pglite_get_input_buffer','_pglite_get_output_buffer','_pglite_get_control','_pglite_get_buffer_size','_pglite_signal_input_ready','_pglite_reset_buffers','_pglite_has_output','_pglite_get_output_length','_pglite_ack_output'"
else
    # Original mode with callbacks
    TABLE_FLAGS="-sALLOW_TABLE_GROWTH"
    EXTRA_CFLAGS=""
    EXTRA_EXPORTS=""
fi

# Use in build command:
${CC} ${CC_PGLITE} ${EXTRA_CFLAGS} ... \
    ${TABLE_FLAGS} -sALLOW_MEMORY_GROWTH ...
    -sEXPORTED_FUNCTIONS="${EXPORTED_FUNCTIONS}${EXTRA_EXPORTS}" \
```

**Remove from EXPORTED_RUNTIME_METHODS when in polling mode:**
- `addFunction`
- `removeFunction`
- `wasmTable`

### 4. `packages/pglite/src/pglite.ts`

**Current Implementation (lines 389-449):**
```typescript
// set the write callback
this.#pglite_write = this.mod.addFunction((ptr: any, length: number) => {
  let bytes = this.mod!.HEAPU8.subarray(ptr, ptr + length);
  this.#protocolParser.parse(bytes, (msg) => {
    this.#parse(msg);
  });
  // ...
}, 'iii');

// set the read callback
this.#pglite_read = this.mod.addFunction((ptr: any, max_length: number) => {
  // copy current data to wasm buffer
  // ...
}, 'iii');

this.mod._set_read_write_cbs(this.#pglite_read, this.#pglite_write);
```

**Required Changes:**

Replace with polling-based initialization:

```typescript
// Initialize polling buffers instead of callbacks
this.#inputBufferPtr = this.mod._pglite_get_input_buffer();
this.#outputBufferPtr = this.mod._pglite_get_output_buffer();
this.#controlPtr = this.mod._pglite_get_control();
this.#bufferSize = this.mod._pglite_get_buffer_size();
```

And replace `execProtocolRawSync` with polling version:

```typescript
execProtocolRawSync(message: Uint8Array) {
  const mod = this.mod!;

  // Reset buffers
  mod._pglite_reset_buffers();

  // Write input to shared buffer
  const inputDataPtr = this.#inputBufferPtr + 8; // After header
  mod.HEAPU8.set(message, inputDataPtr);
  mod._pglite_signal_input_ready(message.length);

  // Execute
  mod._interactive_one(message.length, message[0]);

  // Read output from shared buffer
  if (mod._pglite_has_output()) {
    const outputLength = mod._pglite_get_output_length();
    const outputDataPtr = this.#outputBufferPtr + 8;
    const result = mod.HEAPU8.slice(outputDataPtr, outputDataPtr + outputLength);

    // Process through protocol parser
    this.#protocolParser.parse(result, (msg) => {
      this.#parse(msg);
    });

    mod._pglite_ack_output();
    return result;
  }

  return new Uint8Array(0);
}
```

### 5. `packages/pglite/src/postgresMod.ts`

**Add polling function declarations:**

```typescript
export interface PostgresMod extends ... {
  // Existing...

  // Polling mode additions
  _pglite_get_input_buffer?: () => number;
  _pglite_get_output_buffer?: () => number;
  _pglite_get_control?: () => number;
  _pglite_get_buffer_size?: () => number;
  _pglite_reset_buffers?: () => void;
  _pglite_signal_input_ready?: (length: number) => void;
  _pglite_has_output?: () => number;
  _pglite_get_output_length?: () => number;
  _pglite_ack_output?: () => void;
}
```

---

## Handling Large Messages

The polling approach uses fixed-size buffers (64KB default). For messages larger
than the buffer, implement chunked transfer:

### Option A: Multiple Polling Cycles

JavaScript sends chunks, WASM acknowledges each:

```typescript
async writeInputChunked(data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.slice(offset, offset + this.#bufferSize);
    this.writeInput(chunk);

    // Wait for WASM to consume (with Asyncify)
    await this.waitForInputConsumed();

    offset += chunk.length;
  }
}
```

### Option B: Larger Buffers for Specific Use Cases

Configure buffer size at compile time:

```c
// For high-volume queries
#define PGLITE_BUFFER_SIZE (1024 * 1024)  // 1MB
```

---

## Asyncify Consideration

The current POC uses synchronous polling, which works for the simple case.
For streaming responses or large result sets, Asyncify enables true async waiting:

**Build flag addition:**
```bash
-sASYNCIFY -sASYNCIFY_STACK_SIZE=65536
```

**C-side modification for yielding:**
```c
#include <emscripten/emscripten.h>

static ssize_t pglite_polling_read_async(void *buf, size_t max_len) {
    // Wait for input if buffer is empty
    while (g_input_buffer.status != BUFFER_READY) {
        emscripten_sleep(0);  // Yield to JS event loop
    }
    // ... rest of read logic
}
```

---

## Testing Strategy

1. **Unit Tests**: Test buffer read/write without full PostgreSQL
2. **Integration Tests**: Full query round-trip with PostgreSQL WASM
3. **Workers Tests**: Deploy to Cloudflare Workers and verify no `addFunction` errors
4. **Performance Tests**: Compare latency vs callback approach

---

## Migration Path

1. Add polling support as an opt-in build mode
2. Keep callback support for backward compatibility
3. Default to polling for Cloudflare Workers builds
4. Eventually deprecate callback mode if polling proves superior

---

## Estimated Effort

| Task | Time |
|------|------|
| Create `pglite-comm-polling.h` | 2 hours |
| Modify `pglite-comm.h` with switch | 1 hour |
| Update build script | 2 hours |
| Modify `pglite.ts` | 4 hours |
| Update type definitions | 1 hour |
| Testing & debugging | 8 hours |
| **Total** | **~2-3 days** |

---

## Alternative: Import-Based Callbacks

If polling proves too restrictive, consider WASM imports defined at instantiation:

```c
// Declare as imports (not function pointers)
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_read")))
extern ssize_t pglite_js_read(void *buffer, size_t max_length);
```

This allows true JS callbacks without `addFunction`, but requires changes to
how the WASM module is instantiated. See `SPIKE_MEMORY_POLLING.md` for details.
