/**
 * pglite-polling.ts
 *
 * TypeScript implementation of memory-polling based PGlite communication.
 * This replaces the addFunction-based callbacks with shared memory buffers.
 *
 * SPIKE 3: Shared memory polling instead of callbacks
 */

// Buffer status (must match C side)
const BufferStatus = {
  EMPTY: 0,
  READY: 1,
  PROCESSING: 2,
} as const;

// Operation types (must match C side)
const OperationType = {
  NONE: 0,
  READ_REQUEST: 1,
  WRITE_READY: 2,
  COMPLETED: 3,
  ERROR: 4,
} as const;

// Memory layout constants
const BUFFER_HEADER_SIZE = 8; // 4 bytes status + 4 bytes length

/**
 * Interface for the WASM module with polling support
 */
export interface PollingWasmModule {
  // Memory access
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;

  // Buffer accessors (return pointers)
  _get_input_buffer(): number;
  _get_output_buffer(): number;
  _get_control(): number;
  _get_buffer_size(): number;

  // Buffer management
  _reset_buffers(): void;
  _signal_input_ready(length: number): void;
  _has_output(): number;
  _get_output_length(): number;
  _ack_output(): void;

  // Processing
  _process_message(): number;
  _process_multi_row?(num_rows: number): number;
}

/**
 * PGlitePolling - Memory-based communication without addFunction
 *
 * This class manages bidirectional communication with WASM using
 * shared memory buffers instead of function callbacks.
 */
export class PGlitePolling {
  private mod: PollingWasmModule;
  private inputBufferPtr: number = 0;
  private outputBufferPtr: number = 0;
  private controlPtr: number = 0;
  private bufferSize: number = 0;

  constructor(mod: PollingWasmModule) {
    this.mod = mod;
  }

  /**
   * Initialize - get buffer pointers from WASM
   */
  init(): void {
    this.inputBufferPtr = this.mod._get_input_buffer();
    this.outputBufferPtr = this.mod._get_output_buffer();
    this.controlPtr = this.mod._get_control();
    this.bufferSize = this.mod._get_buffer_size();

    console.log('PGlitePolling initialized:');
    console.log(`  Input buffer: 0x${this.inputBufferPtr.toString(16)}`);
    console.log(`  Output buffer: 0x${this.outputBufferPtr.toString(16)}`);
    console.log(`  Control block: 0x${this.controlPtr.toString(16)}`);
    console.log(`  Buffer size: ${this.bufferSize} bytes`);
  }

  /**
   * Write data to the input buffer for WASM to read
   */
  writeInput(data: Uint8Array): void {
    if (data.length > this.bufferSize) {
      throw new Error(
        `Input data too large: ${data.length} > ${this.bufferSize}`
      );
    }

    // Write data to buffer (after 8-byte header)
    const dataPtr = this.inputBufferPtr + BUFFER_HEADER_SIZE;
    this.mod.HEAPU8.set(data, dataPtr);

    // Signal that input is ready
    this.mod._signal_input_ready(data.length);
  }

  /**
   * Read output data from WASM
   */
  readOutput(): Uint8Array | null {
    if (!this.mod._has_output()) {
      return null;
    }

    const length = this.mod._get_output_length();
    if (length === 0) {
      return null;
    }

    // Read data from buffer (after 8-byte header)
    const dataPtr = this.outputBufferPtr + BUFFER_HEADER_SIZE;
    const data = this.mod.HEAPU8.slice(dataPtr, dataPtr + length);

    // Acknowledge that we've consumed the output
    this.mod._ack_output();

    return data;
  }

  /**
   * Get current operation status
   */
  getStatus(): { operation: number; errorCode: number } {
    // Control block layout: operation (u32), error_code (i32), ...
    const operationPtr = this.controlPtr / 4; // Convert to u32 index
    const errorPtr = this.controlPtr / 4 + 1;

    return {
      operation: this.mod.HEAPU32[operationPtr],
      errorCode: this.mod.HEAP32[errorPtr],
    };
  }

  /**
   * Reset all buffers for a new operation
   */
  reset(): void {
    this.mod._reset_buffers();
  }

  /**
   * Execute a message and get the response (synchronous)
   * This simulates a basic query execution cycle.
   */
  execSync(message: Uint8Array): Uint8Array {
    // Reset buffers
    this.reset();

    // Write input
    this.writeInput(message);

    // Process message (WASM side)
    const result = this.mod._process_message();
    if (result !== 0) {
      const status = this.getStatus();
      throw new Error(
        `WASM processing failed: error=${status.errorCode}`
      );
    }

    // Read output
    const output = this.readOutput();
    if (!output) {
      throw new Error('No output from WASM');
    }

    return output;
  }

  /**
   * Parse a PostgreSQL-style message from output
   */
  parseMessage(data: Uint8Array): { type: string; length: number; payload: Uint8Array } {
    if (data.length < 5) {
      throw new Error('Message too short');
    }

    const type = String.fromCharCode(data[0]);
    const length = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
    const payload = data.slice(5, 5 + length - 4);

    return { type, length, payload };
  }
}

/**
 * Example usage demonstrating the polling approach
 */
export async function demonstratePolling(
  wasmModuleFactory: () => Promise<PollingWasmModule>
): Promise<void> {
  console.log('=== PGlite Memory Polling Demo ===\n');

  // Load WASM module
  const mod = await wasmModuleFactory();

  // Create polling interface
  const pglite = new PGlitePolling(mod);
  pglite.init();

  // Test 1: Simple echo
  console.log('\n--- Test 1: Simple Message ---');
  const testMessage = new TextEncoder().encode('Hello, PGlite!');
  const response = pglite.execSync(testMessage);
  const parsed = pglite.parseMessage(response);

  console.log(`Input: "Hello, PGlite!"`);
  console.log(`Output type: '${parsed.type}'`);
  console.log(
    `Output payload: "${new TextDecoder().decode(parsed.payload)}"`
  );
  console.log(`(Note: output is uppercase - simulating query processing)`);

  // Test 2: Multiple rows (if supported)
  if (mod._process_multi_row) {
    console.log('\n--- Test 2: Multi-Row Response ---');
    pglite.reset();

    const rowResult = mod._process_multi_row(3);
    if (rowResult === 0) {
      let allOutput = new Uint8Array(0);
      while (true) {
        const output = pglite.readOutput();
        if (!output) break;
        const combined = new Uint8Array(allOutput.length + output.length);
        combined.set(allOutput);
        combined.set(output, allOutput.length);
        allOutput = combined;
      }
      console.log(`Total output size: ${allOutput.length} bytes`);
      console.log(`Output (raw): ${new TextDecoder().decode(allOutput)}`);
    }
  }

  console.log('\n=== Demo Complete ===');
}
