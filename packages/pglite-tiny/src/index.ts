/**
 * @dotdo/pglite-tiny - Minimal PGlite variant for Cloudflare Workers
 *
 * This package provides a stripped-down PGlite build optimized for:
 * - Bundle size: ~5MB total (WASM + data)
 * - Memory: ~35-40MB runtime footprint
 * - Core SQL: SELECT, INSERT, UPDATE, DELETE
 * - Basic types: int, text, bool, date, timestamp
 * - btree indexes only
 * - UTF-8 only (no charset converters)
 *
 * Excluded features (to minimize size):
 * - ALL extensions (pgvector, hstore, etc.)
 * - Full-text search / Snowball stemmers
 * - XML/XSLT support
 * - UUID generation
 * - Geometric/network types
 * - Charset converters (UTF-8 only)
 *
 * Ideal for:
 * - Key-value style storage
 * - Simple CRUD operations
 * - Edge caching / lookup tables
 * - Memory-constrained environments (Cloudflare Workers 128MB limit)
 *
 * @example
 * ```typescript
 * // In Cloudflare Workers (static imports required)
 * import { PGlite } from '@dotdo/pglite-tiny'
 * import tinyWasm from '@dotdo/pglite-tiny/release/pglite.wasm'
 * import tinyData from '@dotdo/pglite-tiny/release/pglite.data'
 *
 * const pg = await PGlite.create({
 *   wasmModule: tinyWasm,
 *   fsBundle: new Blob([tinyData]),
 * })
 *
 * await pg.query('SELECT 1 + 1 as result')
 * ```
 *
 * @example
 * ```typescript
 * // In Node.js (auto-resolves WASM from package)
 * import { PGlite } from '@dotdo/pglite-tiny'
 *
 * const pg = await PGlite.create()
 * await pg.query('SELECT 1 + 1 as result')
 * ```
 *
 * @packageDocumentation
 * @module @dotdo/pglite-tiny
 */

// =============================================================================
// Core PGlite Class
// =============================================================================

/**
 * Re-export the PGlite class from @dotdo/pglite.
 * The tiny variant uses the same API but with smaller WASM binaries.
 *
 * @example
 * ```typescript
 * import { PGlite } from '@dotdo/pglite-tiny'
 *
 * const pg = await PGlite.create()
 * const result = await pg.query<{ sum: number }>('SELECT 1 + 1 as sum')
 * console.log(result.rows[0].sum) // 2
 * ```
 */
export { PGlite } from '@dotdo/pglite'

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Re-export utility functions from @dotdo/pglite.
 *
 * - uuid: Generate a v4 UUID (useful since uuid-ossp extension is excluded)
 * - formatQuery: Format SQL query with parameters for debugging
 */
export { uuid, formatQuery } from '@dotdo/pglite'

// =============================================================================
// Filesystem Implementations
// =============================================================================

/**
 * Re-export filesystem implementations for advanced use cases.
 *
 * - MemoryFS: In-memory filesystem (default for tiny variant)
 * - IdbFs: IndexedDB-backed filesystem for browser persistence
 */
export { MemoryFS, IdbFs } from '@dotdo/pglite'

// =============================================================================
// Types
// =============================================================================

/**
 * Re-export all TypeScript types from @dotdo/pglite.
 * These provide full type safety for the PGlite API.
 */
export type {
  // Core interfaces
  PGliteOptions,
  PGliteInterface,
  PGliteInterfaceExtensions,
  Results,
  Row,
  QueryOptions,
  Transaction,
  ExecProtocolOptions,
  ParserOptions,
  DebugLevel,
  FilesystemType,
  // Extension system (note: extensions are excluded from tiny build WASM)
  Extension,
  ExtensionSetupResult,
  ExtensionNamespace,
  // Memory management
  MemorySnapshot,
  MemoryStats,
} from '@dotdo/pglite'

// =============================================================================
// Version and Variant Constants
// =============================================================================

