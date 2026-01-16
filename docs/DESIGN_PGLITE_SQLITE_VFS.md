# Design: PGlite SQLite Blob-Based VFS for Cloudflare Workers

**Date**: 2026-01-16
**Status**: Research & Design
**Author**: Claude Opus 4.5
**Project**: Native Iceberg TS Module for Cloudflare Workers

---

## Executive Summary

This document presents a design for using Cloudflare Durable Objects' built-in SQLite storage as a virtual filesystem (VFS) layer for PGlite (PostgreSQL compiled to WASM). The approach stores PostgreSQL's data files as SQLite blobs, enabling persistent PostgreSQL storage in Cloudflare Workers without relying on external storage systems.

**Key Insight**: By leveraging SQLite's efficient blob storage with chunking, we can provide PostgreSQL with a durable, transactional filesystem that survives Durable Object hibernation and restarts.

---

## Table of Contents

1. [Background](#1-background)
2. [Architecture Overview](#2-architecture-overview)
3. [SQLite Schema Design](#3-sqlite-schema-design)
4. [VFS Implementation](#4-vfs-implementation)
5. [Chunk Size Analysis](#5-chunk-size-analysis)
6. [WAL File Handling](#6-wal-file-handling)
7. [System Catalog Considerations](#7-system-catalog-considerations)
8. [Pseudocode Implementation](#8-pseudocode-implementation)
9. [Incremental Blob I/O](#9-incremental-blob-io)
10. [Pros and Cons](#10-pros-and-cons)
11. [Performance Considerations](#11-performance-considerations)
12. [Migration Path](#12-migration-path)

---

## 1. Background

### 1.1 PGlite's Current Filesystem Architecture

PGlite provides a pluggable filesystem interface (`Filesystem`) that abstracts file operations for PostgreSQL's WASM build. Current implementations include:

| Filesystem | Storage Backend | Use Case |
|------------|----------------|----------|
| `MemoryFS` | Emscripten MEMFS | In-memory, ephemeral |
| `IdbFs` | IndexedDB via Emscripten IDBFS | Browser persistence |
| `NodeFS` | Node.js fs module | Server-side persistence |
| `OpfsAhpFS` | Origin Private File System | Browser, high performance |

The `BaseFilesystem` abstract class defines the required interface:

```typescript
abstract class BaseFilesystem implements Filesystem {
  abstract chmod(path: string, mode: number): void
  abstract close(fd: number): void
  abstract fstat(fd: number): FsStats
  abstract lstat(path: string): FsStats
  abstract mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void
  abstract open(path: string, flags?: string, mode?: number): number
  abstract readdir(path: string): string[]
  abstract read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number
  abstract rename(oldPath: string, newPath: string): void
  abstract rmdir(path: string): void
  abstract truncate(path: string, len: number): void
  abstract unlink(path: string): void
  abstract utimes(path: string, atime: number, mtime: number): void
  abstract writeFile(path: string, data: string | Uint8Array, options?: WriteOptions): void
  abstract write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number
}
```

### 1.2 Cloudflare Durable Objects SQLite API

Cloudflare Durable Objects provide built-in SQLite storage with the following characteristics:

- **Capacity**: Up to 10GB per Durable Object
- **API**: `ctx.storage.sql.exec(query, ...bindings)` returns a cursor
- **Transactions**: Automatic within single request, or explicit with `transactionSync()`
- **Blob Support**: Native BLOB columns, but **no incremental blob I/O API exposed**
- **Persistence**: Automatic, durable across hibernation/restarts

**Critical Limitation**: Unlike native SQLite's `sqlite3_blob_open`/`sqlite3_blob_read`/`sqlite3_blob_write` for incremental I/O, Cloudflare's SQL API only supports full-column reads/writes.

### 1.3 PostgreSQL File Layout

PostgreSQL stores data in a structured directory hierarchy:

```
PGDATA/
├── PG_VERSION              # Version marker (few bytes)
├── postgresql.conf         # Configuration (few KB)
├── pg_hba.conf            # Auth config (few KB)
├── base/                   # Database files
│   └── <oid>/             # Per-database directory
│       ├── <relfilenode>  # Table/index data (8KB pages)
│       └── ...
├── global/                 # Cluster-wide tables
│   ├── pg_control         # Control file (8KB)
│   └── ...
├── pg_wal/                 # Write-ahead log
│   ├── 000000010000000000000001  # WAL segment (16MB default)
│   └── ...
├── pg_xact/                # Transaction status
├── pg_multixact/           # Multi-transaction status
└── pg_stat/                # Statistics
```

---

## 2. Architecture Overview

### 2.1 High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Durable Object                          │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │                  PGlite WASM                        │  │  │
│  │  │  ┌───────────────────────────────────────────────┐  │  │  │
│  │  │  │           PostgreSQL Backend                  │  │  │  │
│  │  │  │                   │                           │  │  │  │
│  │  │  │          File I/O Operations                  │  │  │  │
│  │  │  └───────────────────┬───────────────────────────┘  │  │  │
│  │  │                      │                              │  │  │
│  │  │  ┌───────────────────▼───────────────────────────┐  │  │  │
│  │  │  │         Emscripten VFS Layer                  │  │  │  │
│  │  │  └───────────────────┬───────────────────────────┘  │  │  │
│  │  └──────────────────────┼──────────────────────────────┘  │  │
│  │                         │                                  │  │
│  │  ┌──────────────────────▼──────────────────────────────┐  │  │
│  │  │           SQLite Blob VFS (New)                     │  │  │
│  │  │  ┌────────────────┐  ┌───────────────────────────┐  │  │  │
│  │  │  │ Directory Tree │  │     File Chunks          │  │  │  │
│  │  │  │   (metadata)   │  │   (1MB blob segments)    │  │  │  │
│  │  │  └───────┬────────┘  └───────────┬───────────────┘  │  │  │
│  │  └──────────┼───────────────────────┼──────────────────┘  │  │
│  │             │                       │                      │  │
│  │  ┌──────────▼───────────────────────▼──────────────────┐  │  │
│  │  │              DO SQLite Storage                       │  │  │
│  │  │         (ctx.storage.sql.exec())                     │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

1. **PostgreSQL** performs file I/O (read/write/create/delete)
2. **Emscripten VFS** translates to JavaScript callbacks
3. **SQLite Blob VFS** maps operations to SQLite queries:
   - File metadata stored in `pg_files` table
   - File content stored in `pg_chunks` table (1MB chunks)
4. **DO SQLite** persists data automatically

---

## 3. SQLite Schema Design

### 3.1 Core Tables

```sql
-- File and directory metadata
CREATE TABLE pg_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,           -- Full path (e.g., '/base/12345/16384')
    type TEXT NOT NULL CHECK (type IN ('file', 'directory')),
    mode INTEGER DEFAULT 33188,           -- Unix permissions (0o644 default for files)
    size INTEGER DEFAULT 0,               -- File size in bytes
    atime INTEGER DEFAULT (unixepoch()),  -- Access time
    mtime INTEGER DEFAULT (unixepoch()),  -- Modification time
    ctime INTEGER DEFAULT (unixepoch()),  -- Change time
    parent_id INTEGER REFERENCES pg_files(id) ON DELETE CASCADE
);

-- Indexes for efficient lookups
CREATE INDEX idx_pg_files_path ON pg_files(path);
CREATE INDEX idx_pg_files_parent ON pg_files(parent_id);

-- File content chunks
CREATE TABLE pg_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES pg_files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,         -- 0-based chunk index
    data BLOB NOT NULL,                   -- Chunk content (max 1MB)
    size INTEGER NOT NULL,                -- Actual bytes in chunk
    UNIQUE(file_id, chunk_index)
);

-- Index for efficient chunk retrieval
CREATE INDEX idx_pg_chunks_file ON pg_chunks(file_id, chunk_index);

-- Open file handles (runtime state, cleared on restart)
CREATE TABLE pg_handles (
    fd INTEGER PRIMARY KEY,              -- File descriptor
    file_id INTEGER NOT NULL REFERENCES pg_files(id),
    flags TEXT,                          -- Open flags
    position INTEGER DEFAULT 0           -- Current read/write position
);

-- WAL-specific tracking (for special handling)
CREATE TABLE pg_wal_segments (
    segment_name TEXT PRIMARY KEY,       -- e.g., '000000010000000000000001'
    file_id INTEGER NOT NULL REFERENCES pg_files(id),
    lsn_start TEXT,                      -- Start LSN
    lsn_end TEXT,                        -- End LSN
    is_current BOOLEAN DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
);
```

### 3.2 Initialization SQL

```sql
-- Root directory entry
INSERT OR IGNORE INTO pg_files (id, path, type, mode)
VALUES (1, '/', 'directory', 16877);

-- Set up standard PostgreSQL directories
INSERT OR IGNORE INTO pg_files (path, type, mode, parent_id)
SELECT dir, 'directory', 16877, 1
FROM (VALUES
    ('base'), ('global'), ('pg_wal'), ('pg_xact'),
    ('pg_multixact'), ('pg_stat'), ('pg_stat_tmp'),
    ('pg_subtrans'), ('pg_notify'), ('pg_replslot'),
    ('pg_twophase'), ('pg_commit_ts'), ('pg_logical')
) AS dirs(dir)
WHERE NOT EXISTS (SELECT 1 FROM pg_files WHERE path = '/' || dir);
```

### 3.3 Why This Schema?

| Design Choice | Rationale |
|---------------|-----------|
| Separate metadata/content tables | Allows directory operations without loading blobs |
| 1MB chunk size | Balances memory usage vs. I/O overhead (see Section 5) |
| Cascading deletes | Ensures cleanup when files/directories are removed |
| WAL tracking table | Enables special handling for WAL segments |
| Parent ID reference | Efficient directory traversal |

---

## 4. VFS Implementation

### 4.1 Class Structure

```typescript
/**
 * SQLite-backed VFS for PGlite on Cloudflare Durable Objects.
 * Stores PostgreSQL files as SQLite blobs with chunking.
 */
export class SqliteBlobVFS extends BaseFilesystem {
  private sql: SqlStorage;
  private fileHandles: Map<number, FileHandle>;
  private nextFd: number;
  private dirCache: Map<string, FileNode>;

  // Configuration
  readonly CHUNK_SIZE = 1024 * 1024; // 1MB

  constructor(sqlStorage: SqlStorage) {
    super();
    this.sql = sqlStorage;
    this.fileHandles = new Map();
    this.nextFd = 3; // 0,1,2 reserved for stdin/stdout/stderr
    this.dirCache = new Map();
  }

  async init(pg: PGlite, opts: Partial<PostgresMod>) {
    // Initialize schema
    this.sql.exec(INIT_SCHEMA_SQL);
    return super.init(pg, opts);
  }

  // ... implementation methods
}

interface FileHandle {
  fd: number;
  fileId: number;
  path: string;
  flags: string;
  position: number;
}

interface FileNode {
  id: number;
  path: string;
  type: 'file' | 'directory';
  mode: number;
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
  parentId: number | null;
}
```

### 4.2 Core Operations Mapping

| VFS Operation | SQLite Operations |
|---------------|-------------------|
| `mkdir(path)` | INSERT INTO pg_files |
| `readdir(path)` | SELECT FROM pg_files WHERE parent_id = ? |
| `open(path)` | SELECT id FROM pg_files; INSERT INTO pg_handles |
| `read(fd, ...)` | SELECT data FROM pg_chunks WHERE file_id = ? |
| `write(fd, ...)` | INSERT/UPDATE pg_chunks + UPDATE pg_files.size |
| `close(fd)` | DELETE FROM pg_handles WHERE fd = ? |
| `unlink(path)` | DELETE FROM pg_files (cascades to chunks) |
| `rename(old, new)` | UPDATE pg_files SET path = ? |
| `truncate(path, len)` | DELETE excess chunks + UPDATE remaining |
| `lstat(path)` | SELECT * FROM pg_files WHERE path = ? |

---

## 5. Chunk Size Analysis

### 5.1 Considerations

| Factor | Small Chunks (64KB) | Medium Chunks (1MB) | Large Chunks (4MB+) |
|--------|---------------------|---------------------|---------------------|
| Memory per read | Low | Moderate | High |
| I/O overhead | High (many queries) | Balanced | Low |
| Partial updates | Efficient | Moderate | Wasteful |
| DO SQLite limits | Many rows | Balanced | Few large blobs |
| PG page size alignment | 8x 8KB pages | 128x 8KB pages | 512x 8KB pages |

### 5.2 Recommendation: 1MB Chunks

**Rationale**:

1. **PostgreSQL 8KB pages**: 1MB holds 128 pages, reducing chunk boundary crossings
2. **Cloudflare limits**: Well under any theoretical blob limits
3. **Memory efficiency**: 1MB buffers manageable in Workers (128MB limit)
4. **WAL segments**: 16MB WAL splits into 16 manageable chunks
5. **Typical operations**: Most reads/writes span 1-2 chunks

### 5.3 Adaptive Chunking for Special Files

```typescript
getChunkSize(path: string): number {
  // WAL files: larger chunks for sequential I/O
  if (path.includes('/pg_wal/')) return 4 * 1024 * 1024; // 4MB

  // Small config files: single chunk
  if (path.endsWith('.conf') || path.includes('PG_VERSION')) {
    return 64 * 1024; // 64KB (usually fits entirely)
  }

  // Default: 1MB
  return 1024 * 1024;
}
```

---

## 6. WAL File Handling

### 6.1 WAL Challenges

PostgreSQL's Write-Ahead Log presents unique challenges:

1. **Sequential writes**: WAL appends are performance-critical
2. **Large files**: Default 16MB segments
3. **Frequent sync**: `fsync()` after each commit
4. **Recycling**: Old segments reused, not deleted

### 6.2 WAL-Specific Optimizations

```typescript
class WalManager {
  private currentSegment: WalSegment | null = null;
  private writeBuffer: Uint8Array;
  private bufferPosition: number = 0;

  constructor(private sql: SqlStorage) {
    this.writeBuffer = new Uint8Array(4 * 1024 * 1024); // 4MB buffer
  }

  /**
   * Buffered WAL write - accumulates writes before flushing
   */
  write(segmentName: string, data: Uint8Array, position: number): number {
    // Buffer writes until sync or buffer full
    if (this.bufferPosition + data.length > this.writeBuffer.length) {
      this.flushBuffer();
    }

    this.writeBuffer.set(data, this.bufferPosition);
    this.bufferPosition += data.length;
    return data.length;
  }

  /**
   * Flush WAL buffer to SQLite
   */
  flushBuffer(): void {
    if (this.bufferPosition === 0) return;

    const segment = this.writeBuffer.slice(0, this.bufferPosition);
    this.persistWalChunk(this.currentSegment!.name, segment);
    this.bufferPosition = 0;
  }

  /**
   * Sync WAL to durable storage
   */
  sync(): void {
    this.flushBuffer();
    // DO SQLite auto-commits, so this is sufficient
  }
}
```

### 6.3 WAL Segment Tracking

```sql
-- Track WAL segment state for efficient recovery
UPDATE pg_wal_segments
SET lsn_end = ?, is_current = 0
WHERE segment_name = ?;

INSERT INTO pg_wal_segments (segment_name, file_id, lsn_start, is_current)
VALUES (?, ?, ?, 1);
```

---

## 7. System Catalog Considerations

### 7.1 Critical System Files

PostgreSQL's system catalogs require special handling:

| File | Purpose | Access Pattern |
|------|---------|----------------|
| `pg_control` | Cluster control info | Read on startup, write on checkpoint |
| `pg_filenode.map` | OID to filenode mapping | Read frequently |
| `pg_internal.init` | Relation cache init | Read on startup |
| `global/pg_database` | Database list | Read frequently |

### 7.2 Caching Strategy

```typescript
class SystemCatalogCache {
  private cache: Map<string, { data: Uint8Array; mtime: number }> = new Map();

  private readonly CACHED_FILES = [
    '/global/pg_control',
    '/global/pg_filenode.map',
    '/global/pg_internal.init',
  ];

  shouldCache(path: string): boolean {
    return this.CACHED_FILES.some(f => path.endsWith(f));
  }

  get(path: string): Uint8Array | null {
    const cached = this.cache.get(path);
    return cached?.data ?? null;
  }

  set(path: string, data: Uint8Array, mtime: number): void {
    this.cache.set(path, { data: data.slice(), mtime });
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }
}
```

### 7.3 pg_control Special Handling

```typescript
/**
 * pg_control is critical for PostgreSQL startup.
 * Store it in a dedicated location for fast access.
 */
async function getPgControl(): Promise<Uint8Array> {
  // Try dedicated storage first (KV-like access)
  const control = await this.ctx.storage.get<Uint8Array>('pg:control');
  if (control) return control;

  // Fall back to blob storage
  return this.readFile('/global/pg_control');
}

async function setPgControl(data: Uint8Array): Promise<void> {
  // Write to both locations for redundancy
  await this.ctx.storage.put('pg:control', data);
  await this.writeFile('/global/pg_control', data);
}
```

---

## 8. Pseudocode Implementation

### 8.1 File Read Operation

```typescript
read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
  const handle = this.fileHandles.get(fd);
  if (!handle) throw new FsError('EBADF', 'Bad file descriptor');

  // Get file size to check bounds
  const file = this.getFileNode(handle.fileId);
  if (position >= file.size) return 0;

  // Calculate which chunks we need
  const startChunk = Math.floor(position / this.CHUNK_SIZE);
  const endChunk = Math.floor((position + length - 1) / this.CHUNK_SIZE);

  let bytesRead = 0;
  let bufferOffset = offset;

  for (let chunkIdx = startChunk; chunkIdx <= endChunk; chunkIdx++) {
    // Fetch chunk from SQLite
    const chunk = this.sql.exec(
      'SELECT data, size FROM pg_chunks WHERE file_id = ? AND chunk_index = ?',
      handle.fileId, chunkIdx
    ).one<{ data: Uint8Array; size: number }>();

    if (!chunk) break;

    // Calculate offsets within this chunk
    const chunkStart = chunkIdx * this.CHUNK_SIZE;
    const readStart = Math.max(0, position - chunkStart);
    const readEnd = Math.min(chunk.size, position + length - chunkStart);
    const readLength = readEnd - readStart;

    if (readLength <= 0) break;

    // Copy to output buffer
    buffer.set(
      chunk.data.subarray(readStart, readEnd),
      bufferOffset
    );

    bufferOffset += readLength;
    bytesRead += readLength;
  }

  // Update access time
  this.sql.exec(
    'UPDATE pg_files SET atime = ? WHERE id = ?',
    Math.floor(Date.now() / 1000), handle.fileId
  );

  return bytesRead;
}
```

### 8.2 File Write Operation

```typescript
write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
  const handle = this.fileHandles.get(fd);
  if (!handle) throw new FsError('EBADF', 'Bad file descriptor');

  const data = buffer.subarray(offset, offset + length);

  // Calculate affected chunks
  const startChunk = Math.floor(position / this.CHUNK_SIZE);
  const endChunk = Math.floor((position + length - 1) / this.CHUNK_SIZE);

  let bytesWritten = 0;
  let dataOffset = 0;

  for (let chunkIdx = startChunk; chunkIdx <= endChunk; chunkIdx++) {
    const chunkStart = chunkIdx * this.CHUNK_SIZE;
    const writeStart = Math.max(0, position - chunkStart);
    const writeEnd = Math.min(this.CHUNK_SIZE, position + length - chunkStart);
    const writeLength = writeEnd - writeStart;

    // Get existing chunk or create new one
    let chunkData: Uint8Array;
    const existing = this.sql.exec(
      'SELECT data FROM pg_chunks WHERE file_id = ? AND chunk_index = ?',
      handle.fileId, chunkIdx
    ).one<{ data: Uint8Array }>();

    if (existing) {
      // Merge with existing data
      chunkData = new Uint8Array(Math.max(existing.data.length, writeEnd));
      chunkData.set(existing.data);
    } else {
      chunkData = new Uint8Array(writeEnd);
    }

    // Write new data into chunk
    chunkData.set(data.subarray(dataOffset, dataOffset + writeLength), writeStart);

    // Upsert chunk
    this.sql.exec(`
      INSERT INTO pg_chunks (file_id, chunk_index, data, size)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_id, chunk_index) DO UPDATE SET
        data = excluded.data,
        size = excluded.size
    `, handle.fileId, chunkIdx, chunkData, chunkData.length);

    dataOffset += writeLength;
    bytesWritten += writeLength;
  }

  // Update file size and mtime
  const newSize = Math.max(
    (this.getFileNode(handle.fileId)).size,
    position + bytesWritten
  );

  this.sql.exec(
    'UPDATE pg_files SET size = ?, mtime = ? WHERE id = ?',
    newSize, Math.floor(Date.now() / 1000), handle.fileId
  );

  return bytesWritten;
}
```

### 8.3 Directory Operations

```typescript
mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
  const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
  const name = path.substring(path.lastIndexOf('/') + 1);

  // Get parent directory
  const parent = this.sql.exec(
    'SELECT id FROM pg_files WHERE path = ? AND type = ?',
    parentPath, 'directory'
  ).one<{ id: number }>();

  if (!parent) {
    if (options?.recursive) {
      this.mkdir(parentPath, options);
      return this.mkdir(path, options);
    }
    throw new FsError('ENOENT', 'Parent directory does not exist');
  }

  // Check if already exists
  const existing = this.sql.exec(
    'SELECT id FROM pg_files WHERE path = ?', path
  ).one();

  if (existing) {
    throw new FsError('EEXIST', 'File exists');
  }

  // Create directory
  this.sql.exec(`
    INSERT INTO pg_files (path, type, mode, parent_id)
    VALUES (?, 'directory', ?, ?)
  `, path, options?.mode ?? 16877, parent.id);
}

readdir(path: string): string[] {
  const dir = this.sql.exec(
    'SELECT id FROM pg_files WHERE path = ? AND type = ?',
    path, 'directory'
  ).one<{ id: number }>();

  if (!dir) {
    throw new FsError('ENOENT', 'Directory does not exist');
  }

  const entries = this.sql.exec(
    `SELECT path FROM pg_files WHERE parent_id = ?`,
    dir.id
  ).toArray() as { path: string }[];

  return entries.map(e => e.path.substring(e.path.lastIndexOf('/') + 1));
}
```

---

## 9. Incremental Blob I/O

### 9.1 The Limitation

Cloudflare's DO SQLite API does **not expose** SQLite's native incremental blob I/O:
- `sqlite3_blob_open` - Opens a blob for random access
- `sqlite3_blob_read` - Reads bytes at offset without loading entire blob
- `sqlite3_blob_write` - Writes bytes at offset without replacing entire blob

Instead, we must use standard `SELECT`/`UPDATE` which loads entire columns.

### 9.2 Workaround: Chunking + SQL substr()

While not true incremental I/O, we can approximate it:

```sql
-- Read portion of a chunk (if chunk exists)
SELECT substr(data, ?, ?) AS partial_data
FROM pg_chunks
WHERE file_id = ? AND chunk_index = ?;

-- This still loads the blob into memory, but returns less data
```

**Effectiveness**: Limited. The full blob is loaded server-side, then substr() extracts portion.

### 9.3 Better Approach: Right-Sized Chunks

Instead of incremental I/O, we optimize chunk sizes:

```typescript
/**
 * Dynamic chunk sizing based on file characteristics
 */
function getOptimalChunkSize(path: string, totalSize: number): number {
  // Small files: single chunk
  if (totalSize < 64 * 1024) return totalSize || 64 * 1024;

  // Config files: 64KB
  if (path.endsWith('.conf')) return 64 * 1024;

  // WAL files: 4MB (large sequential I/O)
  if (path.includes('/pg_wal/')) return 4 * 1024 * 1024;

  // Table data: 1MB (balance between 8KB pages and overhead)
  if (path.includes('/base/')) return 1024 * 1024;

  // Default
  return 1024 * 1024;
}
```

---

## 10. Pros and Cons

### 10.1 Advantages

| Advantage | Description |
|-----------|-------------|
| **Durable persistence** | Survives DO hibernation, restarts, and failures |
| **Transactional** | SQLite ACID guarantees protect file consistency |
| **No external dependencies** | Uses built-in DO storage, no R2/KV needed |
| **Automatic management** | No manual backup/restore required |
| **Familiar API** | Standard VFS interface for PGlite |
| **Metadata queries** | Can query file metadata directly via SQL |
| **10GB capacity** | Sufficient for most use cases |

### 10.2 Disadvantages

| Disadvantage | Description | Mitigation |
|--------------|-------------|------------|
| **No incremental blob I/O** | Full chunks loaded on read | Right-sized chunks |
| **Memory overhead** | Chunks loaded into JS memory | 1MB default limit |
| **Write amplification** | Partial writes reload entire chunk | Buffer small writes |
| **Single DO limit** | 10GB max per PostgreSQL instance | Shard across DOs |
| **Cold start latency** | Schema init + cache warm | Lazy loading |
| **Query overhead** | SQL parsing per operation | Prepared statements |

### 10.3 Comparison with Alternatives

| Approach | Persistence | Latency | Complexity | Capacity |
|----------|-------------|---------|------------|----------|
| **SQLite Blob VFS** | Excellent | Good | Medium | 10GB |
| MemoryFS | None | Excellent | Low | ~100MB |
| R2 Storage | Excellent | Poor (network) | High | Unlimited |
| KV Storage | Good | Good | Medium | 25MB/value |
| External PG | Excellent | Poor (network) | Low | Unlimited |

---

## 11. Performance Considerations

### 11.1 Expected Latencies

| Operation | Expected Latency | Notes |
|-----------|------------------|-------|
| Open file | ~1ms | Single SELECT |
| Read 8KB (1 page) | ~2ms | Single chunk SELECT |
| Read 1MB | ~5ms | Single chunk SELECT |
| Write 8KB | ~3ms | SELECT + UPDATE |
| Write 1MB | ~10ms | Single chunk UPSERT |
| mkdir | ~1ms | Single INSERT |
| readdir (100 files) | ~3ms | Single SELECT |
| unlink | ~2ms | CASCADE DELETE |

### 11.2 Optimization Strategies

1. **Read-ahead caching**: Pre-fetch adjacent chunks for sequential reads
2. **Write buffering**: Accumulate small writes before committing
3. **Directory caching**: Cache directory listings in memory
4. **Prepared statements**: Reuse SQL for common operations
5. **Lazy loading**: Don't load file content until accessed

### 11.3 Memory Budget

```typescript
const MEMORY_BUDGET = {
  chunkCache: 8 * 1024 * 1024,    // 8MB for chunk caching
  writeBuffer: 4 * 1024 * 1024,   // 4MB for write buffering
  dirCache: 1 * 1024 * 1024,      // 1MB for directory cache
  overhead: 3 * 1024 * 1024,      // 3MB for VFS overhead
  // Total: ~16MB reserved for VFS
  // Leaves ~112MB for PGlite WASM + queries
};
```

---

## 12. Migration Path

### 12.1 Implementation Phases

#### Phase 1: Core VFS (1 week)
- [ ] SQLite schema creation
- [ ] Basic file operations (open, read, write, close)
- [ ] Directory operations (mkdir, readdir, rmdir)
- [ ] File metadata (lstat, chmod, utimes)

#### Phase 2: Integration (1 week)
- [ ] Emscripten VFS adapter
- [ ] PGlite integration testing
- [ ] Basic PostgreSQL operations verified

#### Phase 3: Optimizations (1 week)
- [ ] Chunk caching layer
- [ ] Write buffering for WAL
- [ ] Directory caching
- [ ] Performance benchmarks

#### Phase 4: Production Hardening (1 week)
- [ ] Error handling and recovery
- [ ] Corruption detection
- [ ] Monitoring and metrics
- [ ] Documentation

### 12.2 Testing Strategy

```typescript
describe('SqliteBlobVFS', () => {
  describe('File Operations', () => {
    test('creates and reads file');
    test('writes spanning multiple chunks');
    test('truncates file');
    test('handles concurrent reads');
  });

  describe('Directory Operations', () => {
    test('creates nested directories');
    test('lists directory contents');
    test('removes directory recursively');
  });

  describe('WAL Handling', () => {
    test('writes WAL segments');
    test('buffers small WAL writes');
    test('syncs WAL on checkpoint');
  });

  describe('Integration', () => {
    test('PGlite creates database');
    test('PGlite runs queries');
    test('PGlite survives restart');
  });
});
```

---

## Conclusion

Using Cloudflare Durable Objects' SQLite storage as a VFS for PGlite is a viable approach that provides:

1. **Durable, transactional storage** for PostgreSQL data
2. **Zero external dependencies** - uses only built-in DO capabilities
3. **Reasonable performance** for typical workloads
4. **Sufficient capacity** (10GB) for most edge database use cases

The main trade-off is the lack of true incremental blob I/O, requiring careful chunk sizing and write buffering strategies. For production use, consider combining with:

- **R2 for large backups** - Periodic snapshots to R2 for disaster recovery
- **DO sharding** - Split large databases across multiple DOs
- **Query caching** - Cache frequent query results at the Worker level

---

## References

- [PGlite Repository](https://github.com/electric-sql/pglite)
- [Cloudflare Durable Objects SQLite Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [SQLite Incremental Blob I/O](https://sqlite.org/c3ref/blob_open.html)
- [PostgreSQL File Layout](https://www.postgresql.org/docs/current/storage-file-layout.html)
- [Emscripten File System](https://emscripten.org/docs/api_reference/Filesystem-API.html)

---

*Design document created 2026-01-16*
