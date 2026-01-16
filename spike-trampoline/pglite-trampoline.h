/**
 * pglite-trampoline.h
 *
 * Pyodide-style JavaScript trampolines for PGlite.
 * This approach uses wasmTable.get() directly instead of Emscripten's addFunction,
 * which requires runtime WASM compilation (blocked in Cloudflare Workers).
 *
 * The key insight from Pyodide's implementation:
 * - Function pointers in WASM are indices into the function table (wasmTable)
 * - JavaScript can access wasmTable.get(index) to call any function in the table
 * - By using EM_JS, we can create C-callable functions that invoke JS trampolines
 * - The trampolines look up functions by index and call them with the right args
 *
 * Reference: https://blog.pyodide.org/posts/function-pointer-cast-handling/
 */

#ifndef PGLITE_TRAMPOLINE_H
#define PGLITE_TRAMPOLINE_H

#include <emscripten.h>
#include <emscripten/em_js.h>
#include <stdint.h>
#include <stddef.h>

/**
 * Reserved function table indices for PGlite callbacks.
 * These slots are pre-allocated at compile time using -sRESERVED_FUNCTION_POINTERS=2
 * JavaScript will populate these slots at runtime without needing addFunction.
 */
#define PGLITE_READ_SLOT  1
#define PGLITE_WRITE_SLOT 2

/**
 * Global variables to hold the function table indices.
 * These are set by JavaScript before any I/O operations.
 */
static volatile uint32_t g_pglite_read_fptr = 0;
static volatile uint32_t g_pglite_write_fptr = 0;

/**
 * Trampoline for the read callback.
 *
 * This EM_JS macro creates a C function that:
 * 1. Takes a function pointer (table index) and arguments
 * 2. Calls into JavaScript
 * 3. Uses wasmTable.get() to look up the actual function
 * 4. Invokes it and returns the result
 *
 * The signature 'iii' means: returns int, takes (int, int) = (ptr, max_length)
 */
EM_JS(int, pglite_read_trampoline, (uint32_t fptr, void* buffer, size_t max_length), {
    // Look up the function in the WASM function table
    var func = wasmTable.get(fptr);
    if (!func) {
        console.error('pglite_read_trampoline: invalid function pointer', fptr);
        return -1;
    }
    // Call the function with the provided arguments
    // JavaScript's flexible argument handling means extra/missing args won't crash
    return func(buffer, max_length);
});

/**
 * Trampoline for the write callback.
 * Similar to read but for output data.
 */
EM_JS(int, pglite_write_trampoline, (uint32_t fptr, void* buffer, size_t length), {
    var func = wasmTable.get(fptr);
    if (!func) {
        console.error('pglite_write_trampoline: invalid function pointer', fptr);
        return -1;
    }
    return func(buffer, length);
});

/**
 * Set the function pointers for read/write callbacks.
 * These are the table indices, not actual function pointers.
 *
 * @param read_fptr  Index in wasmTable for the read callback
 * @param write_fptr Index in wasmTable for the write callback
 */
__attribute__((export_name("set_trampoline_callbacks")))
void set_trampoline_callbacks(uint32_t read_fptr, uint32_t write_fptr) {
    g_pglite_read_fptr = read_fptr;
    g_pglite_write_fptr = write_fptr;
}

/**
 * Read function that uses the trampoline.
 * This replaces the direct pglite_read() function pointer call.
 */
static inline ssize_t pglite_trampoline_read(void* buffer, size_t max_length) {
    if (g_pglite_read_fptr == 0) {
        // Fallback: no callback set, return error
        return -1;
    }
    return pglite_read_trampoline(g_pglite_read_fptr, buffer, max_length);
}

/**
 * Write function that uses the trampoline.
 * This replaces the direct pglite_write() function pointer call.
 */
static inline ssize_t pglite_trampoline_write(void* buffer, size_t length) {
    if (g_pglite_write_fptr == 0) {
        return -1;
    }
    return pglite_write_trampoline(g_pglite_write_fptr, buffer, length);
}

/**
 * Override recv/send to use trampolines.
 * These replace the implementations in pglite-comm.h
 */
#ifdef PGLITE_USE_TRAMPOLINE

#undef recv
#undef send

ssize_t EMSCRIPTEN_KEEPALIVE recv(int __fd, void *__buf, size_t __n, int __flags) {
    return pglite_trampoline_read(__buf, __n);
}

ssize_t EMSCRIPTEN_KEEPALIVE send(int __fd, const void *__buf, size_t __n, int __flags) {
    return pglite_trampoline_write((void*)__buf, __n);
}

#endif // PGLITE_USE_TRAMPOLINE

#endif // PGLITE_TRAMPOLINE_H
