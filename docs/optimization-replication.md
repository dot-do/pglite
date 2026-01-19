# PostgreSQL Replication Subsystem Optimization

This document analyzes the PostgreSQL replication subsystem and its potential removal to reduce WASM binary size for PGlite.

## Overview

PGlite runs in single-instance mode within a Durable Object or browser environment. The replication subsystem (WAL sender/receiver, logical decoding, streaming replication) is never used in this context. Disabling it at build time can reduce the WASM size by approximately 1-1.5MB.

## Replication Subsystem Structure

### Source Code Location

The replication code is located in `src/backend/replication/` with the following structure:

```
src/backend/replication/
├── slot.c                 # Replication slot management
├── slotfuncs.c            # SQL-callable slot functions
├── syncrep.c              # Synchronous replication coordination
├── syncrep_gram.y         # Sync rep config grammar
├── syncrep_scanner.l      # Sync rep config lexer
├── walreceiver.c          # WAL receiver process
├── walreceiverfuncs.c     # WAL receiver utility functions
├── walsender.c            # WAL sender process (largest file - 4285 lines)
├── repl_gram.y            # Replication command grammar
├── repl_scanner.l         # Replication command lexer
├── logical/               # Logical replication subsystem
│   ├── applyparallelworker.c
│   ├── decode.c           # Logical decoding
│   ├── launcher.c         # Logical replication launcher
│   ├── logical.c          # Logical decoding core
│   ├── logicalfuncs.c     # SQL-callable logical functions
│   ├── message.c          # Logical messages
│   ├── origin.c           # Replication origin tracking
│   ├── proto.c            # Logical protocol
│   ├── relation.c         # Relation mapping
│   ├── reorderbuffer.c    # Transaction reordering (largest - 5362 lines)
│   ├── slotsync.c         # Slot synchronization
│   ├── snapbuild.c        # Snapshot building
│   ├── tablesync.c        # Table synchronization
│   └── worker.c           # Logical replication worker (5135 lines)
├── libpqwalreceiver/      # Dynamically loaded WAL receiver module
│   └── libpqwalreceiver.c # libpq-based WAL receiving
└── pgoutput/              # Logical replication output plugin
    └── pgoutput.c         # Standard logical output format
```

### Source Code Size

| Component | Lines of Code | Source Size |
|-----------|--------------|-------------|
| Core replication (`*.c`) | 19,190 lines | ~450KB |
| Logical replication (`logical/*.c`) | 27,010 lines | ~650KB |
| libpqwalreceiver | 1,237 lines | ~37KB |
| pgoutput | 2,500 lines | ~73KB |
| **Total** | **~46,200 lines** | **~1.3MB** |

### Compiled Object File Size

| Component | Object Size |
|-----------|------------|
| Core replication (`*.o`) | 196KB |
| Logical replication (`logical/*.o`) | 414KB |
| libpqwalreceiver.so | 122KB |
| pgoutput.so | 13KB |
| **Total** | **~625KB (object files)** |

**Estimated WASM Impact:** 1-1.5MB when including dead code elimination inefficiencies and related dependencies.

## Components Analysis

### 1. WAL Sender (`walsender.c`)

**Purpose:** Sends WAL records to standby servers for streaming replication.

**Key Functions:**
- `InitWalSender()` - Initialize WAL sender process
- `exec_replication_command()` - Execute replication protocol commands
- `WalSndWakeup()` - Wake up WAL senders when new WAL is available
- `WalSndShmemSize()`/`WalSndShmemInit()` - Shared memory management

**Dependencies in Core:**
- Called from `xlog.c` for WAL position tracking
- Called from `checkpointer.c` during shutdown
- Called from `postmaster.c` for process management

### 2. WAL Receiver (`walreceiver.c`, `walreceiverfuncs.c`)

**Purpose:** Receives WAL from primary server on standby nodes.

**Key Functions:**
- `WalRcvShmemSize()`/`WalRcvShmemInit()` - Shared memory management
- `ShutdownWalRcv()` - Shutdown WAL receiver
- `RequestXLogStreaming()` - Request WAL streaming from primary

**Dependencies:**
- Called from `xlogrecovery.c` during recovery
- Called from `startup.c` for recovery coordination

### 3. Synchronous Replication (`syncrep.c`)

**Purpose:** Coordinates synchronous commits with standbys.

