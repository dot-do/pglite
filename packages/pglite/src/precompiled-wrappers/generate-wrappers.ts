/**
 * Pre-compiled WASM Callback Wrappers Generator
 *
 * This module generates WASM wrapper modules at BUILD TIME that can wrap
 * JavaScript functions for use in WASM function tables WITHOUT requiring
 * runtime WASM compilation (which is blocked in Cloudflare Workers).
 *
 * The key insight: Emscripten's addFunction() dynamically generates small
 * WASM modules. But the bytecode is deterministic based on the signature.
 * We can pre-generate these modules and ship them with the bundle.
 *
 * Signature format: 'iii' means return i32, param1 i32, param2 i32
 * - 'i' = i32 (also used for pointers)
 * - 'j' = i64
 * - 'f' = f32
 * - 'd' = f64
 * - 'v' = void
 * - 'p' = pointer (treated as i32)
 */

// WASM type codes
const WASM_TYPE = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
} as const;

// Signature character to WASM type mapping
const SIG_TO_WASM: Record<string, number> = {
  'i': WASM_TYPE.i32,
  'p': WASM_TYPE.i32, // pointer = i32
  'j': WASM_TYPE.i64,
  'f': WASM_TYPE.f32,
  'd': WASM_TYPE.f64,
};

/**
 * ULEB128 encoding for unsigned integers
 * Used throughout WASM binary format
 */
function uleb128(value: number): number[] {
  const result: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) {
      byte |= 0x80;
    }
    result.push(byte);
  } while (value !== 0);
  return result;
}

/**
 * Generate WASM bytecode for a callback wrapper module
 *
 * The generated module:
 * 1. Imports a JavaScript function with the given signature
 * 2. Exports a wrapper function that calls the import
 * 3. Can be inserted into the WASM function table
 *
 * @param signature Emscripten-style signature (e.g., 'iii' for int(int, int))
 * @returns Uint8Array containing the complete WASM module bytecode
 */
export function generateWrapperModule(signature: string): Uint8Array {
  // Parse signature: first char is return type, rest are params
  const returnType = signature[0];
  const paramTypes = signature.slice(1);

  // Build the WASM binary
  const wasmCode: number[] = [];

  // Magic number and version
  wasmCode.push(0x00, 0x61, 0x73, 0x6d); // '\0asm'
  wasmCode.push(0x01, 0x00, 0x00, 0x00); // version 1

  // Type section (section ID = 1)
  const typeSection: number[] = [];
  typeSection.push(0x01); // count: 1 type
  typeSection.push(0x60); // function type

  // Parameter types
  typeSection.push(paramTypes.length); // param count
  for (const p of paramTypes) {
    typeSection.push(SIG_TO_WASM[p]);
  }

  // Result types
  if (returnType === 'v') {
    typeSection.push(0x00); // no results
  } else {
    typeSection.push(0x01); // 1 result
    typeSection.push(SIG_TO_WASM[returnType]);
  }

  wasmCode.push(0x01); // section ID: Type
  wasmCode.push(...uleb128(typeSection.length));
  wasmCode.push(...typeSection);

  // Import section (section ID = 2)
  // Import the JS function as "e" from module "e"
  const importSection: number[] = [];
  importSection.push(0x01); // count: 1 import
  importSection.push(0x01, 0x65); // module name: "e" (length 1)
  importSection.push(0x01, 0x66); // field name: "f" (length 1)
  importSection.push(0x00); // import kind: function
  importSection.push(0x00); // type index: 0

  wasmCode.push(0x02); // section ID: Import
  wasmCode.push(...uleb128(importSection.length));
  wasmCode.push(...importSection);

  // Function section (section ID = 3)
  // Declare our wrapper function uses type 0
  const funcSection: number[] = [];
  funcSection.push(0x01); // count: 1 function
  funcSection.push(0x00); // type index: 0

  wasmCode.push(0x03); // section ID: Function
  wasmCode.push(...uleb128(funcSection.length));
  wasmCode.push(...funcSection);

  // Export section (section ID = 7)
  // Export the wrapper function as "f"
  const exportSection: number[] = [];
  exportSection.push(0x01); // count: 1 export
  exportSection.push(0x01, 0x66); // name: "f" (length 1)
  exportSection.push(0x00); // export kind: function
  exportSection.push(0x01); // function index: 1 (import is 0, our func is 1)

  wasmCode.push(0x07); // section ID: Export
  wasmCode.push(...uleb128(exportSection.length));
  wasmCode.push(...exportSection);

  // Code section (section ID = 10)
  // The wrapper function body: call the import with all params
  const codeBody: number[] = [];

  // Function body
  codeBody.push(0x00); // local count: 0

  // Push all parameters onto the stack
  for (let i = 0; i < paramTypes.length; i++) {
    codeBody.push(0x20); // local.get
    codeBody.push(i);    // local index
  }

  // Call the imported function
  codeBody.push(0x10); // call
  codeBody.push(0x00); // function index: 0 (the import)

  // End function
  codeBody.push(0x0b); // end

  const codeSection: number[] = [];
  codeSection.push(0x01); // count: 1 function body
  codeSection.push(...uleb128(codeBody.length));
  codeSection.push(...codeBody);

  wasmCode.push(0x0a); // section ID: Code
  wasmCode.push(...uleb128(codeSection.length));
  wasmCode.push(...codeSection);

  return new Uint8Array(wasmCode);
}

/**
 * All signatures used by PGlite
 * Found by searching the codebase for addFunction calls
 */
export const PGLITE_SIGNATURES = [
  'iii',  // int(ptr, length) - used for read/write callbacks
] as const;

/**
 * Generate all wrapper modules for PGlite
 */
export function generateAllWrappers(): Map<string, Uint8Array> {
  const wrappers = new Map<string, Uint8Array>();

  for (const sig of PGLITE_SIGNATURES) {
    wrappers.set(sig, generateWrapperModule(sig));
  }

  return wrappers;
}

/**
 * Generate TypeScript code containing pre-compiled wrappers as base64
 */
export function generateTypescriptModule(): string {
  const wrappers = generateAllWrappers();

  let code = `/**
 * Pre-compiled WASM Callback Wrappers
 *
 * Generated at build time. DO NOT EDIT.
 *
 * These modules wrap JavaScript functions so they can be called from WASM
 * without requiring runtime WASM compilation (blocked in Cloudflare Workers).
 */

// Pre-compiled wrapper modules as base64
export const PRECOMPILED_WRAPPERS: Record<string, string> = {\n`;

  for (const [sig, bytes] of wrappers) {
    const base64 = Buffer.from(bytes).toString('base64');
    code += `  '${sig}': '${base64}',\n`;
  }

  code += `};

/**
 * Decode a pre-compiled wrapper module
 */
export function decodeWrapper(signature: string): Uint8Array {
  const base64 = PRECOMPILED_WRAPPERS[signature];
  if (!base64) {
    throw new Error(\`No pre-compiled wrapper for signature: \${signature}\`);
  }

  // Use atob for browser, Buffer for Node
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } else {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
}
`;

  return code;
}

// Run if executed directly
if (typeof require !== 'undefined' && require.main === module) {
  console.log(generateTypescriptModule());
}
