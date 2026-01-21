import type {
  BackendMessage,
  NoticeMessage,
} from '@electric-sql/pg-protocol/messages'
import type { Filesystem } from './fs/base.js'
import type { DumpTarCompressionOptions } from './fs/tarUtils.js'
import type { Parser, Serializer } from './types.js'

/**
 * Callback interface for PGlite's Emscripten module integration.
 *
 * These callbacks enable communication between PostgreSQL's C code (compiled to WASM)
 * and JavaScript without requiring runtime WASM compilation. This is achieved through
 * EM_JS trampolines that are compiled at build time.
 *
 * The callbacks are stored in `Module._pgliteCallbacks` and are invoked by the
 * trampoline functions in the WASM code when PostgreSQL needs to read input or
 * write output.
 *
 * This approach is necessary for Cloudflare Workers compatibility, where runtime
 * WASM compilation via `addFunction` is blocked for security reasons.
 *
 * @see https://blog.pyodide.org/posts/function-pointer-cast-handling/
 *
 * @example
 * ```typescript
 * // Setting up callbacks on the Emscripten module
 * (mod as any)._pgliteCallbacks = {
 *   read: (ptr, maxLength) => {
 *     // Copy data to WASM memory at ptr
 *     mod.HEAP8.set(inputData.subarray(readOffset, readOffset + length), ptr);
 *     return length;
 *   },
 *   write: (ptr, length) => {
 *     // Read data from WASM memory at ptr
 *     const bytes = mod.HEAPU8.subarray(ptr, ptr + length);
 *     processOutput(bytes);
 *     return length;
 *   }
 * };
 * ```
 */
export interface PGliteCallbacks {
  /**
   * Read callback - called when PostgreSQL needs input data.
   *
   * This callback is invoked by the `recv()` trampoline in the WASM code
   * when PostgreSQL is waiting for input (e.g., query data from the client).
   *
   * @param ptr - Pointer to WASM memory where data should be written
   * @param maxLength - Maximum number of bytes that can be written
   * @returns Number of bytes actually written, or negative value on error
   *
   * @example
   * ```typescript
   * read: (ptr, maxLength) => {
   *   const available = outputData.length - readOffset;
   *   const length = Math.min(available, maxLength);
   *   mod.HEAP8.set(
   *     outputData.subarray(readOffset, readOffset + length),
   *     ptr
   *   );
   *   readOffset += length;
   *   return length;
   * }
   * ```
   */
  read: ((ptr: number, maxLength: number) => number) | null

  /**
   * Write callback - called when PostgreSQL has output data.
   *
   * This callback is invoked by the `send()` trampoline in the WASM code
   * when PostgreSQL sends response data (e.g., query results, errors, notices).
   *
   * @param ptr - Pointer to WASM memory containing the output data
   * @param length - Number of bytes available to read
   * @returns Number of bytes processed, or negative value on error
   *
   * @example
   * ```typescript
   * write: (ptr, length) => {
   *   const bytes = mod.HEAPU8.subarray(ptr, ptr + length);
   *   protocolParser.parse(bytes, (msg) => {
   *     handleMessage(msg);
   *   });
   *   return length;
   * }
   * ```
   */
  write: ((ptr: number, length: number) => number) | null
}

export type FilesystemType = 'nodefs' | 'idbfs' | 'memoryfs'

export type DebugLevel = 0 | 1 | 2 | 3 | 4 | 5

export type RowMode = 'array' | 'object'

export interface ParserOptions {
  [pgType: number]: (value: string) => unknown
}

export interface SerializerOptions {
  [pgType: number]: (value: unknown) => string
}

export interface QueryOptions {
  rowMode?: RowMode
  parsers?: ParserOptions
  serializers?: SerializerOptions
  blob?: Blob | File
  onNotice?: (notice: NoticeMessage) => void
  paramTypes?: number[]
}