**Key Functions:**
- `SyncRepInitConfig()` - Initialize sync rep configuration
- `SyncRepWaitForLSN()` - Wait for WAL to be replicated
- `SyncRepReleaseWaiters()` - Release waiting backends

**Dependencies:**
- Called from `xact.c` during commit
- Called from `twophase.c` for two-phase commit
- GUC parameters: `synchronous_standby_names`, `synchronous_commit`

### 4. Replication Slots (`slot.c`, `slotfuncs.c`)

**Purpose:** Persistent bookmarks for replication consumers.

**Key Functions:**
- `ReplicationSlotCreate()`/`ReplicationSlotDrop()` - Slot lifecycle
- `ReplicationSlotsComputeRequiredLSN()` - Compute WAL retention
- SQL functions: `pg_create_physical_replication_slot()`, `pg_create_logical_replication_slot()`

**Dependencies:**
- WAL retention decisions in `xlog.c`
- Checkpoint logic in `checkpointer.c`

### 5. Logical Replication (`logical/`)

**Purpose:** Change data capture and logical replication.

**Key Components:**
- `decode.c` - WAL record decoding for logical replication
- `logical.c` - Logical decoding context management
- `reorderbuffer.c` - Transaction reordering for logical output
- `snapbuild.c` - Snapshot building for logical decoding
- `launcher.c` - Background worker launcher for subscribers
- `worker.c` - Subscription workers

**SQL Functions:**
- `pg_logical_slot_peek_changes()`
- `pg_logical_slot_get_changes()`
- Subscription management commands

## Configure Flags Investigation

### Current Status

PostgreSQL's `configure` script does **NOT** have a `--disable-replication` flag. The replication subsystem is always compiled into the backend.

Available disable options from `./configure --help`:
```
--disable-spinlocks       do not use spinlocks
--disable-atomics         do not use atomic operations
--disable-largefile       omit support for large files
--disable-integer-datetimes  obsolete option
--disable-rpath           do not embed shared library search path
```

### Why No Disable Flag?

Replication is deeply integrated into the PostgreSQL backend:

1. **WAL Infrastructure** - Even single-server WAL depends on some replication concepts
2. **Shared Memory** - Replication structures are part of shared memory layout
3. **Checkpoint Logic** - WAL retention depends on slot information
4. **System Catalogs** - `pg_replication_origin`, `pg_replication_slots` are core catalogs
5. **GUC Parameters** - Many replication-related GUCs exist

## Size Savings Estimate

### Conservative Estimate

| Component | Estimated WASM Savings |
|-----------|----------------------|
| Replication object code | 500-600KB |
| libpqwalreceiver.so (not needed) | 122KB |
| pgoutput.so (not needed) | 13KB |
| Dead code in dependencies | 200-400KB |
| **Total** | **~800KB - 1.2MB** |

### Optimistic Estimate

With aggressive dead code elimination and removal of related data structures:
- **Up to 1.5MB** savings possible

## Risks and Tradeoffs

### Features That Would Be Lost

1. **Streaming Replication** - Not applicable to PGlite (single instance)
2. **Logical Replication** - Not applicable to PGlite
3. **Replication Slots** - Not used in PGlite context
4. **pg_basebackup** - Not applicable
5. **Synchronous Replication** - Not applicable

### SQL Functions That Would Fail

```sql
-- These would error or need stub implementations
SELECT * FROM pg_stat_replication;
SELECT * FROM pg_replication_slots;
SELECT pg_create_physical_replication_slot('test');
SELECT pg_create_logical_replication_slot('test', 'pgoutput');
SELECT * FROM pg_logical_slot_get_changes('test', NULL, NULL);
```

### Potential Breakage Points

1. **System Views** - `pg_stat_replication`, `pg_replication_slots` would need stubs
2. **Catalog Tables** - `pg_replication_origin` referenced in catalog code
3. **WAL Retention** - Logic assumes slot infrastructure exists
4. **Shared Memory Initialization** - `WalSndShmemInit()` called during startup

### Mitigation Strategies

1. **Stub Functions** - Provide no-op implementations that return empty results
2. **Compile-Time Defines** - Use `#ifdef DISABLE_REPLICATION` guards
3. **Graceful Errors** - Return clear error messages for unsupported functions

## Implementation Approach

### Option 1: Configure Flag (Recommended)

Add `--disable-replication` to PostgreSQL's configure script:

