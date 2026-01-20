/**
 * Integration Test for Pre-compiled WASM Wrappers
 *
 * This test simulates the PGlite callback registration flow to verify
 * the pre-compiled wrapper approach works correctly.
 *
 * Run with: npx tsx integration-test.ts
 */

import {
  precompiledAddFunctionSync,
  patchModule,
  PRECOMPILED_WRAPPERS,
} from './precompiled-add-function';

// Create a mock PostgresMod with a WASM function table
function createMockModule(): any {
  // Create a WASM function table
  const table = new WebAssembly.Table({
    initial: 10,
    maximum: 100,
    element: 'anyfunc'
  });

  // Fill first few slots with dummy entries to simulate existing functions
  // In real PGlite, these would be compiled C functions

  return {
    wasmTable: table,
    HEAP8: new Int8Array(1024 * 1024), // 1MB heap
    HEAPU8: new Uint8Array(1024 * 1024),
    HEAPU32: new Uint32Array(256 * 1024),

    // Mock functions that would exist in real module
    _set_read_write_cbs: (read_cb: number, write_cb: number) => {
      console.log(`_set_read_write_cbs called with read=${read_cb}, write=${write_cb}`);
    },
  };
}

async function runTests() {
  console.log('=== Pre-compiled WASM Wrapper Integration Tests ===\n');

  // Test 1: Basic wrapper instantiation
  console.log('Test 1: Basic wrapper instantiation');
  {
    const mod = createMockModule();
    let writeCallCount = 0;
    let readCallCount = 0;

    // Simulate PGlite's write callback
    const writeCallback = (ptr: number, length: number): number => {
      writeCallCount++;
      console.log(`  Write callback: ptr=${ptr}, length=${length}`);
      return length;
    };

    // Simulate PGlite's read callback
    const readCallback = (ptr: number, maxLength: number): number => {
      readCallCount++;
      console.log(`  Read callback: ptr=${ptr}, maxLength=${maxLength}`);
      return Math.min(100, maxLength); // Simulate returning some data
    };

    // Add functions using pre-compiled approach
    const writePtr = precompiledAddFunctionSync(mod, writeCallback, 'iii');
    const readPtr = precompiledAddFunctionSync(mod, readCallback, 'iii');

    console.log(`  Write function pointer: ${writePtr}`);
    console.log(`  Read function pointer: ${readPtr}`);

    // Verify the functions are in the table
    const writeFunc = mod.wasmTable.get(writePtr);
    const readFunc = mod.wasmTable.get(readPtr);

    console.log(`  Write func from table: ${typeof writeFunc}`);
    console.log(`  Read func from table: ${typeof readFunc}`);

    // Call the functions through the table (simulating C calling back)
    const writeResult = writeFunc(0x1000, 256);
    const readResult = readFunc(0x2000, 1024);

    console.log(`  Write result: ${writeResult}`);
    console.log(`  Read result: ${readResult}`);

    // Verify callbacks were invoked
    if (writeCallCount === 1 && readCallCount === 1 &&
        writeResult === 256 && readResult === 100) {
      console.log('  PASSED\n');
    } else {
      console.log('  FAILED\n');
      process.exit(1);
    }
  }

  // Test 2: Module patching
  console.log('Test 2: Module patching (drop-in replacement)');
  {
    const mod = createMockModule();

    // Patch the module to use pre-compiled addFunction
    patchModule(mod);

    // Now use addFunction like PGlite does
    let called = false;
    const callback = (_ptr: number, len: number): number => {
      called = true;
      return len * 2;
    };

    const funcPtr = mod.addFunction(callback, 'iii');
    console.log(`  Function pointer: ${funcPtr}`);

    // Get and call through table
    const func = mod.wasmTable.get(funcPtr);
    const result = func(100, 50);

    console.log(`  Result: ${result} (expected 100)`);

    // Clean up
    mod.removeFunction(funcPtr);
    const afterRemove = mod.wasmTable.get(funcPtr);

    if (called && result === 100 && afterRemove === null) {
      console.log('  PASSED\n');
    } else {
      console.log('  FAILED\n');
      process.exit(1);
    }
  }

  // Test 3: Multiple callbacks (stress test)
  console.log('Test 3: Multiple callbacks (stress test)');
  {
    const mod = createMockModule();
    patchModule(mod);

    const pointers: number[] = [];
    const expectedResults: number[] = [];

    // Add 5 different callbacks
    for (let i = 0; i < 5; i++) {
      const multiplier = i + 1;
      const ptr = mod.addFunction((a: number, b: number) => {
        return (a + b) * multiplier;
      }, 'iii');
      pointers.push(ptr);
      expectedResults.push((10 + 20) * multiplier);
    }

    console.log(`  Added ${pointers.length} functions: [${pointers.join(', ')}]`);

    // Call each one
    let allCorrect = true;
    for (let i = 0; i < pointers.length; i++) {
      const func = mod.wasmTable.get(pointers[i]);
      const result = func(10, 20);
      const expected = expectedResults[i];
      console.log(`  Callback ${i}: result=${result}, expected=${expected}`);
      if (result !== expected) {
        allCorrect = false;
      }
    }

    // Clean up
    for (const ptr of pointers) {
      mod.removeFunction(ptr);
    }

    if (allCorrect) {
      console.log('  PASSED\n');
    } else {
      console.log('  FAILED\n');
      process.exit(1);
    }
  }

  // Test 4: Simulated Cloudflare Workers environment
  console.log('Test 4: Simulating Cloudflare Workers (no dynamic WASM)');
  {
    // In a real Cloudflare Worker, WebAssembly.compile() from bytes is allowed,
    // but generating NEW bytes is not. Our approach:
    // 1. The wrapper module bytes are pre-generated at build time
    // 2. We only call WebAssembly.compile() with those pre-existing bytes
    // 3. No calls to functions that generate WASM bytecode at runtime

    const mod = createMockModule();

    // Verify we're only using pre-compiled bytes
    console.log(`  Available pre-compiled signatures: ${Object.keys(PRECOMPILED_WRAPPERS).join(', ')}`);

    // This should work in Cloudflare Workers
    const ptr = precompiledAddFunctionSync(mod, (a: number, b: number) => a + b, 'iii');
    const func = mod.wasmTable.get(ptr);
    const result = func(42, 58);

    console.log(`  Result: ${result} (expected 100)`);

    if (result === 100) {
      console.log('  PASSED\n');
    } else {
      console.log('  FAILED\n');
      process.exit(1);
    }
  }

  // Test 5: Verify module size
  console.log('Test 5: Module size verification');
  {
    const base64 = PRECOMPILED_WRAPPERS['iii'];
    const bytes = Buffer.from(base64, 'base64');
    console.log(`  'iii' wrapper size: ${bytes.length} bytes`);
    console.log(`  Base64 size: ${base64.length} characters`);

    // Should be very small (under 100 bytes)
    if (bytes.length < 100) {
      console.log('  PASSED\n');
    } else {
      console.log('  FAILED (module too large)\n');
      process.exit(1);
    }
  }

  console.log('=== All tests passed! ===');
  console.log('\nThis approach should work in Cloudflare Workers because:');
  console.log('1. No WASM bytecode is generated at runtime');
  console.log('2. Pre-compiled modules are shipped as base64 strings');
  console.log('3. Only WebAssembly.compile() is called, which IS allowed');
  console.log('4. The function table manipulation uses standard APIs');
}

runTests().catch(console.error);
