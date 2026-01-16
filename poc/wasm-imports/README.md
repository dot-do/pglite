# WASM Imports POC for PGlite

This directory contains a proof-of-concept implementation for using WASM imports instead of `addFunction` to provide PGlite's read/write callbacks, enabling Cloudflare Workers compatibility.

## Problem

PGlite currently uses Emscripten's `addFunction` to create JavaScript callbacks at runtime:

```typescript
this.#pglite_write = this.mod.addFunction((ptr, length) => {
  // callback implementation
}, 'iii')
```

This requires runtime WASM code generation, which is blocked in Cloudflare Workers:

```
Error: WebAssembly.Module(): Wasm code generation disallowed by embedder
```

## Solution

Instead of dynamically creating callbacks, we declare them as **WASM imports** in the C code. JavaScript provides implementations at instantiation time - no runtime code generation needed.

### Architecture

```
JavaScript                              WASM (C code)
-----------                             -------------

createPGliteWasmImports()
    |
    | Define callback implementations
    |
    +---> WebAssembly.instantiate(wasmModule, {
              env: {
                pglite_js_read: readCallback,    <-- No code gen!
                pglite_js_write: writeCallback   <-- No code gen!
              }
          })
              |
              +---> recv() calls pglite_js_read (imported)
              |     send() calls pglite_js_write (imported)
              |
              +---> Module instantiates with callbacks already bound
```

### C Code Changes

```c
// Declare as imports (provided by JavaScript at instantiation)
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_read")))
extern ssize_t pglite_js_read(void *buffer, size_t max_length);

__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_write")))
extern ssize_t pglite_js_write(void *buffer, size_t length);

// Use directly - no function pointers needed
ssize_t recv(int fd, void *buf, size_t n, int flags) {
    return pglite_js_read(buf, n);
}
```

### JavaScript Changes

```typescript
import { createPGliteWasmImports, instantiateWasmWithImports } from './pglite-wasm-imports'

// Create handler BEFORE instantiation
const handler = createPGliteWasmImports()

const mod = await PostgresModFactory({
  instantiateWasm: (imports, callback) => {
    instantiateWasmWithImports(imports, handler, wasmModule)
      .then(({ instance, module }) => callback(instance, module))
    return {}
  }
})

// Set module reference AFTER instantiation
handler.setModule(mod)

// Execute queries - NO addFunction calls needed!
handler.setInput(queryBytes)
mod._interactive_one(queryBytes.length, queryBytes[0])
const results = handler.getOutput()
handler.reset()
```

## Files

| File | Description |
|------|-------------|
| `pglite-comm-imports.h` | Modified C header with WASM import declarations |
| `pglite-wasm-imports.ts` | TypeScript handler for WASM imports |
| `pglite-with-imports.ts` | Example integration showing pglite.ts modifications |
| `pglite-imports.ts` | Original basic handler (simpler implementation) |
| `test-imports.ts` | Unit tests (requires vitest) |
| `wasm-imports-integration.test.ts` | Integration tests (requires vitest) |
| `standalone-test.ts` | Standalone tests (no dependencies) |
| `IMPLEMENTATION_PLAN.md` | Full implementation plan and timeline |
| `README.md` | This file |

## Running Tests

### Standalone Test (recommended - no dependencies)

```bash
cd /Users/nathanclevenger/projects/pocs/packages/pglite-fork
pnpm exec tsx poc/wasm-imports/standalone-test.ts
```

### With Vitest (requires dependencies)

```bash
cd /Users/nathanclevenger/projects/pocs/packages/pglite-fork/packages/pglite
pnpm exec vitest run ../../poc/wasm-imports/test-imports.ts
```

## Implementation Status

- [x] C header with import declarations
- [x] TypeScript import handler
- [x] Unit tests (mocked WASM)
- [x] Integration example code
- [x] Implementation plan document
- [ ] Rebuild PGlite WASM with new header
- [ ] Full pglite.ts integration
- [ ] Test in Cloudflare Workers

## How It Works

1. **C Code**: `pglite-comm-imports.h` declares `pglite_js_read` and `pglite_js_write` as external imports using Emscripten attributes.

2. **Emscripten Build**: When compiled, Emscripten generates a WASM module that **requires** these imports to be provided.

3. **JavaScript**: The import handler (`pglite-wasm-imports.ts`) creates callback implementations that manage query I/O.

4. **Instantiation**: When `WebAssembly.instantiate` is called, we provide our callbacks in the imports object.

5. **Runtime**: WASM calls `recv()` and `send()`, which call our imported functions. No `addFunction` needed.

## Key Benefits

| Benefit | Description |
|---------|-------------|
| **Workers Compatible** | No runtime code generation |
| **Cleaner Architecture** | Uses native WASM import/export pattern |
| **Type Safety** | Import signatures validated at link time |
| **Simpler Code** | No function pointer management |
| **Debuggable** | Clear import/export contract in WASM |

## Comparison with Other Approaches

| Approach | Workers Compatible | Requires C Changes | Complexity |
|----------|-------------------|-------------------|------------|
| `addFunction` (original) | No | No | Low |
| Pre-compiled Wrappers | Yes | No | Medium |
| **WASM Imports** | **Yes** | **Yes** | **Low** |
| Memory Polling | Yes | Yes | High |

## Next Steps

See `IMPLEMENTATION_PLAN.md` for detailed next steps, including:

1. Rebuild WASM with pglite-comm-imports.h
2. Modify build-pglite.sh to remove ALLOW_TABLE_GROWTH
3. Integrate handler into packages/pglite/src/pglite.ts
4. Test in Miniflare/Cloudflare Workers

## See Also

- `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/SPIKE_WASM_IMPORTS.md` - Original spike document
- `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/SPIKE_MEMORY_POLLING.md` - Alternative approaches
- `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/SPIKE_PRECOMPILED_WRAPPERS.md` - Current interim solution