```bash
# configure.ac additions
AC_ARG_ENABLE([replication],
  [AS_HELP_STRING([--disable-replication],
    [disable replication subsystem for embedded use])],
  [], [enable_replication=yes])

if test "$enable_replication" = no; then
  AC_DEFINE([DISABLE_REPLICATION], 1,
    [Define to 1 to disable replication subsystem])
fi
AM_CONDITIONAL([DISABLE_REPLICATION], [test "$enable_replication" = no])
```

**Pros:**
- Clean, maintainable approach
- Easy to enable/disable per build
- Follows PostgreSQL conventions

**Cons:**
- Requires extensive `#ifdef` additions throughout codebase
- May conflict with upstream updates

### Option 2: Makefile Exclusion

Modify `src/backend/Makefile` to conditionally exclude replication:

```makefile
# src/backend/Makefile
ifdef DISABLE_REPLICATION
SUBDIRS = access archive backup bootstrap catalog parser commands executor \
    foreign lib libpq \
    main nodes optimizer partitioning port postmaster \
    regex rewrite \
    statistics storage tcop tsearch utils $(top_builddir)/src/timezone \
    jit
else
SUBDIRS = access archive backup bootstrap catalog parser commands executor \
    foreign lib libpq \
    main nodes optimizer partitioning port postmaster \
    regex replication rewrite \
    statistics storage tcop tsearch utils $(top_builddir)/src/timezone \
    jit
endif
```

**Pros:**
- Simple to implement
- No core PostgreSQL changes needed

**Cons:**
- Will cause linker errors (undefined references)
- Requires stub library for missing symbols

### Option 3: Stub Library

Create `replication_stubs.c` with no-op implementations:

```c
/* replication_stubs.c */
#include "postgres.h"
#include "replication/walsender.h"

bool am_walsender = false;
bool am_cascading_walsender = false;
bool am_db_walsender = false;
bool wake_wal_senders = false;
int max_wal_senders = 0;

void WalSndShmemInit(void) { /* no-op */ }
Size WalSndShmemSize(void) { return 0; }
void WalSndWakeup(bool physical, bool logical) { /* no-op */ }
void InitWalSender(void) { /* no-op */ }
/* ... additional stubs ... */
```

**Pros:**
- Minimal changes to build system
- Can be maintained separately

**Cons:**
- Must keep stubs in sync with PostgreSQL versions
- Potential for subtle bugs if stubs are incorrect

### Option 4: Link-Time Optimization

Rely on `-flto` (Link-Time Optimization) and `-fdata-sections -ffunction-sections` with `--gc-sections`:

```bash
CFLAGS="-Oz -flto -fdata-sections -ffunction-sections"
LDFLAGS="-Wl,--gc-sections"
```

**Pros:**
- No source code changes
- Automatically removes unused code

**Cons:**
- Only removes truly dead code
- Replication code may still be reachable through function pointers
- Less predictable size savings

## Recommended Implementation

For PGlite, a phased approach is recommended:

### Phase 1: Measurement (Current)

1. Build with existing optimizations (`-Oz -flto`)
2. Measure current WASM size with replication included
3. Use `wasm-objdump` to identify replication symbols in output

### Phase 2: Stub Implementation

1. Create `replication_stubs.c` with minimal implementations
2. Modify Makefile to exclude replication directory
3. Link stub library instead
4. Verify build succeeds and core functionality works

### Phase 3: Conditional Compilation (Optional)

1. Add `#ifdef DISABLE_REPLICATION` guards to key integration points
2. Create proper configure flag
3. Maintain as a PGlite-specific patch

## Verification Checklist

After disabling replication:

- [ ] PGlite initializes successfully
- [ ] Basic SQL operations work (SELECT, INSERT, UPDATE, DELETE)
- [ ] Transactions commit and rollback correctly
- [ ] WAL works for crash recovery (single-instance)
- [ ] Extensions load and function correctly
- [ ] System catalogs are accessible
- [ ] WASM size reduced by expected amount
- [ ] No runtime errors from missing replication code

## Related Issues

- Memory optimization for Cloudflare Workers (128MB limit)
- Extension lazy loading
- WASM binary size reduction targets

## References

- PostgreSQL Documentation: [Replication](https://www.postgresql.org/docs/current/high-availability.html)
- PostgreSQL Source: `src/backend/replication/README`
- Emscripten: [Code Size Optimization](https://emscripten.org/docs/optimizing/Optimizing-Code.html)
