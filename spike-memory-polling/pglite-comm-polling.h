/**
 * pglite-comm-polling.h
 *
 * Memory-based communication for PGlite that avoids addFunction.
 * This header defines shared memory structures and functions for
 * bidirectional communication between JavaScript and WASM without
 * requiring runtime WASM code generation.
 *
 * SPIKE 3: Shared memory polling instead of callbacks
 */

#ifndef PGLITE_COMM_POLLING_H
#define PGLITE_COMM_POLLING_H

#include <stdint.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT __attribute__((export_name(#name)))
#define EXPORT_NAME(name) __attribute__((export_name(#name)))
#define KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT_NAME(name)
#define KEEPALIVE
#endif

/**
 * Buffer sizes and limits
 */
#define PGLITE_BUFFER_SIZE (64 * 1024)  // 64KB per buffer
#define PGLITE_MAX_MESSAGE_SIZE (1024 * 1024)  // 1MB max message

/**
 * Buffer status flags
 */
typedef enum {
    BUFFER_EMPTY = 0,      // No data in buffer
    BUFFER_READY = 1,      // Data ready to be consumed
    BUFFER_PROCESSING = 2  // Currently being processed
} BufferStatus;

/**
 * Operation types for control block
 */
typedef enum {
    OP_NONE = 0,           // Idle
    OP_READ_REQUEST = 1,   // WASM needs input data
    OP_WRITE_READY = 2,    // WASM has output data
    OP_COMPLETED = 3,      // Operation completed
    OP_ERROR = 4           // Error occurred
} OperationType;

/**
 * Shared buffer structure
 * Layout is designed for easy access from both JS and C:
 * - 4 bytes: status (u32)
 * - 4 bytes: length (u32)
 * - N bytes: data
 */
typedef struct {
    volatile uint32_t status;   // BufferStatus
    volatile uint32_t length;   // Current data length
    uint8_t data[PGLITE_BUFFER_SIZE];
} __attribute__((packed)) PGliteBuffer;

/**
 * Control block for synchronization
 */
typedef struct {
    volatile uint32_t operation;  // OperationType
    volatile int32_t error_code;  // Error code if any
    volatile uint32_t read_offset; // Current read position in input
    volatile uint32_t total_read;  // Total bytes read so far
    volatile uint32_t total_written; // Total bytes written so far
} __attribute__((packed)) PGliteControl;

/**
 * Global shared memory regions
 * These are exported and accessible from JavaScript
 */
static PGliteBuffer g_input_buffer;
static PGliteBuffer g_output_buffer;
static PGliteControl g_control;

/* ============================================================================
 * Exported Functions for JavaScript Access
 * ============================================================================ */

/**
 * Get pointer to input buffer (for JS to write query data)
 */
EXPORT_NAME(pglite_get_input_buffer)
void* KEEPALIVE pglite_get_input_buffer(void) {
    return &g_input_buffer;
}

/**
 * Get pointer to output buffer (for JS to read results)
 */
EXPORT_NAME(pglite_get_output_buffer)
void* KEEPALIVE pglite_get_output_buffer(void) {
    return &g_output_buffer;
}

/**
 * Get pointer to control block (for JS to check status)
 */
EXPORT_NAME(pglite_get_control)
void* KEEPALIVE pglite_get_control(void) {
    return &g_control;
}

/**
 * Get buffer size constant
 */
EXPORT_NAME(pglite_get_buffer_size)
uint32_t KEEPALIVE pglite_get_buffer_size(void) {
    return PGLITE_BUFFER_SIZE;
}

/**
 * Signal that input data is ready for WASM to read
 * Called by JavaScript after writing data to input buffer
 */
EXPORT_NAME(pglite_signal_input_ready)
void KEEPALIVE pglite_signal_input_ready(uint32_t length) {
    g_input_buffer.length = length;
    g_input_buffer.status = BUFFER_READY;
    g_control.read_offset = 0;
}

/**
 * Reset buffers for a new operation
 * Called by JavaScript before starting a new query
 */
