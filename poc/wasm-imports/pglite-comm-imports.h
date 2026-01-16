/**
 * PGlite Communication Layer - WASM Imports Version
 *
 * This header replaces the dynamic function pointer approach in pglite-comm.h
 * with WASM imports that are provided at module instantiation time.
 *
 * KEY CHANGE: Instead of using addFunction() at runtime to create callbacks,
 * we declare the callbacks as WASM imports. JavaScript provides implementations
 * when calling WebAssembly.instantiate(), before any WASM code runs.
 *
 * This eliminates the need for runtime WASM code generation, making PGlite
 * compatible with Cloudflare Workers and other restricted environments.
 *
 * Usage:
 *   1. Replace #include "pglite-comm.h" with #include "pglite-comm-imports.h"
 *   2. Remove ALLOW_TABLE_GROWTH from Emscripten build flags
 *   3. Remove addFunction/removeFunction from EXPORTED_RUNTIME_METHODS
 *   4. Provide pglite_js_read and pglite_js_write in WebAssembly imports
 *   5. Remove calls to _set_read_write_cbs in JavaScript
 */

#if defined(__EMSCRIPTEN__)

#ifndef PGLITE_COMM_IMPORTS_H
#define PGLITE_COMM_IMPORTS_H

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>

/* ============================================================================
 * QUERY STATE (shared with JavaScript)
 * ============================================================================ */

volatile int querylen = 0;
volatile FILE* queryfp = NULL;

/* ============================================================================
 * WASM IMPORT DECLARATIONS
 *
 * These functions are provided by JavaScript at WebAssembly instantiation time.
 * They replace the dynamically-registered function pointers from pglite-comm.h.
 *
 * The import_module and import_name attributes tell Emscripten to generate
 * WASM import entries instead of expecting local function definitions.
 * ============================================================================ */

/**
 * Read data FROM JavaScript into WASM memory buffer.
 *
 * Called by recv() when PostgreSQL needs to read query input.
 * JavaScript should copy query data into the buffer at the given pointer.
 *
 * @param buffer      Pointer to WASM memory where data should be written
 * @param max_length  Maximum number of bytes to read
 * @return            Number of bytes actually read (0 if no data available)
 *
 * JavaScript implementation should:
 *   1. Get the current query input buffer (set before _interactive_one)
 *   2. Copy up to max_length bytes into WASM memory at buffer pointer
 *   3. Track read position for subsequent calls
 *   4. Return actual bytes copied
 */
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_read")))
extern ssize_t pglite_js_read(void *buffer, size_t max_length);

/**
 * Write data TO JavaScript from WASM memory buffer.
 *
 * Called by send() when PostgreSQL needs to send query results.
 * JavaScript should read data from the buffer and process it.
 *
 * @param buffer  Pointer to WASM memory containing data to send
 * @param length  Number of bytes to write
 * @return        Number of bytes actually written
 *
 * JavaScript implementation should:
 *   1. Read 'length' bytes from WASM memory at buffer pointer
 *   2. Parse PostgreSQL protocol messages
 *   3. Accumulate results for the caller
 *   4. Return bytes processed (usually same as length)
 */
__attribute__((import_module("env")))
__attribute__((import_name("pglite_js_write")))
extern ssize_t pglite_js_write(void *buffer, size_t length);

/* ============================================================================
 * SOCKET FUNCTION OVERRIDES
 *
 * These functions override the standard socket API to use our WASM imports.
 * PostgreSQL calls these functions for network I/O, but in PGlite we redirect
 * them to JavaScript via the imported callback functions.
 * ============================================================================ */

/**
 * Override recv() to read from JavaScript instead of a socket.
 *
 * PostgreSQL calls this when it wants to read query data.
 * We delegate directly to our imported pglite_js_read function.
 */
ssize_t EMSCRIPTEN_KEEPALIVE
recv(int __fd, void *__buf, size_t __n, int __flags) {
    /* Delegate to JavaScript import - no function pointer indirection */
    ssize_t got = pglite_js_read(__buf, __n);
    return got;
}

/**
 * Override send() to write to JavaScript instead of a socket.
 *
 * PostgreSQL calls this when it wants to send result data.
 * We delegate directly to our imported pglite_js_write function.
 */
ssize_t EMSCRIPTEN_KEEPALIVE
send(int __fd, const void *__buf, size_t __n, int __flags) {
    /* Delegate to JavaScript import - no function pointer indirection */
    ssize_t wrote = pglite_js_write((void *)__buf, __n);
    return wrote;
}

/* ============================================================================
 * REMOVED: set_read_write_cbs
 *
 * This function was previously used to register callback function pointers
 * at runtime. With WASM imports, callbacks are set at instantiation time,
 * so this function is no longer needed.
 *
 * If you need to maintain backward compatibility, you can add a no-op stub:
 *
 * __attribute__((export_name("set_read_write_cbs")))
 * void set_read_write_cbs(void *read_cb, void *write_cb) {
 *     // No-op: callbacks are now provided as WASM imports
 * }
 * ============================================================================ */

/* ============================================================================
 * STUB IMPLEMENTATIONS FOR OTHER SOCKET FUNCTIONS
 *
 * These functions are required by PostgreSQL's network code but are not
 * meaningful in the PGlite context. They return success/no-op values.
 * ============================================================================ */

/**
 * Stub fcntl - file control operations
 * PostgreSQL uses this to set socket options like non-blocking mode.
 */
int EMSCRIPTEN_KEEPALIVE fcntl(int __fd, int __cmd, ...) {
    return 0; /* Success */
}

/**
 * Stub setsockopt - set socket options
 * PostgreSQL uses this to configure TCP options like TCP_NODELAY.
 */
int EMSCRIPTEN_KEEPALIVE setsockopt(int __fd, int __level, int __optname,
    const void *__optval, socklen_t __optlen) {
    return 0; /* Success */
}

/**
 * Stub getsockopt - get socket options
 * PostgreSQL may query socket state.
 */
int EMSCRIPTEN_KEEPALIVE getsockopt(int __fd, int __level, int __optname,
    void *__restrict __optval,
    socklen_t *__restrict __optlen) {
    return 0; /* Success */
}

/**
 * Stub getsockname - get socket address
 * PostgreSQL uses this to determine local address for logging.
 */
int EMSCRIPTEN_KEEPALIVE getsockname(int __fd, struct sockaddr *__addr,
    socklen_t *__restrict __len) {
    return 0; /* Success */
}

/**
 * Stub connect - initiate a connection
 * In PGlite there's no actual network connection.
 */
int EMSCRIPTEN_KEEPALIVE
connect(int socket, const struct sockaddr *address, socklen_t address_len) {
    return 0; /* Success - connection "established" */
}

/**
 * pollfd structure for poll() stub
 */
struct pollfd {
    int   fd;       /* file descriptor */
    short events;   /* requested events */
    short revents;  /* returned events */
};

/**
 * Stub poll - wait for events on file descriptors
 * PostgreSQL uses this to wait for socket activity.
 * We return immediately indicating all fds are ready.
 */
int EMSCRIPTEN_KEEPALIVE
poll(struct pollfd fds[], ssize_t nfds, int timeout) {
    return nfds; /* All fds ready */
}

#endif /* PGLITE_COMM_IMPORTS_H */

#endif /* __EMSCRIPTEN__ */
