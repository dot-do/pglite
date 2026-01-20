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
 */

// Re-export everything from @dotdo/pglite
// The tiny variant uses the same API but with smaller WASM binaries
export {
  PGlite,
} from '@dotdo/pglite'

// Re-export all types
export type {
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
  Extension,
  ExtensionSetupResult,
  ExtensionNamespace,
  MemorySnapshot,
  MemoryStats,
} from '@dotdo/pglite'

// Export version info
export const VERSION = '0.1.0'
export const VARIANT = 'tiny'

/**
 * Memory budget for tiny variant.
 *
 * These are TARGET values for planning memory usage in
 * constrained environments like Cloudflare Workers (128MB limit).
 *
 * Note: These are targets pending Docker build completion.
 * Current package uses placeholder symlinks to standard pglite release.
 */
export const TINY_MEMORY_BUDGET = {
  /** Target WASM binary size (pending build) */
  wasmBinary: 3 * 1024 * 1024,      // ~3MB target
  /** Target data bundle size (pending build) */
  dataBundle: 2 * 1024 * 1024,       // ~2MB target
  /** Approximate PostgreSQL runtime memory */
  postgresRuntime: 35 * 1024 * 1024, // ~35MB
  /** Memory available for application logic and queries */
  availableForApp: 88 * 1024 * 1024, // ~88MB
  /** Cloudflare Workers memory limit */
  workersLimit: 128 * 1024 * 1024,   // 128MB
} as const