EXPORT_NAME(pglite_reset_buffers)
void KEEPALIVE pglite_reset_buffers(void) {
    g_input_buffer.status = BUFFER_EMPTY;
    g_input_buffer.length = 0;
    g_output_buffer.status = BUFFER_EMPTY;
    g_output_buffer.length = 0;
    g_control.operation = OP_NONE;
    g_control.error_code = 0;
    g_control.read_offset = 0;
    g_control.total_read = 0;
    g_control.total_written = 0;
}

/**
 * Check if output data is available
 * Returns: 1 if data ready, 0 otherwise
 */
EXPORT_NAME(pglite_has_output)
int KEEPALIVE pglite_has_output(void) {
    return g_output_buffer.status == BUFFER_READY ? 1 : 0;
}

/**
 * Get output length
 */
EXPORT_NAME(pglite_get_output_length)
uint32_t KEEPALIVE pglite_get_output_length(void) {
    return g_output_buffer.length;
}

/**
 * Acknowledge that output has been consumed
 * Called by JavaScript after reading output buffer
 */
EXPORT_NAME(pglite_ack_output)
void KEEPALIVE pglite_ack_output(void) {
    g_output_buffer.status = BUFFER_EMPTY;
    g_output_buffer.length = 0;
}

/* ============================================================================
 * Internal Functions (Called from C/WASM side)
 * ============================================================================ */

/**
 * Read data from input buffer (called by PostgreSQL's recv())
 * This replaces the pglite_read callback
 */
static ssize_t pglite_polling_read(void *buf, size_t max_len) {
    // Check if input data is available
    if (g_input_buffer.status != BUFFER_READY) {
        // No data available - in async mode, this would yield
        // For now, return 0 (EOF-like)
        return 0;
    }

    // Calculate available data
    size_t available = g_input_buffer.length - g_control.read_offset;
    if (available == 0) {
        // All data consumed
        g_input_buffer.status = BUFFER_EMPTY;
        return 0;
    }

    // Copy data
    size_t to_read = (max_len < available) ? max_len : available;
    memcpy(buf, g_input_buffer.data + g_control.read_offset, to_read);
    g_control.read_offset += to_read;
    g_control.total_read += to_read;

    // Mark as empty if all data consumed
    if (g_control.read_offset >= g_input_buffer.length) {
        g_input_buffer.status = BUFFER_EMPTY;
    }

    return (ssize_t)to_read;
}

/**
 * Write data to output buffer (called by PostgreSQL's send())
 * This replaces the pglite_write callback
 */
static ssize_t pglite_polling_write(const void *buf, size_t len) {
    // Check if buffer has space
    if (g_output_buffer.length + len > PGLITE_BUFFER_SIZE) {
        // Buffer full - signal to JS that it needs to consume
        g_output_buffer.status = BUFFER_READY;
        g_control.operation = OP_WRITE_READY;
        // Return error - buffer full
        return -1;
    }

    // Copy data to output buffer
    memcpy(g_output_buffer.data + g_output_buffer.length, buf, len);
    g_output_buffer.length += len;
    g_control.total_written += len;

    return (ssize_t)len;
}

/**
 * Flush output buffer - mark as ready for JS to consume
 */
static void pglite_polling_flush(void) {
    if (g_output_buffer.length > 0) {
        g_output_buffer.status = BUFFER_READY;
        g_control.operation = OP_WRITE_READY;
    }
}

/* ============================================================================
 * Override recv/send to use polling buffers
 * ============================================================================ */

#ifdef PGLITE_USE_POLLING

// Replace the callback-based recv/send with polling versions
#undef recv
#undef send

ssize_t KEEPALIVE recv(int __fd, void *__buf, size_t __n, int __flags) {
    return pglite_polling_read(__buf, __n);
}

ssize_t KEEPALIVE send(int __fd, const void *__buf, size_t __n, int __flags) {
    ssize_t result = pglite_polling_write(__buf, __n);
    // Flush after each send for simplicity
    pglite_polling_flush();
    return result;
}

#endif // PGLITE_USE_POLLING

#endif // PGLITE_COMM_POLLING_H
