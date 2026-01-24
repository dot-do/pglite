import PostgresModFactory from '../release/pglite'

type IDBFS = Emscripten.FileSystemType & {
  quit: () => void
  dbs: Record<string, IDBDatabase>
}

export type FS = typeof FS & {
  filesystems: {
    MEMFS: Emscripten.FileSystemType
    NODEFS: Emscripten.FileSystemType
    IDBFS: IDBFS
  }
  quit: () => void
}

/**
 * Callback interface for Cloudflare Workers compatibility.
 * These callbacks are called by EM_JS trampolines in the C code,
 * avoiding runtime WASM generation that Cloudflare blocks.
 */
export interface PGliteCallbacks {
  /**
   * Called when PostgreSQL writes data to the client.
   * @param ptr Pointer to data in WASM memory
   * @param length Number of bytes to write
   * @returns Number of bytes written
   */
  write: (ptr: number, length: number) => number
  /**
   * Called when PostgreSQL reads data from the client.
   * @param ptr Pointer to buffer in WASM memory
   * @param maxLength Maximum number of bytes to read
   * @returns Number of bytes read
   */
  read: (ptr: number, maxLength: number) => number
}

export interface PostgresMod
  extends Omit<EmscriptenModule, 'preInit' | 'preRun' | 'postRun'> {
  preInit: Array<{ (mod: PostgresMod): void }>
  preRun: Array<{ (mod: PostgresMod): void }>
  postRun: Array<{ (mod: PostgresMod): void }>
  FS: FS
  FD_BUFFER_MAX: number
  WASM_PREFIX: string
  INITIAL_MEMORY: number
  pg_extensions: Record<string, Promise<Blob | null>>
  /**
   * Callbacks for read/write operations.
   * Used by EM_JS trampolines for Cloudflare Workers compatibility.
   * Must be set BEFORE calling _pgl_initdb.
   */
  _pgliteCallbacks?: PGliteCallbacks
  _pgl_initdb: () => number
  _pgl_backend: () => void
  _pgl_shutdown: () => void
  _pgl_reseed_random: (seed_high: number, seed_low: number) => void
  _interactive_write: (msgLength: number) => void
  _interactive_one: (length: number, peek: number) => void
  _set_read_write_cbs: (read_cb: number, write_cb: number) => void
  addFunction: (
    cb: (ptr: any, length: number) => void,
    signature: string,
  ) => number
  removeFunction: (f: number) => void
  wasmTable?: WebAssembly.Table
}

type PostgresFactory<T extends PostgresMod = PostgresMod> = (
  moduleOverrides?: Partial<T>,
) => Promise<T>

export default PostgresModFactory as PostgresFactory<PostgresMod>
