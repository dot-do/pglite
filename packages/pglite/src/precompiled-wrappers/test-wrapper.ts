/**
 * Test script for pre-compiled WASM wrappers
 *
 * Run with: npx tsx test-wrapper.ts
 */

import { generateWrapperModule, generateTypescriptModule } from './generate-wrappers';

async function testWrapper() {
  console.log('Testing pre-compiled WASM wrapper generation...\n');

  // Generate wrapper for 'iii' signature
  const signature = 'iii';
  const wasmBytes = generateWrapperModule(signature);

  console.log(`Generated WASM module for signature '${signature}':`);
  console.log(`  Size: ${wasmBytes.length} bytes`);
  console.log(`  Hex: ${Array.from(wasmBytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  console.log(`  Base64: ${Buffer.from(wasmBytes).toString('base64')}`);

  // Verify the WASM module is valid
  try {
    const module = await WebAssembly.compile(wasmBytes.buffer as ArrayBuffer);
    console.log('\n  WASM module compiled successfully!');

    // Test instantiation with a callback
    let callCount = 0;
    let lastArgs: number[] = [];

    const testCallback = (ptr: number, length: number): number => {
      callCount++;
      lastArgs = [ptr, length];
      console.log(`  Callback called with ptr=${ptr}, length=${length}`);
      return ptr + length; // Return sum as test
    };

    const instance = await WebAssembly.instantiate(module, {
      e: { f: testCallback }
    });

    console.log('  Instance created successfully!');

    // Get the exported wrapper function
    const wrapper = instance.exports.f as Function;
    console.log(`  Wrapper function type: ${typeof wrapper}`);

    // Call the wrapper
    const result = wrapper(100, 50);
    console.log(`  Called wrapper(100, 50) = ${result}`);
    console.log(`  Callback was invoked: ${callCount > 0}`);
    console.log(`  Callback args: [${lastArgs.join(', ')}]`);

    if (result === 150 && callCount === 1 && lastArgs[0] === 100 && lastArgs[1] === 50) {
      console.log('\n  SUCCESS: Wrapper works correctly!');
    } else {
      console.log('\n  FAILED: Unexpected results');
    }

  } catch (e) {
    console.error('\n  FAILED to compile/run WASM module:', e);
    console.log('\n  Attempting to debug the bytecode...');

    // Print section-by-section analysis
    let offset = 0;
    console.log(`  [0-3] Magic: ${Array.from(wasmBytes.slice(0, 4)).map(b => '0x' + b.toString(16)).join(' ')}`);
    console.log(`  [4-7] Version: ${Array.from(wasmBytes.slice(4, 8)).map(b => '0x' + b.toString(16)).join(' ')}`);

    offset = 8;
    while (offset < wasmBytes.length) {
      const sectionId = wasmBytes[offset];
      const sectionSize = wasmBytes[offset + 1]; // Simple case, assuming small sections
      const sectionNames: Record<number, string> = {
        1: 'Type', 2: 'Import', 3: 'Function', 7: 'Export', 10: 'Code'
      };
      console.log(`  [${offset}] Section ${sectionId} (${sectionNames[sectionId] || 'Unknown'}): size=${sectionSize}`);
      offset += 2 + sectionSize;
    }
  }

  console.log('\n\n--- Generated TypeScript Module ---\n');
  console.log(generateTypescriptModule());
}

testWrapper().catch(console.error);
