/**
 * pglite-comm-trampoline.h
 *
 * Modified version of pglite-comm.h that uses EM_JS trampolines
 * instead of function pointers set via addFunction.
 *
 * This is a drop-in replacement for postgres-pglite/pglite/includes/pglite-comm.h
 * that works in Cloudflare Workers (no runtime WASM compilation).
 *
 * The key changes:
 * 1. Remove pglite_read/pglite_write function pointers
 * 2. Remove set_read_write_cbs function
 * 3. Use EM_JS trampolines that call Module._pgliteCallbacks directly
 *
 * Usage:
 * 1. Copy this file to postgres-pglite/pglite/includes/pglite-comm.h
 * 2. Rebuild postgres-pglite
 * 3. Use pglite-trampoline.ts instead of addFunction in pglite.ts
 */

#if defined(__EMSCRIPTEN__)

#ifndef PGLITE_COMM_H
#define PGLITE_COMM_H

#include <emscripten/emscripten.h>
#include <emscripten/em_js.h>

volatile int querylen = 0;
volatile FILE* queryfp = NULL;

/*
 * ============================================================================
 * TRAMPOLINE APPROACH - No addFunction Required
 * ============================================================================
 *
 * Instead of using function pointers (which require addFunction for JS callbacks),
 * we use EM_JS to directly invoke JavaScript functions stored in Module._pgliteCallbacks.
 *
 * The JavaScript side sets up callbacks like this:
 *
 *   Module._pgliteCallbacks = {
 *     read: (ptr, maxLength) => {
 *       // Copy data to WASM memory at ptr
 *       // Return number of bytes copied
 *     },
 *     write: (ptr, length) => {
 *       // Read data from WASM memory at ptr
 *       // Return number of bytes processed
 *     }
 *   };
 *
 * This completely avoids runtime WASM compilation.
 */

/**
 * EM_JS trampoline for reading data from JavaScript.
 * Called by recv() when PostgreSQL needs input data.
 */
EM_JS(ssize_t, pglite_read_trampoline, (void* buffer, size_t max_length), {
    // Check if callbacks are set up
    if (!Module._pgliteCallbacks || !Module._pgliteCallbacks.read) {
        // No callback registered - this shouldn't happen in normal operation
        console.error('pglite_read_trampoline: no read callback registered');
        return 0;  // Return 0 bytes read (EOF-like behavior)
    }

    // Call the JavaScript read callback
    try {
        return Module._pgliteCallbacks.read(buffer, max_length);
    } catch (e) {
        console.error('pglite_read_trampoline error:', e);
        return -1;  // Return error
    }
});

/**
 * EM_JS trampoline for writing data to JavaScript.
 * Called by send() when PostgreSQL has output data.
 */
EM_JS(ssize_t, pglite_write_trampoline, (const void* buffer, size_t length), {
    if (!Module._pgliteCallbacks || !Module._pgliteCallbacks.write) {
        console.error('pglite_write_trampoline: no write callback registered');
        return -1;
    }

    try {
        return Module._pgliteCallbacks.write(buffer, length);
    } catch (e) {
        console.error('pglite_write_trampoline error:', e);
        return -1;
    }
});

/**
 * Initialize the callback storage.
 * Called once during module initialization.
 */
EM_JS(void, pglite_init_callbacks, (void), {
    if (!Module._pgliteCallbacks) {
        Module._pgliteCallbacks = {
            read: null,
            write: null
        };
        // console.log('PGlite callback storage initialized');
    }
});

/**
 * Export function for JavaScript to check if callbacks are set.
 * Useful for debugging.
 */
__attribute__((export_name("pglite_callbacks_ready")))
int pglite_callbacks_ready(void) {
    // This will be called from JS, so we use EM_JS to check
    // For now, just return 1 (assume ready after init)
    return 1;
}

/*
 * Dummy socket functions (unchanged from original)
 */

int EMSCRIPTEN_KEEPALIVE fcntl(int __fd, int __cmd, ...) {
    return 0;
}

int EMSCRIPTEN_KEEPALIVE setsockopt(int __fd, int __level, int __optname,
    const void *__optval, socklen_t __optlen) {
    return 0;
}

int EMSCRIPTEN_KEEPALIVE getsockopt(int __fd, int __level, int __optname,
    void *__restrict __optval,
    socklen_t *__restrict __optlen) {
    return 0;
}

int EMSCRIPTEN_KEEPALIVE getsockname(int __fd, struct sockaddr * __addr,
    socklen_t *__restrict __len) {
    return 0;
}

/*
 * recv/send - Use trampolines instead of function pointers
 */

ssize_t EMSCRIPTEN_KEEPALIVE
recv(int __fd, void *__buf, size_t __n, int __flags) {
    // Use trampoline instead of function pointer
    ssize_t got = pglite_read_trampoline(__buf, __n);
    return got;
}

ssize_t EMSCRIPTEN_KEEPALIVE
send(int __fd, const void *__buf, size_t __n, int __flags) {
    // Use trampoline instead of function pointer
    ssize_t wrote = pglite_write_trampoline(__buf, __n);
    return wrote;
}

int EMSCRIPTEN_KEEPALIVE
connect(int socket, const struct sockaddr *address, socklen_t address_len) {
    return 0;
}

struct pollfd {
    int   fd;
    short events;
    short revents;
};

int EMSCRIPTEN_KEEPALIVE
poll(struct pollfd fds[], ssize_t nfds, int timeout) {
    return nfds;
}

/*
 * ============================================================================
 * BACKWARD COMPATIBILITY LAYER
 * ============================================================================
 *
 * For existing code that calls set_read_write_cbs(), we provide a no-op
 * implementation. The actual callbacks are set via Module._pgliteCallbacks.
 */

/**
 * Legacy function pointer types (kept for reference)
 */
typedef ssize_t (*pglite_read_t)(void *buffer, size_t max_length);
typedef ssize_t (*pglite_write_t)(void *buffer, size_t length);

/**
 * No-op for backward compatibility.
 * In the trampoline approach, callbacks are set via Module._pgliteCallbacks,
 * not via function pointers.
 *
 * This function is still exported so existing JS code doesn't break,
 * but it does nothing. The JS code should instead set Module._pgliteCallbacks.
 */
__attribute__((export_name("set_read_write_cbs")))
void set_read_write_cbs(pglite_read_t read_cb, pglite_write_t write_cb) {
    // No-op in trampoline mode
    // Callbacks are set via Module._pgliteCallbacks in JavaScript
    (void)read_cb;
    (void)write_cb;
}

#endif // PGLITE_COMM_H

#endif // __EMSCRIPTEN__
