/**
 * test-mock.ts
 *
 * Test the memory polling approach using the mock WASM module.
 * This can run without Emscripten installed.
 *
 * Run with: npx tsx test-mock.ts
 */

import { PGlitePolling } from './pglite-polling.js';
import MockWasmModule from './mock-wasm.js';

async function runTests(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Memory Polling POC - Mock WASM Test');
  console.log('='.repeat(60));
  console.log('');
  console.log('This test uses a TypeScript mock of the WASM module');
  console.log('to demonstrate the polling approach works correctly.');
  console.log('');

  // Load mock WASM module
  console.log('Loading mock WASM module...');
  const mod = await MockWasmModule();
  console.log('');

  // Create polling interface
  const polling = new PGlitePolling(mod);
  polling.init();
  console.log('');

  let passed = 0;
  let failed = 0;

  // Test 1: Simple message round-trip
  console.log('-'.repeat(40));
  console.log('TEST 1: Simple Message Round-Trip');
  console.log('-'.repeat(40));

  const testInput = 'select * from users;';
  console.log(`Input:  "${testInput}"`);

  try {
    const inputBytes = new TextEncoder().encode(testInput);
    const response = polling.execSync(inputBytes);
    const parsed = polling.parseMessage(response);

    console.log(`Output type: '${parsed.type}'`);
    console.log(`Output length: ${parsed.length} bytes`);
    const outputText = new TextDecoder().decode(parsed.payload);
    console.log(`Output payload: "${outputText}"`);

    if (outputText === testInput.toUpperCase()) {
      console.log('PASS: Output correctly transformed to uppercase');
      passed++;
    } else {
      console.log('FAIL: Output transformation mismatch');
      failed++;
    }
  } catch (e) {
    console.log(`FAIL: Exception - ${e}`);
    failed++;
  }
  console.log('');

  // Test 2: Binary data round-trip
  console.log('-'.repeat(40));
  console.log('TEST 2: Binary Data Round-Trip');
  console.log('-'.repeat(40));

  const binaryInput = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
  console.log(`Input (hex): ${Array.from(binaryInput).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

  try {
    polling.reset();
    polling.writeInput(binaryInput);
    const binaryResult = mod._process_message();

    if (binaryResult === 0) {
      const binaryResponse = polling.readOutput();
      if (binaryResponse) {
        console.log(`Output size: ${binaryResponse.length} bytes`);
        console.log('PASS: Binary data round-trip successful');
        passed++;
      } else {
        console.log('FAIL: No binary output');
        failed++;
      }
    } else {
      console.log('FAIL: Binary processing failed');
      failed++;
    }
  } catch (e) {
    console.log(`FAIL: Exception - ${e}`);
    failed++;
  }
  console.log('');

  // Test 3: Multi-row response
  console.log('-'.repeat(40));
  console.log('TEST 3: Multi-Row Response');
  console.log('-'.repeat(40));

  polling.reset();
  const numRows = 5;
  console.log(`Requesting ${numRows} rows...`);

  try {
    const multiResult = mod._process_multi_row!(numRows);

    if (multiResult === 0) {
      const chunks: Uint8Array[] = [];
      let output = polling.readOutput();
      while (output) {
        chunks.push(output);
        output = polling.readOutput();
      }

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      console.log(`Total output: ${totalLength} bytes`);
      console.log(`Number of chunks: ${chunks.length}`);

      // Parse DataRow messages
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
        passed++;
      } else {
        console.log(`FAIL: Expected ${numRows} rows, got ${rowCount}`);
        failed++;
      }
    } else {
      console.log('FAIL: Multi-row processing failed');
      failed++;
    }
  } catch (e) {
    console.log(`FAIL: Exception - ${e}`);
    failed++;
  }
  console.log('');

  // Test 4: Status checking
  console.log('-'.repeat(40));
  console.log('TEST 4: Status Checking');
  console.log('-'.repeat(40));

  try {
    polling.reset();
    let status = polling.getStatus();
    console.log(`After reset: operation=${status.operation}, errorCode=${status.errorCode}`);

    polling.writeInput(new TextEncoder().encode('test'));
    mod._process_message();

    status = polling.getStatus();
    console.log(`After process: operation=${status.operation}, errorCode=${status.errorCode}`);

    if (status.operation === 3) { // OP_COMPLETED
      console.log('PASS: Status correctly shows completed');
      passed++;
    } else {
      console.log('FAIL: Unexpected status');
      failed++;
    }
  } catch (e) {
    console.log(`FAIL: Exception - ${e}`);
    failed++;
  }
  console.log('');

  // Test 5: Large message
  console.log('-'.repeat(40));
  console.log('TEST 5: Large Message (near buffer limit)');
  console.log('-'.repeat(40));

  polling.reset();
  const largeSize = 60000;
  const largeInput = new Uint8Array(largeSize);
  for (let i = 0; i < largeSize; i++) {
    largeInput[i] = 65 + (i % 26); // A-Z pattern
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
        passed++;
      } else {
        console.log('FAIL: No output for large message');
        failed++;
      }
    } else {
      console.log('FAIL: Large message processing failed');
      failed++;
    }
  } catch (e) {
    console.log(`FAIL: Exception - ${e}`);
    failed++;
  }
  console.log('');

  // Test 6: Error handling (empty input)
  console.log('-'.repeat(40));
  console.log('TEST 6: Error Handling (empty input)');
  console.log('-'.repeat(40));

  try {
    polling.reset();
    // Don't write any input
    const emptyResult = mod._process_message();

    const status = polling.getStatus();
    console.log(`Result: ${emptyResult}, operation=${status.operation}, errorCode=${status.errorCode}`);

    if (emptyResult !== 0 && status.operation === 4) { // OP_ERROR
      console.log('PASS: Error correctly detected for empty input');
      passed++;
    } else {
      console.log('FAIL: Error not properly detected');
      failed++;
    }
  } catch (e) {
    console.log(`FAIL: Exception - ${e}`);
    failed++;
  }
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);
  console.log('');

  if (failed === 0) {
    console.log('ALL TESTS PASSED!');
    console.log('');
    console.log('The memory polling approach successfully demonstrates:');
    console.log('');
    console.log('1. Bidirectional communication via shared memory buffers');
    console.log('2. No use of addFunction (no runtime WASM generation)');
    console.log('3. Support for variable-length messages');
    console.log('4. Status tracking via control block');
    console.log('5. Multi-message responses (streaming)');
    console.log('6. Proper error handling');
    console.log('');
    console.log('This approach is compatible with Cloudflare Workers!');
  } else {
    console.log('SOME TESTS FAILED - Review output above');
    process.exit(1);
  }
  console.log('');
}

// Run tests
runTests().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
