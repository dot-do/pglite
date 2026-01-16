# Spike: Memory Polling Alternative to addFunction

This POC demonstrates how to replace Emscripten's `addFunction` with a shared memory
polling approach that works in Cloudflare Workers (where dynamic WASM generation is blocked).

## The Problem

PGlite uses `addFunction` to create callbacks that PostgreSQL's WASM code can invoke:

```typescript
// Current approach - requires runtime WASM generation
this.#pglite_write = mod.addFunction((ptr, length) => {
  // Process data from WASM
}, 'iii');
```

This fails in Cloudflare Workers with:
```
Error: WebAssembly.Module(): Wasm code generation disallowed by embedder
```

## The Solution: Memory Polling

Instead of callbacks, use shared memory buffers:

1. WASM writes to a memory buffer
2. JS polls the buffer
3. No function pointers needed

## Architecture

```
JavaScript Side                     WASM Side
--------------                      ---------

writeInput(data) -------> [INPUT_BUFFER]  <---- C reads from buffer
                          - status: u32
                          - length: u32
                          - data: u8[64KB]

readOutput() <----------- [OUTPUT_BUFFER] <---- C writes to buffer
                          - status: u32
                          - length: u32
                          - data: u8[64KB]

                          [CONTROL_BLOCK]
                          - operation: u32
                          - error: i32
```

## Files

- `pglite-comm-polling.h` - C header for shared memory communication
- `pglite-polling.ts` - TypeScript class demonstrating JS-side polling
- `test-wasm.c` - Minimal test WASM module (no PostgreSQL deps)
- `build.sh` - Build script for test WASM

## Building the Test POC

```bash
cd spike-memory-polling
./build.sh
```

## Testing

```bash
npx tsx test-polling.ts
```
