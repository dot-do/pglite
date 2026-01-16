/**
 * pglite-trampoline-v2.h
 *
 * Advanced Pyodide-style JavaScript trampolines for PGlite.
 *
 * This version uses a different approach: instead of passing function pointers,
 * we use EM_JS to directly execute JavaScript callbacks stored in a global object.
 * This completely eliminates the need for function table manipulation.
 *
 * Key insight: EM_JS functions run JavaScript directly, so we can:
 * 1. Store JS callbacks in a global object (Module._pgliteCallbacks)
 * 2. Have the trampoline invoke these callbacks directly
 * 3. No wasmTable manipulation or addFunction needed
 *
 * This is the cleanest approach for Cloudflare Workers compatibility.
 */

#ifndef PGLITE_TRAMPOLINE_V2_H
#define PGLITE_TRAMPOLINE_V2_H

#include <emscripten.h>
#include <emscripten/em_js.h>
#include <stdint.h>
#include <stddef.h>

/**
 * Read trampoline - directly invokes JavaScript callback.
 *
 * The JavaScript side must set up:
 *   Module._pgliteCallbacks = {
 *     read: (ptr, maxLength) => { ... return bytesRead; },
 *     write: (ptr, length) => { ... return bytesWritten; }
 *   };
 *
 * This completely bypasses the function table and addFunction.
 */
EM_JS(int, pglite_read_trampoline_v2, (void* buffer, size_t max_length), {
    // Check if callbacks are registered
    if (!Module._pgliteCallbacks || !Module._pgliteCallbacks.read) {
        console.error('pglite_read_trampoline_v2: no read callback registered');
        return -1;
    }

    // Call the JavaScript callback directly
    try {
        return Module._pgliteCallbacks.read(buffer, max_length);
    } catch (e) {
        console.error('pglite_read_trampoline_v2 error:', e);
        return -1;
    }
});

/**
 * Write trampoline - directly invokes JavaScript callback.
 */
EM_JS(int, pglite_write_trampoline_v2, (void* buffer, size_t length), {
    if (!Module._pgliteCallbacks || !Module._pgliteCallbacks.write) {
        console.error('pglite_write_trampoline_v2: no write callback registered');
        return -1;
    }

    try {
        return Module._pgliteCallbacks.write(buffer, length);
    } catch (e) {
        console.error('pglite_write_trampoline_v2 error:', e);
        return -1;
    }
});

/**
 * Initialize the trampoline system.
 * This creates the callback storage object in JavaScript.
 * Called once during module initialization.
 */
EM_JS(void, pglite_trampoline_init, (void), {
    if (!Module._pgliteCallbacks) {
        Module._pgliteCallbacks = {
            read: null,
            write: null
        };
    }
});

/**
 * recv/send implementations using v2 trampolines.
 * These directly call JavaScript without function pointers.
 */
#ifdef PGLITE_USE_TRAMPOLINE_V2

#undef recv
#undef send

ssize_t EMSCRIPTEN_KEEPALIVE recv(int __fd, void *__buf, size_t __n, int __flags) {
    return pglite_read_trampoline_v2(__buf, __n);
}

ssize_t EMSCRIPTEN_KEEPALIVE send(int __fd, const void *__buf, size_t __n, int __flags) {
    return pglite_write_trampoline_v2((void*)__buf, __n);
}

#endif // PGLITE_USE_TRAMPOLINE_V2

#endif // PGLITE_TRAMPOLINE_V2_H
