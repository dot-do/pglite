# @dotdo/pglite-tiny

Minimal PGlite variant optimized for Cloudflare Workers and memory-constrained environments.

## Overview

`@dotdo/pglite-tiny` provides a stripped-down PostgreSQL WASM build with:

- **Target bundle size**: ~5MB total (WASM + data)
- **Runtime memory**: ~35-40MB footprint
- **Core SQL only**: No extensions, minimal features

## Features Included

- Core SQL executor (SELECT, INSERT, UPDATE, DELETE)
- btree indexes
- Basic PostgreSQL types (int, text, bool, date, timestamp, etc.)
- Parameterized queries
- Transactions
- UTF-8 text encoding
- JSON/JSONB support

## Features Excluded (to minimize size)

- ALL extensions (pgvector, hstore, pgcrypto, etc.)
- Full-text search / Snowball stemmers
- XML/XSLT support
- UUID generation (use application-side generation)
- Geometric/network types
- All charset converters (UTF-8 only)

## Installation

```bash
npm install @dotdo/pglite-tiny
# or
pnpm add @dotdo/pglite-tiny
```

## Usage

### Node.js / Bun

```typescript
import { PGlite } from '@dotdo/pglite-tiny'

const pg = new PGlite('memory://')
await pg.waitReady

const result = await pg.query('SELECT 1 + 1 as result')
console.log(result.rows[0].result) // 2

await pg.close()
```

### Cloudflare Workers

In Cloudflare Workers, you must use static imports for WASM modules:

```typescript
import { PGlite } from '@dotdo/pglite-tiny'

// Static imports required for Cloudflare Workers
import tinyWasm from '@dotdo/pglite-tiny/release/pglite.wasm'
import tinyData from '@dotdo/pglite-tiny/release/pglite.data'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pg = new PGlite({
      wasmModule: tinyWasm,
      fsBundle: new Blob([tinyData]),
    })
    await pg.waitReady

    const result = await pg.query('SELECT 1 + 1 as result')

    await pg.close()

    return new Response(JSON.stringify(result.rows))
  }
}
```

### wrangler.toml Configuration

```toml
[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]

[[rules]]
type = "Data"
globs = ["**/*.data"]
```

## Memory Budget

The tiny variant is designed to fit within Cloudflare Workers' 128MB memory limit:

| Component | Target Size | Notes |
|-----------|-------------|-------|
| WASM binary | ~3MB | Optimized with -Oz, closure compiler |
| Data bundle | ~2MB | LZ4 compressed filesystem |
| PostgreSQL runtime | ~35MB | Minimal memory settings |
| **Total footprint** | ~40MB | Target for production use |
| **Available for app** | ~88MB | Remaining for queries and results |

> **Note**: These are target sizes. The current package uses placeholder symlinks to
> the standard pglite release (~13MB total). Actual tiny sizes will be available
> after the Docker build is complete (see build-pglite-tiny.sh).

## Use Cases

This variant is ideal for:

- **Key-value style storage**: Simple CRUD operations
- **Edge caching**: Lookup tables, configuration storage
- **Lightweight data processing**: Basic aggregations and joins
- **Memory-constrained environments**: Cloudflare Workers, edge functions

## Comparison with Full PGlite

| Feature | @dotdo/pglite | @dotdo/pglite-tiny |
|---------|---------------|-------------------|
| Bundle size | ~13MB | ~5MB (target*) |
| Runtime memory | ~64MB | ~40MB (target*) |
| Extensions | All available | None |
| Full-text search | Yes | No |
| Vector similarity | Yes (pgvector) | No |
| JSON/JSONB | Yes | Yes |
| XML support | Yes | No |
| UUID generation | Yes | No |

*Target sizes pending Docker build completion.

## Building from Source

The tiny WASM binary is built using Docker with special configuration flags. This section documents the complete build process.

### Prerequisites

- Docker installed and running
- ~10GB disk space for build artifacts
- ~30 minutes build time (varies by machine)

### Build Command

```bash
cd packages/pglite/postgres-pglite
./build-pglite-tiny.sh
```

### Build Configuration

The `build-pglite-tiny.sh` script sets these environment variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `PGLITE_TINY` | `true` | Enables minimal build mode |
| `PGLITE_UTF8_ONLY` | `true` | Excludes charset converters (~1.8MB savings) |
| `SKIP_CONTRIB` | `true` | Skips all contrib extensions (~2-3MB savings) |
| `SNOWBALL_LANGUAGES` | `""` | No text search stemmers (~500KB savings) |
| `DEBUG` | `false` | Release mode for size optimization |
| `TOTAL_MEMORY` | `32MB` | Initial Emscripten memory allocation |
| `CMA_MB` | `4` | Minimal contiguous memory area |