export interface ExecProtocolOptions {
  syncToFs?: boolean
  throwOnError?: boolean
  onNotice?: (notice: NoticeMessage) => void
}

export interface ExtensionSetupResult<TNamespace = unknown> {
  emscriptenOpts?: Record<string, unknown>
  namespaceObj?: TNamespace
  bundlePath?: URL
  init?: () => Promise<void>
  close?: () => Promise<void>
  /**
   * List of extension names that must be loaded before this extension.
   * Used for automatic dependency resolution in lazy loading.
   */
  dependencies?: string[]
}

export type ExtensionSetup<TNamespace = unknown> = (
  pg: PGliteInterface,
  emscriptenOpts: Record<string, unknown>,
  clientOnly?: boolean,
) => Promise<ExtensionSetupResult<TNamespace>>

export interface Extension<TNamespace = unknown> {
  name: string
  setup: ExtensionSetup<TNamespace>
}

export type ExtensionNamespace<T> =
  T extends Extension<infer TNamespace> ? TNamespace : unknown

export type Extensions = {
  [namespace: string]: Extension | URL
}

export type InitializedExtensions<TExtensions extends Extensions = Extensions> =
  {
    [K in keyof TExtensions]: ExtensionNamespace<TExtensions[K]>
  }

export interface ExecProtocolResult {
  messages: BackendMessage[]
  data: Uint8Array
}

export interface DumpDataDirResult {
  tarball: Uint8Array
  extension: '.tar' | '.tgz'
  filename: string
}

/**
 * Memory snapshot for fast cold starts.
 * Contains pre-initialized WASM memory state captured after initdb.
 */
export interface MemorySnapshot {
  /**
   * Snapshot format version for compatibility checking
   */
  version: string
  /**
   * Size of the WASM heap in bytes
   */
  heapSize: number
  /**
   * The captured WASM linear memory as an ArrayBuffer
   */
  heap: ArrayBuffer
  /**
   * Timestamp when the snapshot was captured (Unix ms)
   */
  capturedAt: number
  /**
   * PostgreSQL version this snapshot was created with
   */
  pgVersion?: string
  /**
   * Extensions that were pre-loaded in the snapshot
   */
  extensions?: string[]
}

/**
 * Memory statistics for monitoring WASM heap usage.
 * Useful for tracking memory consumption in constrained environments
 * like Cloudflare Workers (128MB limit).
 */
export interface MemoryStats {
  /**
   * Total WASM heap size in bytes (allocated memory)
   */
  heapSize: number
  /**
   * Peak heap size observed during this session (if trackable)
   * Note: This is only tracked from when PGlite was initialized
   */
  peakHeapSize: number
  /**
   * PostgreSQL memory configuration settings
   */
  postgresSettings: {
    sharedBuffers: string
    workMem: string
    tempBuffers: string
    walBuffers: string
    maintenanceWorkMem: string
  }
}

export interface PGliteOptions<TExtensions extends Extensions = Extensions> {
  dataDir?: string
  username?: string
  database?: string
  fs?: Filesystem
  debug?: DebugLevel
  relaxedDurability?: boolean
  extensions?: TExtensions
  loadDataDir?: Blob | File
  initialMemory?: number
  wasmModule?: WebAssembly.Module
  fsBundle?: Blob | File
  parsers?: ParserOptions
  serializers?: SerializerOptions
  /**
   * Pre-initialized memory snapshot for fast cold starts.
   * When provided, skips initdb and restores from the snapshot.
   * CRITICAL: RNG is automatically reseeded after restore for security.
   */
  memorySnapshot?: MemorySnapshot
  /**
   * When true, extension bundles are not loaded at initialization time.
   * Extensions are loaded on-demand when CREATE EXTENSION is called or
   * when explicitly loaded via loadExtension().
   * This can significantly reduce initial memory usage.
   */
  lazyExtensions?: boolean
  /**
   * When true (and lazyExtensions is enabled), extensions are automatically
   * loaded when extension-specific SQL syntax is detected.
   * Requires SQL parsing to detect extension usage.
   */
  autoLoadExtensions?: boolean
  /**
   * Feature flags to control extension availability.
   * When a flag is false, the extension will not be available even if configured.
   */
  extensionFlags?: Record<string, boolean>
}

