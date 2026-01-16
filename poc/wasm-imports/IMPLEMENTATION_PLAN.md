# WASM Imports Implementation Plan

**Date**: 2026-01-16
**Status**: READY FOR IMPLEMENTATION
**Issue**: pocs-uuv9

---

## Executive Summary

This document outlines the implementation plan for the WASM imports approach to make PGlite compatible with Cloudflare Workers. The approach is architecturally cleaner than the pre-compiled wrappers approach (pocs-f0k6) because:

1. Callbacks are declared as WASM imports at C compile time
2. No runtime wrapper generation or function table manipulation
3. Direct JavaScript function binding through Emscripten's import mechanism

---

## Current State

### What Exists

1. **C Header (`pglite-comm-imports.h`)**: Complete implementation with:
   - `pglite_js_read` and `pglite_js_write` import declarations
   - Modified `recv()` and `send()` that call imports directly
   - Removed `set_read_write_cbs` function

2. **TypeScript Handler (`pglite-wasm-imports.ts`)**: Complete implementation with:
   - `createPGliteWasmImports()` factory function
   - Input/output buffer management
   - Protocol message parsing
   - `instantiateWasmWithImports()` helper

3. **Integration Example (`pglite-with-imports.ts`)**: Shows how to modify `pglite.ts`

4. **Tests**: Unit tests for the handler (mocked WASM)

### What's Missing

1. **WASM Rebuild**: The PGlite WASM module needs to be rebuilt with `pglite-comm-imports.h`
2. **Integration Tests**: Tests with actual rebuilt WASM
3. **Full pglite.ts Integration**: Complete modification of the main PGlite class

---

## Implementation Steps

### Phase 1: C Code Changes (Requires WASM Rebuild)

**Location**: `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/postgres-pglite/pglite/includes/`

**Current File**: `pglite-comm.h` (uses trampoline approach)
**New File**: `pglite-comm-imports.h` (WASM imports approach)

**Action**: Replace the include or add a build flag to select which approach to use.

```bash
# Option 1: Direct replacement
cp poc/wasm-imports/pglite-comm-imports.h \
   postgres-pglite/pglite/includes/pglite-comm.h

# Option 2: Conditional compilation (preferred for flexibility)
# Add to pglite-comm.h:
# #ifdef PGLITE_USE_WASM_IMPORTS
# #include "pglite-comm-imports.h"
# #else
# // ... existing trampoline code ...
# #endif
```

### Phase 2: Build System Changes

**Location**: `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/postgres-pglite/build-pglite.sh`

**Changes Required**:

1. **Remove ALLOW_TABLE_GROWTH** (line ~46 and ~89):
   ```bash
   # BEFORE (current):
   EXPORTED_RUNTIME_METHODS="MEMFS,IDBFS,FS,setValue,getValue,UTF8ToString,stringToNewUTF8,stringToUTF8OnStack,wasmTable"

   # AFTER (WASM imports):
   EXPORTED_RUNTIME_METHODS="MEMFS,IDBFS,FS,setValue,getValue,UTF8ToString,stringToNewUTF8,stringToUTF8OnStack"
   # Note: wasmTable removed, as it's only needed for addFunction
   ```

2. **Add build flag for WASM imports mode** (optional):
   ```bash
   if [ "$PGLITE_WASM_IMPORTS" = true ]; then
       PGLITE_CFLAGS="$PGLITE_CFLAGS -DPGLITE_USE_WASM_IMPORTS"
   fi
   ```

3. **Verify imports in output**:
   ```bash
   # After build, verify the WASM module has the expected imports
   wasm-objdump -x dist/pglite.wasm | grep -E "pglite_js_(read|write)"
   ```

### Phase 3: TypeScript Integration

**Location**: `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/packages/pglite/src/pglite.ts`

**Changes**:

```typescript
// 1. Add imports
import {
  createPGliteWasmImports,
  instantiateWasmWithImports,
  type PGliteWasmImportsHandler
} from './wasm-imports/pglite-wasm-imports.js'

// 2. Add handler as class property
#wasmImportsHandler?: PGliteWasmImportsHandler

// 3. Modify #init() method
async #init(options: PGliteOptions) {
  // Create WASM imports handler BEFORE module instantiation
  this.#wasmImportsHandler = createPGliteWasmImports({
    debug: this.debug > 0,
    onMessage: (msg) => this.#parse(msg)
  })

  let emscriptenOpts: Partial<PostgresMod> = {
    // ... other options ...

    instantiateWasm: (imports, successCallback) => {
      instantiateWasmWithImports(
        imports,
        this.#wasmImportsHandler!,
        options.wasmModule!
      ).then(({ instance, module }) => {
        successCallback(instance, module)
      })
      return {}
    },
  }

  // Load module
  this.mod = await PostgresModFactory(emscriptenOpts)

  // Set module reference for imports to access WASM memory
  this.#wasmImportsHandler.setModule(this.mod)

  // REMOVED: addFunction and _set_read_write_cbs calls
  // The callbacks are now bound via WASM imports during instantiation

  // ... rest of init ...
}

// 4. Modify execProtocolRawSync
execProtocolRawSync(message: Uint8Array) {
  this.#wasmImportsHandler!.reset()
  this.#wasmImportsHandler!.setInput(message)

  this.mod!._interactive_one(message.length, message[0])

  return this.#wasmImportsHandler!.getOutput()
}

// 5. Simplify close() - no function pointer cleanup needed
async close() {
  // ... existing code ...

  // REMOVED:
  // if (this.#pglite_read !== -1) {
  //   this.mod!.removeFunction(this.#pglite_read)
  // }
  // if (this.#pglite_write !== -1) {
  //   this.mod!.removeFunction(this.#pglite_write)
  // }

  // ... rest of close ...
}
```

