/**
 * test-wasm.c
 *
 * Minimal WASM module to test memory polling communication.
 * This simulates the PostgreSQL recv/send pattern without actual PostgreSQL.
 *
 * Build with:
 *   emcc -O2 -o test-polling.js test-wasm.c \
 *     -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAP32 \
 *     -sNO_EXIT_RUNTIME=1 -sMODULARIZE=1 -sEXPORT_ES6=1 \
 *     -sEXPORT_NAME=TestModule
 */

#include <stdint.h>
#include <string.h>
#include <stdio.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT_NAME(name) __attribute__((export_name(#name)))
#define KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT_NAME(name)
#define KEEPALIVE
#endif

/* ============================================================================
 * Shared Memory Structures (matching pglite-comm-polling.h)
 * ============================================================================ */

#define BUFFER_SIZE (64 * 1024)

typedef enum {
    BUFFER_EMPTY = 0,
    BUFFER_READY = 1,
    BUFFER_PROCESSING = 2
} BufferStatus;

typedef enum {
    OP_NONE = 0,
    OP_READ_REQUEST = 1,
    OP_WRITE_READY = 2,
    OP_COMPLETED = 3,
    OP_ERROR = 4
} OperationType;

typedef struct {
    volatile uint32_t status;
    volatile uint32_t length;
    uint8_t data[BUFFER_SIZE];
} __attribute__((packed)) Buffer;

typedef struct {
    volatile uint32_t operation;
    volatile int32_t error_code;
    volatile uint32_t read_offset;
    volatile uint32_t total_read;
    volatile uint32_t total_written;
} __attribute__((packed)) Control;

/* Global shared memory */
static Buffer g_input;
static Buffer g_output;
static Control g_control;

/* ============================================================================
 * Exported Accessors
 * ============================================================================ */

EXPORT_NAME(get_input_buffer)
void* KEEPALIVE get_input_buffer(void) { return &g_input; }

EXPORT_NAME(get_output_buffer)
void* KEEPALIVE get_output_buffer(void) { return &g_output; }

EXPORT_NAME(get_control)
void* KEEPALIVE get_control(void) { return &g_control; }

EXPORT_NAME(get_buffer_size)
uint32_t KEEPALIVE get_buffer_size(void) { return BUFFER_SIZE; }

/* ============================================================================
 * Buffer Management
 * ============================================================================ */

EXPORT_NAME(reset_buffers)
void KEEPALIVE reset_buffers(void) {
    g_input.status = BUFFER_EMPTY;
    g_input.length = 0;
    g_output.status = BUFFER_EMPTY;
    g_output.length = 0;
    g_control.operation = OP_NONE;
    g_control.error_code = 0;
    g_control.read_offset = 0;
    g_control.total_read = 0;
    g_control.total_written = 0;
}

EXPORT_NAME(signal_input_ready)
void KEEPALIVE signal_input_ready(uint32_t length) {
    g_input.length = length;
    g_input.status = BUFFER_READY;
    g_control.read_offset = 0;
}

EXPORT_NAME(has_output)
int KEEPALIVE has_output(void) {
    return g_output.status == BUFFER_READY ? 1 : 0;
}

EXPORT_NAME(get_output_length)
uint32_t KEEPALIVE get_output_length(void) {
    return g_output.length;
}

EXPORT_NAME(ack_output)
void KEEPALIVE ack_output(void) {
    g_output.status = BUFFER_EMPTY;
    g_output.length = 0;
}

/* ============================================================================
 * Internal Read/Write (simulating PostgreSQL's recv/send)
 * ============================================================================ */

static ssize_t internal_read(void *buf, size_t max_len) {
    if (g_input.status != BUFFER_READY) {
        return 0;
    }

    size_t available = g_input.length - g_control.read_offset;
    if (available == 0) {
        g_input.status = BUFFER_EMPTY;
        return 0;
    }

    size_t to_read = (max_len < available) ? max_len : available;
    memcpy(buf, g_input.data + g_control.read_offset, to_read);
    g_control.read_offset += to_read;
    g_control.total_read += to_read;

    if (g_control.read_offset >= g_input.length) {
        g_input.status = BUFFER_EMPTY;
    }

    return (ssize_t)to_read;
}

