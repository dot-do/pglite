/**
 * mock-wasm.ts
 *
 * A pure TypeScript mock of the WASM module for testing the polling
 * approach without requiring Emscripten compilation.
 *
 * This simulates the exact behavior of test-wasm.c in TypeScript.
 */

import type { PollingWasmModule } from './pglite-polling.js';

// Buffer size matching C code
const BUFFER_SIZE = 64 * 1024;

// Buffer status enum
const BufferStatus = {
  EMPTY: 0,
  READY: 1,
  PROCESSING: 2,
} as const;

// Operation types enum
const OperationType = {
  NONE: 0,
  READ_REQUEST: 1,
  WRITE_READY: 2,
  COMPLETED: 3,
  ERROR: 4,
} as const;

/**
 * Creates a mock WASM module that simulates the memory polling behavior.
 * The "memory" is implemented using ArrayBuffer/TypedArrays.
 */
export function createMockWasmModule(): PollingWasmModule {
  // Simulate WASM linear memory (1MB total)
  const memory = new ArrayBuffer(1024 * 1024);

  // Memory layout:
  // 0x0000 - 0xFFFF: Input buffer (64KB + 8 byte header)
  // 0x10000 - 0x1FFFF: Output buffer (64KB + 8 byte header)
  // 0x20000 - 0x20014: Control block (20 bytes)

  const INPUT_BUFFER_OFFSET = 0;
  const OUTPUT_BUFFER_OFFSET = 0x10008;
  const CONTROL_OFFSET = 0x20000;

  // Create typed array views
  const HEAPU8 = new Uint8Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  const HEAP32 = new Int32Array(memory);

  // Helper to get buffer data pointer (after 8-byte header)
  const inputDataOffset = INPUT_BUFFER_OFFSET + 8;
  const outputDataOffset = OUTPUT_BUFFER_OFFSET + 8;

  // Control block field offsets (in bytes)
  const controlU32Base = CONTROL_OFFSET / 4;

  /**
   * Internal: Read from input buffer
   */
  function internalRead(maxLen: number): { data: Uint8Array; bytesRead: number } {
    const inputStatus = HEAPU32[INPUT_BUFFER_OFFSET / 4];
    const inputLength = HEAPU32[INPUT_BUFFER_OFFSET / 4 + 1];
    const readOffset = HEAPU32[controlU32Base + 2]; // read_offset

    if (inputStatus !== BufferStatus.READY) {
      return { data: new Uint8Array(0), bytesRead: 0 };
    }

    const available = inputLength - readOffset;
    if (available === 0) {
      HEAPU32[INPUT_BUFFER_OFFSET / 4] = BufferStatus.EMPTY;
      return { data: new Uint8Array(0), bytesRead: 0 };
    }

    const toRead = Math.min(maxLen, available);
    const data = HEAPU8.slice(inputDataOffset + readOffset, inputDataOffset + readOffset + toRead);

    // Update read offset
    HEAPU32[controlU32Base + 2] = readOffset + toRead;
    // Update total_read
    HEAPU32[controlU32Base + 3] += toRead;

    // Mark empty if all consumed
    if (readOffset + toRead >= inputLength) {
      HEAPU32[INPUT_BUFFER_OFFSET / 4] = BufferStatus.EMPTY;
    }

    return { data, bytesRead: toRead };
  }

  /**
   * Internal: Write to output buffer
   */
  function internalWrite(data: Uint8Array): number {
    const currentLength = HEAPU32[OUTPUT_BUFFER_OFFSET / 4 + 1];

    if (currentLength + data.length > BUFFER_SIZE) {
      // Buffer full
      HEAPU32[OUTPUT_BUFFER_OFFSET / 4] = BufferStatus.READY;
      HEAPU32[controlU32Base] = OperationType.WRITE_READY;
      return -1;
    }

    HEAPU8.set(data, outputDataOffset + currentLength);
    HEAPU32[OUTPUT_BUFFER_OFFSET / 4 + 1] = currentLength + data.length;
    HEAPU32[controlU32Base + 4] += data.length; // total_written

    return data.length;
  }

  /**
   * Internal: Flush output
   */
  function internalFlush(): void {
    const currentLength = HEAPU32[OUTPUT_BUFFER_OFFSET / 4 + 1];
    if (currentLength > 0) {
      HEAPU32[OUTPUT_BUFFER_OFFSET / 4] = BufferStatus.READY;
      HEAPU32[controlU32Base] = OperationType.WRITE_READY;
    }
  }

  // Build the mock module object
  const mod: PollingWasmModule = {
    HEAPU8,
    HEAPU32,
    HEAP32,

    _get_input_buffer: () => INPUT_BUFFER_OFFSET,
    _get_output_buffer: () => OUTPUT_BUFFER_OFFSET,
    _get_control: () => CONTROL_OFFSET,
    _get_buffer_size: () => BUFFER_SIZE,

    _reset_buffers: () => {
      // Input buffer
      HEAPU32[INPUT_BUFFER_OFFSET / 4] = BufferStatus.EMPTY;
      HEAPU32[INPUT_BUFFER_OFFSET / 4 + 1] = 0;
      // Output buffer
      HEAPU32[OUTPUT_BUFFER_OFFSET / 4] = BufferStatus.EMPTY;
      HEAPU32[OUTPUT_BUFFER_OFFSET / 4 + 1] = 0;
      // Control block
      HEAPU32[controlU32Base] = OperationType.NONE;
      HEAP32[controlU32Base + 1] = 0; // error_code
      HEAPU32[controlU32Base + 2] = 0; // read_offset
      HEAPU32[controlU32Base + 3] = 0; // total_read
      HEAPU32[controlU32Base + 4] = 0; // total_written
    },

    _signal_input_ready: (length: number) => {
      HEAPU32[INPUT_BUFFER_OFFSET / 4 + 1] = length;
      HEAPU32[INPUT_BUFFER_OFFSET / 4] = BufferStatus.READY;
      HEAPU32[controlU32Base + 2] = 0; // reset read_offset
    },

    _has_output: () => {
      return HEAPU32[OUTPUT_BUFFER_OFFSET / 4] === BufferStatus.READY ? 1 : 0;
    },

    _get_output_length: () => {
      return HEAPU32[OUTPUT_BUFFER_OFFSET / 4 + 1];
    },

    _ack_output: () => {
      HEAPU32[OUTPUT_BUFFER_OFFSET / 4] = BufferStatus.EMPTY;
      HEAPU32[OUTPUT_BUFFER_OFFSET / 4 + 1] = 0;
    },

    _process_message: () => {
      // Read all input
      const { data, bytesRead } = internalRead(1024);

      if (bytesRead <= 0) {
        HEAP32[controlU32Base + 1] = -1; // error_code
        HEAPU32[controlU32Base] = OperationType.ERROR;
        return -1;
      }

      // Transform: convert to uppercase (simulating query processing)
      const transformed = new Uint8Array(bytesRead);
      for (let i = 0; i < bytesRead; i++) {
        const byte = data[i];
        if (byte >= 97 && byte <= 122) {
          // a-z -> A-Z
          transformed[i] = byte - 32;
        } else {
          transformed[i] = byte;
        }
      }

      // Write response header (PostgreSQL-style message)
      const header = new Uint8Array(5);
      header[0] = 82; // 'R'
      const len = bytesRead + 4;
      header[1] = (len >> 24) & 0xff;
      header[2] = (len >> 16) & 0xff;
      header[3] = (len >> 8) & 0xff;
      header[4] = len & 0xff;

      internalWrite(header);
      internalWrite(transformed);
      internalFlush();

      HEAPU32[controlU32Base] = OperationType.COMPLETED;
      return 0;
    },

    _process_multi_row: (numRows: number) => {
      const encoder = new TextEncoder();

      for (let i = 0; i < numRows; i++) {
        const rowText = `Row ${i + 1} of ${numRows}\n`;
        const rowData = encoder.encode(rowText);

        // Write row header
        const header = new Uint8Array(5);
        header[0] = 68; // 'D' for DataRow
        const len = rowData.length + 4;
        header[1] = (len >> 24) & 0xff;
        header[2] = (len >> 16) & 0xff;
        header[3] = (len >> 8) & 0xff;
        header[4] = len & 0xff;

        if (internalWrite(header) < 0) {
          HEAP32[controlU32Base + 1] = -2;
          HEAPU32[controlU32Base] = OperationType.ERROR;
          return -1;
        }

        if (internalWrite(rowData) < 0) {
          HEAP32[controlU32Base + 1] = -3;
          HEAPU32[controlU32Base] = OperationType.ERROR;
          return -1;
        }
      }

      internalFlush();
      HEAPU32[controlU32Base] = OperationType.COMPLETED;
      return 0;
    },
  };

  // Initialize buffers
  mod._reset_buffers();

  return mod;
}

/**
 * Factory function to match the real WASM module loading pattern
 */
export default async function MockWasmModule(): Promise<PollingWasmModule> {
  console.log('Mock WASM module initialized');
  console.log('(This is a TypeScript simulation - no actual WASM compiled)');
  return createMockWasmModule();
}