### Compiler Optimization Flags

```bash
# Compile flags for minimum size
COPTS="-Oz -flto -fno-exceptions -fno-rtti"

# Linker flags with closure compiler
LOPTS="-Oz -flto -fno-exceptions --closure=1 -sASSERTIONS=0 -sEVAL_CTORS=2"
```

### PostgreSQL Configure Options

The tiny build disables these PostgreSQL features at configure time:

```bash
--without-zlib          # No compression support
--without-libxml        # No XML support
--without-libxslt       # No XSLT support
--without-uuid          # No UUID generation
--without-openssl       # No SSL/crypto
--disable-nls           # No localization
--disable-thread-safety # Single-threaded only
```

### Post-Build Steps

After building, copy the output files to the release directory:

```bash
# Build outputs are in /tmp/sdk/dist/pglite-web/
cp /tmp/sdk/dist/pglite-web/pglite.wasm packages/pglite-tiny/release/
cp /tmp/sdk/dist/pglite-web/pglite.data packages/pglite-tiny/release/
cp /tmp/sdk/dist/pglite-web/pglite.js packages/pglite-tiny/release/

# Remove symlinks first if they exist
rm -f packages/pglite-tiny/release/pglite.*
```

### Current Status

The release directory currently contains symlinks to the standard pglite build
as placeholders. After running the Docker build, actual tiny WASM files will
replace these symlinks.

## Size Optimization Notes

### Current Size Breakdown (Full PGlite)

| Component | Size | Notes |
|-----------|------|-------|
| pglite.wasm | ~8.5MB | Core PostgreSQL WASM binary |
| pglite.data | ~4.7MB | Filesystem bundle (share/lib/password) |
| Total | ~13MB | Before optimization |

### Optimization Opportunities

1. **Charset Converters** (~1.8MB savings)
   - Full build includes converters for all PostgreSQL-supported encodings
   - Tiny build: UTF-8 only (`PGLITE_UTF8_ONLY=true`)

2. **Snowball Stemmers** (~500KB savings)
   - Full build includes 27 language stemmers for full-text search
   - Tiny build: No stemmers (`SNOWBALL_LANGUAGES=""`)

3. **Contrib Extensions** (~2-3MB savings)
   - Full build includes pgvector, hstore, pgcrypto, etc.
   - Tiny build: None (`SKIP_CONTRIB=true`)

4. **Compiler Optimization** (~10-20% reduction)
   - `-Oz` instead of `-O2` for size over speed
   - `--closure=1` for JavaScript minification
   - `-flto` for link-time optimization

### Future Optimization Ideas

1. **Custom PostgreSQL Fork**
   - Remove unused system catalog entries
   - Compile out geometric/network type handlers
   - Reduce error message string table

2. **Selective Type System**
   - Compile only required type handlers
   - Remove unused operator implementations

3. **Lazy Loading**
   - Split data bundle into core/optional
   - Load dictionaries on demand

4. **WASM Compression**
   - Brotli compression for smaller network transfer
   - Client-side decompression before instantiation

## API Reference

This package re-exports the full PGlite API from `@dotdo/pglite`. See the [main PGlite documentation](https://github.com/dot-do/pglite) for complete API reference.

### Exported Types

```typescript
import type {
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
} from '@dotdo/pglite-tiny'
```

### Constants

```typescript
import { VERSION, VARIANT, TINY_MEMORY_BUDGET } from '@dotdo/pglite-tiny'

console.log(VARIANT) // 'tiny'
console.log(TINY_MEMORY_BUDGET.workersLimit) // 134217728 (128MB)
console.log(TINY_MEMORY_BUDGET.wasmBinary)   // 3145728 (3MB target)
console.log(TINY_MEMORY_BUDGET.dataBundle)   // 2097152 (2MB target)
```

### Utility Functions

```typescript
import { uuid, formatQuery } from '@dotdo/pglite-tiny'

// Generate a UUID (application-side, since uuid-ossp is excluded)
const id = uuid()

// Format a query for debugging
const formatted = formatQuery('SELECT * FROM users WHERE id = $1', [123])
```

## Testing

Run tests to verify the implementation:

```bash
cd packages/pglite/packages/pglite-tiny
npx vitest run --reporter=verbose
```

Tests are organized into:
- **Bundle size tests**: Verify WASM/data files meet size targets (skipped for interim symlinks)
- **Core SQL tests**: Verify SELECT, INSERT, UPDATE, DELETE operations
- **Type tests**: Verify PostgreSQL type handling
- **Memory tests**: Verify bounded memory usage
- **Extension tests**: Verify extensions are properly excluded

## License

Apache-2.0