/**
 * Status of a configured extension
 */
export interface ExtensionStatus {
  /**
   * Whether the extension is configured in PGliteOptions
   */
  configured: boolean
  /**
   * Whether the extension bundle has been loaded into memory
   */
  loaded: boolean
}

/**
 * Memory statistics for a single extension
 */
export interface ExtensionMemoryStats {
  /**
   * Size of the extension bundle in bytes
   */
  bundleSize: number
  /**
   * Whether the extension is currently loaded
   */
  loaded: boolean
  /**
   * Heap size increase after loading this extension (if measurable)
   */
  heapIncrease?: number
}

export type PGliteInterface<T extends Extensions = Extensions> =
  InitializedExtensions<T> & {
    readonly waitReady: Promise<void>
    readonly debug: DebugLevel
    readonly ready: boolean
    readonly closed: boolean

    close(): Promise<void>
    query<T>(
      query: string,
      params?: unknown[],
      options?: QueryOptions,
    ): Promise<Results<T>>
    sql<T>(
      sqlStrings: TemplateStringsArray,
      ...params: unknown[]
    ): Promise<Results<T>>
    exec(query: string, options?: QueryOptions): Promise<Array<Results>>
    describeQuery(query: string): Promise<DescribeQueryResult>
    transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>
    execProtocolRaw(
      message: Uint8Array,
      options?: ExecProtocolOptions,
    ): Promise<Uint8Array>
    execProtocol(
      message: Uint8Array,
      options?: ExecProtocolOptions,
    ): Promise<ExecProtocolResult>
    runExclusive<T>(fn: () => Promise<T>): Promise<T>
    listen(
      channel: string,
      callback: (payload: string) => void,
      tx?: Transaction,
    ): Promise<(tx?: Transaction) => Promise<void>>
    unlisten(
      channel: string,
      callback?: (payload: string) => void,
      tx?: Transaction,
    ): Promise<void>
    onNotification(
      callback: (channel: string, payload: string) => void,
    ): () => void
    offNotification(callback: (channel: string, payload: string) => void): void
    dumpDataDir(compression?: DumpTarCompressionOptions): Promise<File | Blob>
    refreshArrayTypes(): Promise<void>
    getMemoryStats(): Promise<MemoryStats>
  }

export type PGliteInterfaceExtensions<E> = E extends Extensions
  ? {
      [K in keyof E]: E[K] extends Extension
        ? Awaited<ReturnType<E[K]['setup']>>['namespaceObj'] extends infer N
          ? N extends undefined | null | void
            ? never
            : N
          : never
        : never
    }
  : Record<string, never>

export type Row<T = { [key: string]: unknown }> = T

export type Results<T = { [key: string]: unknown }> = {
  rows: Row<T>[]
  affectedRows?: number
  fields: { name: string; dataTypeID: number }[]
  blob?: Blob // Only set when a file is returned, such as from a COPY command
}

export interface Transaction {
  query<T>(
    query: string,
    params?: unknown[],
    options?: QueryOptions,
  ): Promise<Results<T>>
  sql<T>(
    sqlStrings: TemplateStringsArray,
    ...params: unknown[]
  ): Promise<Results<T>>
  exec(query: string, options?: QueryOptions): Promise<Array<Results>>
  rollback(): Promise<void>
  listen(
    channel: string,
    callback: (payload: string) => void,
  ): Promise<(tx?: Transaction) => Promise<void>>
  get closed(): boolean
}

export type DescribeQueryResult = {
  queryParams: { dataTypeID: number; serializer: Serializer }[]
  resultFields: { name: string; dataTypeID: number; parser: Parser }[]
}
