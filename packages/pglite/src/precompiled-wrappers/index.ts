/**
 * Pre-compiled WASM Callback Wrappers
 *
 * This module provides a Cloudflare Workers-compatible alternative to
 * Emscripten's addFunction(). Instead of generating WASM bytecode at runtime
 * (which is blocked by Workers' security policy), we ship pre-compiled
 * wrapper modules that can be instantiated with any JS callback.
 *
 * Usage:
 *
 * ```typescript
 * import { patchModule } from '@electric-sql/pglite/precompiled-wrappers';
 *
 * // Before any addFunction calls:
 * const mod = await PostgresModFactory(emscriptenOpts);
 * patchModule(mod);
 *
 * // Now addFunction will use pre-compiled wrappers
 * const funcPtr = mod.addFunction(myCallback, 'iii');
 * ```
 *
 * Or use the functions directly:
 *
 * ```typescript
 * import { precompiledAddFunctionSync } from '@electric-sql/pglite/precompiled-wrappers';
 *
 * const funcPtr = precompiledAddFunctionSync(mod, myCallback, 'iii');
 * ```
 */

export {
  precompiledAddFunction,
  precompiledAddFunctionSync,
  precompiledRemoveFunction,
  createAddFunctionReplacement,
  patchModule,
  PRECOMPILED_WRAPPERS,
} from './precompiled-add-function';

export {
  generateWrapperModule,
  generateAllWrappers,
  generateTypescriptModule,
  PGLITE_SIGNATURES,
} from './generate-wrappers';