/**
 * Package version following semver.
 * @example
 * ```typescript
 * import { VERSION } from '@dotdo/pglite-tiny'
 * console.log(VERSION) // '0.1.0'
 * ```
 */
export const VERSION = '0.1.0'

/**
 * Variant identifier to distinguish from full @dotdo/pglite.
 * @example
 * ```typescript
 * import { VARIANT } from '@dotdo/pglite-tiny'
 * console.log(VARIANT) // 'tiny'
 * ```
 */
export const VARIANT = 'tiny' as const

/**
 * Type for the variant constant.
 */
export type Variant = typeof VARIANT

// =============================================================================
// Memory Budget Constants
// =============================================================================

/**
 * Memory budget for the tiny variant.
 *
 * These are TARGET values for planning memory usage in
 * constrained environments like Cloudflare Workers (128MB limit).
 *
 * Use these values to plan your application's memory allocation
 * and ensure you stay within the Workers limit.
 *
 * @example
 * ```typescript
 * import { TINY_MEMORY_BUDGET } from '@dotdo/pglite-tiny'
 *
 * // Check if your expected data fits
 * const myDataSize = 50 * 1024 * 1024 // 50MB
 * if (myDataSize < TINY_MEMORY_BUDGET.availableForApp) {
 *   console.log('Data fits within memory budget')
 * }
 * ```
 *
 * @remarks
 * These are targets pending Docker build completion.
 * Current package uses placeholder symlinks to standard pglite release.
 */
export const TINY_MEMORY_BUDGET = {
  /**
   * Target WASM binary size in bytes.
   * The tiny build targets ~3MB for the compiled PostgreSQL WASM.
   */
  wasmBinary: 3 * 1024 * 1024, // ~3MB target

  /**
   * Target data bundle size in bytes.
   * The data bundle contains the PostgreSQL filesystem (share/lib/etc).
   */
  dataBundle: 2 * 1024 * 1024, // ~2MB target

  /**
   * Approximate PostgreSQL runtime memory in bytes.
   * This includes shared_buffers, work_mem, and other PostgreSQL allocations.
   */
  postgresRuntime: 35 * 1024 * 1024, // ~35MB

  /**
   * Memory available for application logic and query results in bytes.
   * This is the remaining memory after PostgreSQL initialization.
   */
  availableForApp: 88 * 1024 * 1024, // ~88MB

  /**
   * Cloudflare Workers memory limit in bytes.
   * This is the hard limit imposed by the Workers runtime.
   */
  workersLimit: 128 * 1024 * 1024, // 128MB
} as const

/**
 * Type for the memory budget configuration.
 */
export type TinyMemoryBudget = typeof TINY_MEMORY_BUDGET

// =============================================================================
// Build Configuration (for reference)
// =============================================================================

/**
 * Build configuration reference for the tiny variant.
 *
 * This documents the environment variables used by build-pglite-tiny.sh.
 * These values cannot be changed at runtime - they are compile-time settings.
 *
 * @internal
 */
export const BUILD_CONFIG = {
  /** Enables minimal build mode in the WASM build script */
  PGLITE_TINY: true,
  /** Excludes all charset converters except UTF-8 (~1.8MB savings) */
  PGLITE_UTF8_ONLY: true,
  /** Skips all contrib extensions (~2-3MB savings) */
  SKIP_CONTRIB: true,
  /** No Snowball text search stemmers (~500KB savings) */
  SNOWBALL_LANGUAGES: '',
  /** Initial Emscripten memory allocation */
  TOTAL_MEMORY: '32MB',
  /** Contiguous memory area size for data transfer */
  CMA_MB: 4,
  /** Compiler optimization flags */
  COPTS: '-Oz -flto -fno-exceptions -fno-rtti',
  /** Linker optimization flags with closure compiler */
  LOPTS: '-Oz -flto -fno-exceptions --closure=1 -sASSERTIONS=0 -sEVAL_CTORS=2',
} as const

/**
 * Type for build configuration.
 * @internal
 */
export type BuildConfig = typeof BUILD_CONFIG
