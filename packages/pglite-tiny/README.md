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

The tiny WASM is built using `build-pglite-tiny.sh` in Docker:

```bash
cd packages/pglite/postgres-pglite
./build-pglite-tiny.sh
```

Build configuration:
- `PGLITE_TINY=true` - Enables minimal build mode
- `PGLITE_UTF8_ONLY=true` - Excludes charset converters (~1.8MB savings)
- `SKIP_CONTRIB=true` - Skips all extensions (~2-3MB savings)
- `SNOWBALL_LANGUAGES=""` - No text search stemmers (~500KB savings)
- `-Oz` optimization with closure compiler for minimum size

### Current Status

The release directory currently contains symlinks to the standard pglite build
as placeholders. After running the Docker build, actual tiny WASM files will
replace these symlinks.

## API Reference

This package re-exports the full PGlite API from `@dotdo/pglite`. See the [main PGlite documentation](https://github.com/dot-do/pglite) for complete API reference.

### Exported Types

```typescript
import type {
  PGliteOptions,
  PGliteInterface,
  Results,
  Row,
  QueryOptions,
  Transaction,
} from '@dotdo/pglite-tiny'
```

### Constants

```typescript
import { VERSION, VARIANT, TINY_MEMORY_BUDGET } from '@dotdo/pglite-tiny'

console.log(VARIANT) // 'tiny'
console.log(TINY_MEMORY_BUDGET.workersLimit) // 134217728 (128MB)
```

## License

Apache-2.0
