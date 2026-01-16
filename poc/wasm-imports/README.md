# WASM Imports POC for PGlite

This directory contains a proof-of-concept implementation for using WASM imports instead of `addFunction` to provide PGlite's read/write callbacks.

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

### C Code Changes

```c
// Declare as imports (provided by JavaScript at instantiation)
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_read")))
extern ssize_t pglite_js_read(void *buffer, size_t max_length);

__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_write")))
extern ssize_t pglite_js_write(void *buffer, size_t length);

// Use directly
ssize_t recv(int fd, void *buf, size_t n, int flags) {
    return pglite_js_read(buf, n);
}
```

### JavaScript Changes

```typescript
const handler = createPGliteImportHandler()

const mod = await PostgresModFactory({
  instantiateWasm: (imports, callback) => {
    const merged = {
      ...imports,
      env: { ...imports.env, ...handler.imports }
    }
    WebAssembly.instantiate(wasmModule, merged)
      .then(instance => callback(instance, wasmModule))
    return {}
  }
})

handler.setModule(mod)

// Execute queries
handler.setInput(queryBytes)
mod._interactive_one(queryBytes.length, queryBytes[0])
const results = handler.getOutput()
```

## Files

| File | Description |
|------|-------------|
| `pglite-comm-imports.h` | Modified C header with import declarations |
| `pglite-imports.ts` | TypeScript implementation of import handler |
| `test-imports.ts` | Unit tests for the import handler |
| `README.md` | This file |

## Running Tests

```bash
cd /Users/nathanclevenger/projects/pocs/packages/pglite-fork
npx vitest run poc/wasm-imports/test-imports.ts
```

## Implementation Status

- [x] C header with import declarations
- [x] TypeScript import handler
- [x] Unit tests (mocked WASM)
- [ ] Rebuild PGlite WASM with new header
- [ ] Integration tests with real WASM
- [ ] Test in Cloudflare Workers

## How It Works

1. **C Code**: `pglite-comm-imports.h` declares `pglite_js_read` and `pglite_js_write` as external imports using Emscripten attributes.

2. **Emscripten Build**: When compiled, Emscripten generates a WASM module that **requires** these imports to be provided.

3. **JavaScript**: The import handler (`pglite-imports.ts`) creates the callback implementations that manage query I/O.

4. **Instantiation**: When `WebAssembly.instantiate` is called, we provide our callbacks in the imports object.

5. **Runtime**: WASM calls `recv()` and `send()`, which call our imported functions. No `addFunction` needed.

## Key Benefits

| Benefit | Description |
|---------|-------------|
| **Workers Compatible** | No runtime code generation |
| **Cleaner Architecture** | Callbacks defined at natural point |
| **Type Safety** | Import signatures validated at link time |
| **Smaller WASM** | No function table growth machinery |
| **Debuggable** | Clear import/export contract |

## See Also

- `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/SPIKE_WASM_IMPORTS.md` - Full spike document
- `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/SPIKE_MEMORY_POLLING.md` - Alternative approaches
