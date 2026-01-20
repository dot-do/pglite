# Attribution

This project (@dotdo/pglite) is a fork of [PGlite](https://github.com/electric-sql/pglite) by Electric DB Limited.

## Original Project

| Field | Value |
|-------|-------|
| **Name** | PGlite |
| **Repository** | https://github.com/electric-sql/pglite |
| **Author** | [Electric DB Limited](https://electric-sql.com) |
| **License** | Apache 2.0 / PostgreSQL License (dual-licensed) |

## License

This fork maintains the original dual-license structure:

- **Apache License 2.0** - See [LICENSE](./LICENSE)
- **PostgreSQL License** - See [POSTGRES-LICENSE](./POSTGRES-LICENSE)

You may choose either license for your use of this software.

## Fork Information

| Field | Value |
|-------|-------|
| **Fork Name** | @dotdo/pglite |
| **Repository** | https://github.com/dot-do/pglite |
| **Maintainer** | [dotdo](https://github.com/dot-do) |
| **Purpose** | Cloudflare Workers compatibility |

## Changes Made in This Fork

This fork modifies PGlite to enable compatibility with Cloudflare Workers, which blocks runtime WebAssembly compilation for security reasons.

### 1. Trampoline Fix for Cloudflare Workers

**Problem**: Emscripten's `addFunction()` generates WASM bytecode at runtime, which triggers the error:
```
WebAssembly.Module(): Wasm code generation disallowed by embedder
```

**Solution**: Replaced runtime WASM generation with pre-compiled callback wrappers using EM_JS macros. The callback trampolines are now compiled at build time, eliminating the need for runtime WASM compilation.

Key modifications:
- Callbacks are registered via `Module._pgliteCallbacks` JavaScript object
- EM_JS macros compile the callback dispatch at build time
- No runtime `new WebAssembly.Module()` calls

### 2. Static WASM Import Support

Added `wasmModule` and `fsBundle` options to `PGlite.create()` for pre-compiled WASM loading:

```typescript
import { PGlite } from '@dotdo/pglite'
import pgliteWasm from './pglite.wasm'   // Static import
import pgliteData from './pglite.data'   // Static import

const pg = await PGlite.create({
  wasmModule: pgliteWasm,      // Pre-compiled WebAssembly.Module
  fsBundle: new Blob([pgliteData]),  // Filesystem bundle
})
```

This bypasses URL resolution issues (`import.meta.url` is undefined in Workers) and allows Cloudflare's Wrangler to pre-compile WASM at build time.

### 3. Memory Optimization

Tuned PostgreSQL memory settings for Cloudflare Workers' 128MB memory limit:

- `shared_buffers=16MB` (reduced from 128MB default)
- `work_mem=2MB`
- `temp_buffers=2MB`
- `wal_buffers=1MB`
- `max_connections=1` (Durable Objects are single-client)

## Acknowledgments

- [Electric DB Limited](https://electric-sql.com) for creating PGlite
- [Stas Kelvich](https://github.com/kelvich) of [Neon](https://neon.tech) for the original Postgres WASM work
- [PostgreSQL Global Development Group](https://www.postgresql.org/) for PostgreSQL

## Contributing

When contributing to this fork, please note:

1. Changes specific to Cloudflare Workers compatibility should be made here
2. General PGlite improvements should ideally be contributed upstream to [electric-sql/pglite](https://github.com/electric-sql/pglite)
3. We periodically sync with upstream to incorporate new features and fixes

## Upstream Sync

This fork tracks the upstream `electric-sql/pglite` repository. Sync process:

```bash
git remote add upstream https://github.com/electric-sql/pglite.git
git fetch upstream
git merge upstream/main
# Resolve conflicts in modified files (primarily Emscripten build configuration)
# Re-run WASM build with trampoline patches applied
```