static ssize_t internal_write(const void *buf, size_t len) {
    if (g_output.length + len > BUFFER_SIZE) {
        g_output.status = BUFFER_READY;
        g_control.operation = OP_WRITE_READY;
        return -1;
    }

    memcpy(g_output.data + g_output.length, buf, len);
    g_output.length += len;
    g_control.total_written += len;

    return (ssize_t)len;
}

static void internal_flush(void) {
    if (g_output.length > 0) {
        g_output.status = BUFFER_READY;
        g_control.operation = OP_WRITE_READY;
    }
}

/* ============================================================================
 * Test Function: Echo with transformation
 * This simulates PostgreSQL query processing:
 * 1. Read input (query)
 * 2. Process it (echo back uppercase)
 * 3. Write output (result)
 * ============================================================================ */

EXPORT_NAME(process_message)
int KEEPALIVE process_message(void) {
    uint8_t local_buffer[1024];
    ssize_t bytes_read;

    // Read from input buffer
    bytes_read = internal_read(local_buffer, sizeof(local_buffer) - 1);
    if (bytes_read <= 0) {
        g_control.error_code = -1;
        g_control.operation = OP_ERROR;
        return -1;
    }

    // Null-terminate for string processing
    local_buffer[bytes_read] = '\0';

    // Process: convert to uppercase (simulating query processing)
    for (int i = 0; i < bytes_read; i++) {
        if (local_buffer[i] >= 'a' && local_buffer[i] <= 'z') {
            local_buffer[i] = local_buffer[i] - 'a' + 'A';
        }
    }

    // Write response header (simulating PostgreSQL protocol)
    uint8_t header[5];
    header[0] = 'R';  // Message type (simulating ReadyForQuery)
    uint32_t len = bytes_read + 4;  // length includes self
    header[1] = (len >> 24) & 0xFF;
    header[2] = (len >> 16) & 0xFF;
    header[3] = (len >> 8) & 0xFF;
    header[4] = len & 0xFF;

    internal_write(header, 5);
    internal_write(local_buffer, bytes_read);

    // Flush output
    internal_flush();

    g_control.operation = OP_COMPLETED;
    return 0;
}

/* ============================================================================
 * Test Function: Multiple write chunks
 * Simulates PostgreSQL sending multiple result rows
 * ============================================================================ */

EXPORT_NAME(process_multi_row)
int KEEPALIVE process_multi_row(int num_rows) {
    for (int i = 0; i < num_rows; i++) {
        char row_data[64];
        int len = snprintf(row_data, sizeof(row_data), "Row %d of %d\n", i + 1, num_rows);

        // Write row header
        uint8_t header[5];
        header[0] = 'D';  // DataRow message type
        uint32_t msg_len = len + 4;
        header[1] = (msg_len >> 24) & 0xFF;
        header[2] = (msg_len >> 16) & 0xFF;
        header[3] = (msg_len >> 8) & 0xFF;
        header[4] = msg_len & 0xFF;

        if (internal_write(header, 5) < 0) {
            g_control.error_code = -2;
            g_control.operation = OP_ERROR;
            return -1;
        }

        if (internal_write(row_data, len) < 0) {
            g_control.error_code = -3;
            g_control.operation = OP_ERROR;
            return -1;
        }
    }

    // Flush all output
    internal_flush();

    g_control.operation = OP_COMPLETED;
    return 0;
}

/* ============================================================================
 * Main (required for Emscripten)
 * ============================================================================ */

int main(void) {
    reset_buffers();
    printf("Test WASM module initialized\n");
    printf("Input buffer at: %p\n", &g_input);
    printf("Output buffer at: %p\n", &g_output);
    printf("Control block at: %p\n", &g_control);
    return 0;
}
