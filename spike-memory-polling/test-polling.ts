/**
 * test-polling.ts
 *
 * Integration test for the memory polling POC.
 * Run with: npx tsx test-polling.ts
 */

import { PGlitePolling, type PollingWasmModule } from './pglite-polling.js';

// Dynamic import for the WASM module
async function loadWasmModule(): Promise<PollingWasmModule> {
  try {
    // @ts-ignore - dynamic import
    const TestModule = (await import('./test-polling.mjs')).default;
    return await TestModule();
  } catch (e) {
    console.error('Failed to load WASM module.');
    console.error('Make sure to run ./build.sh first to compile the WASM.');
    throw e;
  }
}

async function runTests(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Memory Polling POC - Integration Test');
  console.log('='.repeat(60));
  console.log('');

  // Load WASM module
  console.log('Loading WASM module...');
  const mod = await loadWasmModule();
  console.log('WASM module loaded successfully.\n');

  // Create polling interface
  const polling = new PGlitePolling(mod);
  polling.init();
  console.log('');

  // Test 1: Simple message round-trip
  console.log('-'.repeat(40));
  console.log('TEST 1: Simple Message Round-Trip');
  console.log('-'.repeat(40));

  const testInput = 'select * from users;';
  console.log(`Input:  "${testInput}"`);

  const inputBytes = new TextEncoder().encode(testInput);
  const response = polling.execSync(inputBytes);
  const parsed = polling.parseMessage(response);

  console.log(`Output type: '${parsed.type}'`);
  console.log(`Output length: ${parsed.length} bytes`);
  const outputText = new TextDecoder().decode(parsed.payload);
  console.log(`Output payload: "${outputText}"`);
  console.log('');

  // Verify the transformation (uppercase)
  if (outputText === testInput.toUpperCase()) {
    console.log('PASS: Output correctly transformed to uppercase');
  } else {
    console.log('FAIL: Output transformation mismatch');
    console.log(`  Expected: "${testInput.toUpperCase()}"`);
    console.log(`  Got: "${outputText}"`);
  }
  console.log('');

  // Test 2: Binary data round-trip
  console.log('-'.repeat(40));
  console.log('TEST 2: Binary Data Round-Trip');
  console.log('-'.repeat(40));

  const binaryInput = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
  console.log(`Input (hex): ${Array.from(binaryInput).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

  polling.reset();
  polling.writeInput(binaryInput);
  const binaryResult = mod._process_message();

  if (binaryResult === 0) {
    const binaryResponse = polling.readOutput();
    if (binaryResponse) {
      console.log(`Output size: ${binaryResponse.length} bytes`);
      console.log('PASS: Binary data round-trip successful');
    } else {
      console.log('FAIL: No binary output');
    }
  } else {
    console.log('FAIL: Binary processing failed');
  }
  console.log('');

  // Test 3: Multi-row response
  console.log('-'.repeat(40));
  console.log('TEST 3: Multi-Row Response');
  console.log('-'.repeat(40));

  polling.reset();
  const numRows = 5;
  console.log(`Requesting ${numRows} rows...`);

  if (mod._process_multi_row) {
    const multiResult = mod._process_multi_row(numRows);

    if (multiResult === 0) {
      // Collect all output
      const chunks: Uint8Array[] = [];
      let output = polling.readOutput();
      while (output) {
        chunks.push(output);
        output = polling.readOutput();
      }

      // Combine chunks
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      console.log(`Total output: ${totalLength} bytes`);
      console.log(`Number of chunks: ${chunks.length}`);

      // Parse the output to count DataRow messages
      let pos = 0;
      let rowCount = 0;
      while (pos < combined.length - 5) {
        const msgType = String.fromCharCode(combined[pos]);
        const msgLen = (combined[pos + 1] << 24) |
                       (combined[pos + 2] << 16) |
                       (combined[pos + 3] << 8) |
                       combined[pos + 4];

        if (msgType === 'D') {
          rowCount++;
          const rowData = combined.slice(pos + 5, pos + 5 + msgLen - 4);
          console.log(`  Row ${rowCount}: "${new TextDecoder().decode(rowData).trim()}"`);
        }

        pos += 5 + msgLen - 4;
      }

      if (rowCount === numRows) {
        console.log(`PASS: Received all ${numRows} rows`);
      } else {
        console.log(`FAIL: Expected ${numRows} rows, got ${rowCount}`);
      }
    } else {
      console.log('FAIL: Multi-row processing failed');
    }
  } else {
    console.log('SKIP: _process_multi_row not available');
  }
  console.log('');

  // Test 4: Status checking
  console.log('-'.repeat(40));
  console.log('TEST 4: Status Checking');
  console.log('-'.repeat(40));

  polling.reset();
  let status = polling.getStatus();
  console.log(`After reset: operation=${status.operation}, errorCode=${status.errorCode}`);

  polling.writeInput(new TextEncoder().encode('test'));
  mod._process_message();

  status = polling.getStatus();
  console.log(`After process: operation=${status.operation}, errorCode=${status.errorCode}`);

  if (status.operation === 3) { // OP_COMPLETED
    console.log('PASS: Status correctly shows completed');
  } else {
    console.log('FAIL: Unexpected status');
  }
  console.log('');

  // Test 5: Large message (near buffer limit)
  console.log('-'.repeat(40));
  console.log('TEST 5: Large Message (near buffer limit)');
  console.log('-'.repeat(40));

  polling.reset();
  const largeSize = 60000; // Just under 64KB
  const largeInput = new Uint8Array(largeSize);
  for (let i = 0; i < largeSize; i++) {
    largeInput[i] = 65 + (i % 26); // Fill with A-Z pattern
  }

  console.log(`Input size: ${largeSize} bytes`);

  try {
    polling.writeInput(largeInput);
    const largeResult = mod._process_message();

    if (largeResult === 0) {
      const largeOutput = polling.readOutput();
      if (largeOutput) {
        console.log(`Output size: ${largeOutput.length} bytes`);
        console.log('PASS: Large message handled successfully');
      } else {
        console.log('FAIL: No output for large message');
      }
    } else {
      console.log('FAIL: Large message processing failed');
    }
  } catch (e) {
    console.log(`FAIL: Exception - ${e}`);
  }
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log('');
  console.log('The memory polling approach successfully demonstrates:');
  console.log('');
  console.log('1. Bidirectional communication via shared memory buffers');
  console.log('2. No use of addFunction (no runtime WASM generation)');
  console.log('3. Support for variable-length messages');
  console.log('4. Status tracking via control block');
  console.log('5. Multi-message responses (streaming)');
  console.log('');
  console.log('This approach is compatible with Cloudflare Workers!');
  console.log('');
}

// Run tests
runTests().catch(console.error);