### Phase 4: Update TypeScript Types

**Location**: `/Users/nathanclevenger/projects/pocs/packages/pglite-fork/packages/pglite/src/postgresMod.ts`

**Changes**:

```typescript
export interface PostgresMod
  extends Omit<EmscriptenModule, 'preInit' | 'preRun' | 'postRun'> {
  // ... existing properties ...

  // REMOVED (no longer needed with WASM imports):
  // _set_read_write_cbs: (read_cb: number, write_cb: number) => void
  // addFunction: (cb: Function, signature: string) => number
  // removeFunction: (f: number) => void
  // wasmTable: WebAssembly.Table
}
```

### Phase 5: Testing

1. **Unit Tests**: Already exist in `poc/wasm-imports/wasm-imports-integration.test.ts`

2. **Integration Tests**: Create new test file:
   ```bash
   packages/pglite/tests/wasm-imports.test.ts
   ```

3. **Cloudflare Workers Test**: Test in Miniflare environment:
   ```bash
   cd packages/pglite-workers-test
   npm run test
   ```

---

## File Locations

| File | Purpose | Status |
|------|---------|--------|
| `poc/wasm-imports/pglite-comm-imports.h` | C header with WASM imports | Complete |
| `poc/wasm-imports/pglite-wasm-imports.ts` | TypeScript handler | Complete |
| `poc/wasm-imports/pglite-with-imports.ts` | Integration example | Complete |
| `poc/wasm-imports/wasm-imports-integration.test.ts` | Unit tests | Complete |
| `postgres-pglite/pglite/includes/pglite-comm.h` | Target location | Needs update |
| `postgres-pglite/build-pglite.sh` | Build configuration | Needs update |
| `packages/pglite/src/pglite.ts` | Main PGlite class | Needs update |
| `packages/pglite/src/postgresMod.ts` | Type definitions | Needs update |

---

## Comparison with Pre-compiled Wrappers Approach

| Aspect | Pre-compiled Wrappers | WASM Imports |
|--------|----------------------|--------------|
| Runtime code generation | None (pre-compiled) | None (imports) |
| C code changes | None | Required |
| Build changes | None | Minor |
| Architecture | Workaround | Native WASM pattern |
| Callback binding | Function table | Import/export |
| TypeScript complexity | Higher (wrapper management) | Lower (closures) |
| Performance | Indirect calls | Direct calls |
| Maintainability | Good | Better |

---

## Migration Path

### For Existing Users

The WASM imports approach is transparent to users. They don't need to change their code. The change is internal to how PGlite binds its callbacks to WASM.

### For Cloudflare Workers Users

1. Import the WASM module as a static import
2. Pass it to PGlite options as `wasmModule`
3. PGlite handles the rest internally

```typescript
import wasmModule from '@anthropic-pocs/pglite/pglite.wasm'

const pg = await PGlite.create({
  wasmModule,
  // ... other options
})
```

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| WASM rebuild complexity | Medium | Docker build environment exists |
| Breaking existing builds | High | Keep both approaches via build flag |
| Performance regression | Low | Direct calls should be faster |
| Memory management issues | Medium | Extensive testing |

---

## Next Steps

1. **Immediate**: Run existing unit tests to verify TypeScript implementation
   ```bash
   npx vitest run poc/wasm-imports/
   ```

2. **Short-term**: Rebuild WASM with new C header
   - Use existing Docker build infrastructure
   - Verify imports in WASM output

3. **Medium-term**: Full integration into pglite.ts
   - Replace addFunction approach
   - Update type definitions
   - Integration tests

4. **Long-term**: Make WASM imports the default
   - Remove pre-compiled wrappers code
   - Update documentation

---

## Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: C Code | 1 day | None |
| Phase 2: Build System | 0.5 day | Phase 1 |
| Phase 3: TypeScript | 1 day | Phase 2 |
| Phase 4: Types | 0.5 day | Phase 3 |
| Phase 5: Testing | 2 days | All above |
| **Total** | **5 days** | |

---

## Conclusion

The WASM imports approach is the cleanest architectural solution for Cloudflare Workers compatibility. The TypeScript implementation is complete and tested with mocked WASM. The remaining work is:

1. Rebuild PGlite WASM with the new C header
2. Integrate the TypeScript handler into `pglite.ts`
3. Verify in actual Cloudflare Workers environment

This approach should be the long-term solution, replacing both the original `addFunction` approach and the interim pre-compiled wrappers approach.
