import { Mutex } from 'async-mutex'
import { BasePGlite } from './base.js'
import { loadExtensionBundle, loadExtensions } from './extensionUtils.js'
import {
  type Filesystem,
  loadFs,
  parseDataDir,
  PGDATA,
  WASM_PREFIX,
} from './fs/index.js'
import { DumpTarCompressionOptions, loadTar } from './fs/tarUtils.js'
import type {
  DebugLevel,
  ExecProtocolOptions,
  ExecProtocolResult,
  Extension,
  ExtensionMemoryStats,
  ExtensionSetupResult,
  Extensions,
  ExtensionStatus,
  MemorySnapshot,
  MemoryStats,
  PGliteInterface,
  PGliteInterfaceBase,
  PGliteInterfaceExtensions,
  PGliteOptions,
  Transaction,
} from './interface.js'
import PostgresModFactory, { type PostgresMod } from './postgresMod.js'
import {
  getFsBundle,
  instantiateWasm,
  startWasmDownload,
  toPostgresName,
} from './utils.js'

// Importing the source as the built version is not ESM compatible
import { Parser as ProtocolParser, serialize } from '@electric-sql/pg-protocol'
import {
  BackendMessage,
  CommandCompleteMessage,
  DatabaseError,
  NoticeMessage,
  NotificationResponseMessage,
} from '@electric-sql/pg-protocol/messages'

export class PGlite
  extends BasePGlite
  implements PGliteInterfaceBase, AsyncDisposable
{
  fs?: Filesystem
  protected mod?: PostgresMod

  readonly dataDir?: string

  #ready = false
  #closing = false
  #closed = false
  #inTransaction = false
  #relaxedDurability = false

  readonly waitReady: Promise<void>

  #queryMutex = new Mutex()
  #transactionMutex = new Mutex()
  #listenMutex = new Mutex()
  #fsSyncMutex = new Mutex()
  #fsSyncScheduled = false

  readonly debug: DebugLevel = 0

  #extensions: Extensions
  #extensionsClose: Array<() => Promise<void>> = []
  #lazyExtensions: boolean = false
  #autoLoadExtensions: boolean = false
  #extensionFlags: Record<string, boolean> = {}
  #loadedExtensions: Set<string> = new Set()
  /**
   * Cache of extension setup results to avoid redundant setup calls.
   * This is populated during init (for lazy mode) or when loadExtension is called.
   */
  #extensionSetupResults: Map<string, ExtensionSetupResult> = new Map()
  /**
   * Track bundle sizes for memory monitoring. Only populated when extensions are loaded.
   */
  #extensionBundleSizes: Map<string, number> = new Map()
  /**
   * Track heap increase per extension. Only populated when extensions are loaded
   * and heap growth is detected.
   */
  #extensionHeapIncrease: Map<string, number> = new Map()
  #extensionLoadListeners: Set<(extName: string) => void> = new Set()
  /**
   * Mutex to prevent concurrent extension loading which could cause race conditions.
   */
  #extensionLoadMutex = new Mutex()

  #protocolParser = new ProtocolParser()

  // These are the current ArrayBuffer that is being read or written to
  // during a query, such as COPY FROM or COPY TO.
  #queryReadBuffer?: ArrayBuffer
  #queryWriteChunks?: Uint8Array[]

  #notifyListeners = new Map<string, Set<(payload: string) => void>>()
  #globalNotifyListeners = new Set<(channel: string, payload: string) => void>()

  // receive data from wasm
  // TRAMPOLINE MODE: Function pointer storage no longer needed
  // Callbacks are stored in (this.mod as any)._pgliteCallbacks instead

  #currentResults: BackendMessage[] = []
  #currentThrowOnError: boolean = false
  #currentOnNotice: ((notice: NoticeMessage) => void) | undefined

  // send data to wasm
    // buffer that holds the data to be sent to wasm
  #outputData: any = []
  // read index in the buffer
  #readOffset: number = 0
  #currentDatabaseError: DatabaseError | null = null

  #keepRawResponse: boolean = true
  // these are needed for point 2 above
  static readonly DEFAULT_RECV_BUF_SIZE: number = 1 * 1024 * 1024 // 1MB default
  static readonly MAX_BUFFER_SIZE: number = Math.pow(2, 30)
  // buffer that holds data received from wasm
  #inputData = new Uint8Array(0)
  // write index in the buffer
  #writeOffset: number = 0

  // Memory monitoring: track peak heap size observed during this session
  #peakHeapSize: number = 0

  /**
   * Create a new PGlite instance
   * @param dataDir The directory to store the database files
   *                Prefix with idb:// to use indexeddb filesystem in the browser
   *                Use memory:// to use in-memory filesystem
   * @param options PGlite options
   */
  constructor(dataDir?: string, options?: PGliteOptions)

  /**
   * Create a new PGlite instance
   * @param options PGlite options including the data directory
   */
  constructor(options?: PGliteOptions)

  constructor(
    dataDirOrPGliteOptions: string | PGliteOptions = {},
    options: PGliteOptions = {},
  ) {
    super()
    if (typeof dataDirOrPGliteOptions === 'string') {
      options = {
        dataDir: dataDirOrPGliteOptions,
        ...options,
      }
    } else {
      options = dataDirOrPGliteOptions
    }
    this.dataDir = options.dataDir

    // Override default parsers and serializers if requested
    if (options.parsers !== undefined) {
      this.parsers = { ...this.parsers, ...options.parsers }
    }
    if (options.serializers !== undefined) {
      this.serializers = { ...this.serializers, ...options.serializers }
    }

    // Enable debug logging if requested
    if (options?.debug !== undefined) {
      this.debug = options.debug
    }

    // Enable relaxed durability if requested
    if (options?.relaxedDurability !== undefined) {
      this.#relaxedDurability = options.relaxedDurability
    }

    // Save the extensions for later use
    this.#extensions = options.extensions ?? {}

    // Enable lazy extension loading if requested
    if (options?.lazyExtensions !== undefined) {
      this.#lazyExtensions = options.lazyExtensions
    }

    // Enable auto-loading of extensions when SQL syntax is detected
    if (options?.autoLoadExtensions !== undefined) {
      this.#autoLoadExtensions = options.autoLoadExtensions
    }

    // Save extension feature flags
    if (options?.extensionFlags !== undefined) {
      this.#extensionFlags = options.extensionFlags
    }

    // Initialize the database, and store the promise so we can wait for it to be ready
    this.waitReady = this.#init(options ?? {})
  }

  /**
   * Create a new PGlite instance with extensions on the Typescript interface
   * (The main constructor does enable extensions, however due to the limitations
   * of Typescript, the extensions are not available on the instance interface)
   * @param options PGlite options including the data directory
   * @returns A promise that resolves to the PGlite instance when it's ready.
   */

  static async create<O extends PGliteOptions>(
    options?: O,
  ): Promise<PGlite & PGliteInterfaceExtensions<O['extensions']>>

  /**
   * Create a new PGlite instance with extensions on the Typescript interface
   * (The main constructor does enable extensions, however due to the limitations
   * of Typescript, the extensions are not available on the instance interface)
   * @param dataDir The directory to store the database files
   *                Prefix with idb:// to use indexeddb filesystem in the browser
   *                Use memory:// to use in-memory filesystem
   * @param options PGlite options
   * @returns A promise that resolves to the PGlite instance when it's ready.
   */
  static async create<O extends PGliteOptions>(
    dataDir?: string,
    options?: O,
  ): Promise<PGlite & PGliteInterfaceExtensions<O['extensions']>>

  static async create<TExtensions extends Extensions = Extensions>(
    dataDirOrPGliteOptions?: string | PGliteOptions<TExtensions>,
    options?: PGliteOptions<TExtensions>,
  ): Promise<PGlite & PGliteInterface<TExtensions>> {
    const resolvedOpts: PGliteOptions =
      typeof dataDirOrPGliteOptions === 'string'
        ? {
            dataDir: dataDirOrPGliteOptions,
            ...(options ?? {}),
          }
        : (dataDirOrPGliteOptions ?? {})

    const pg = new PGlite(resolvedOpts)
    await pg.waitReady
    return pg as any
  }

  /**
   * Initialize the database
   * @returns A promise that resolves when the database is ready
   */
  async #init(options: PGliteOptions) {
    // Check if we should initialize from a memory snapshot (fast path)
    if (options.memorySnapshot) {
      return this.#initFromSnapshot(options)
    }

    if (options.fs) {
      this.fs = options.fs
    } else {
      const { dataDir, fsType } = parseDataDir(options.dataDir)
      this.fs = await loadFs(dataDir, fsType)
    }

    const extensionBundlePromises: Record<string, Promise<Blob | null>> = {}
    const extensionInitFns: Array<() => Promise<void>> = []

    const args = [
      `PGDATA=${PGDATA}`,
      `PREFIX=${WASM_PREFIX}`,
      `PGUSER=${options.username ?? 'postgres'}`,
      `PGDATABASE=${options.database ?? 'template1'}`,
      'MODE=REACT',
      'REPL=N',
      // "-F", // Disable fsync (TODO: Only for in-memory mode?)
      ...(this.debug ? ['-d', this.debug.toString()] : []),
    ]

    if (!options.wasmModule) {
      // Start the wasm download in the background so it's ready when we need it
      startWasmDownload()
    }

    // Get the fs bundle
    // We don't await the loading of the fs bundle at this point as we can continue
    // with other work.
    // It's resolved value `fsBundleBuffer` is set and used in `getPreloadedPackage`
    // which is called via `PostgresModFactory` after we have awaited
    // `fsBundleBufferPromise` below.
    const fsBundleBufferPromise = options.fsBundle
      ? options.fsBundle.arrayBuffer()
      : getFsBundle()
    let fsBundleBuffer: ArrayBuffer
    fsBundleBufferPromise.then((buffer) => {
      fsBundleBuffer = buffer
    })

    let emscriptenOpts: Partial<PostgresMod> = {
      WASM_PREFIX,
      arguments: args,
      INITIAL_MEMORY: options.initialMemory,
      noExitRuntime: true,
      ...(this.debug > 0
        ? { print: console.info, printErr: console.error }
        : { print: () => {}, printErr: () => {} }),
      instantiateWasm: (imports, successCallback) => {
        instantiateWasm(imports, options.wasmModule).then(
          ({ instance, module }) => {
            // @ts-ignore wrong type in Emscripten typings
            successCallback(instance, module)
          },
        )
        return {}
      },
      getPreloadedPackage: (remotePackageName, remotePackageSize) => {
        if (remotePackageName === 'pglite.data') {
          if (fsBundleBuffer.byteLength !== remotePackageSize) {
            throw new Error(
              `Invalid FS bundle size: ${fsBundleBuffer.byteLength} !== ${remotePackageSize}`,
            )
          }
          return fsBundleBuffer
        }
        throw new Error(`Unknown package: ${remotePackageName}`)
      },
      preRun: [
        (mod: any) => {
          // Register /dev/blob device
          // This is used to read and write blobs when used in COPY TO/FROM
          // e.g. COPY mytable TO '/dev/blob' WITH (FORMAT binary)
          // The data is returned by the query as a `blob` property in the results
          const devId = mod.FS.makedev(64, 0)
          const devOpt = {
            open: (_stream: any) => {},
            close: (_stream: any) => {},
            read: (
              _stream: any,
              buffer: Uint8Array,
              offset: number,
              length: number,
              position: number,
            ) => {
              const buf = this.#queryReadBuffer
              if (!buf) {
                throw new Error(
                  'No /dev/blob File or Blob provided to read from',
                )
              }
              const contents = new Uint8Array(buf)
              if (position >= contents.length) return 0
              const size = Math.min(contents.length - position, length)
              for (let i = 0; i < size; i++) {
                buffer[offset + i] = contents[position + i]
              }
              return size
            },
            write: (
              _stream: any,
              buffer: Uint8Array,
              offset: number,
              length: number,
              _position: number,
            ) => {
              this.#queryWriteChunks ??= []
              this.#queryWriteChunks.push(buffer.slice(offset, offset + length))
              return length
            },
            llseek: (stream: any, offset: number, whence: number) => {
              const buf = this.#queryReadBuffer
              if (!buf) {
                throw new Error('No /dev/blob File or Blob provided to llseek')
              }
              let position = offset
              if (whence === 1) {
                position += stream.position
              } else if (whence === 2) {
                position = new Uint8Array(buf).length
              }
              if (position < 0) {
                throw new mod.FS.ErrnoError(28)
              }
              return position
            },
          }
          mod.FS.registerDevice(devId, devOpt)
          mod.FS.mkdev('/dev/blob', devId)
        },
      ],
    }

    const { emscriptenOpts: amendedEmscriptenOpts } = await this.fs!.init(
      this,
      emscriptenOpts,
    )
    emscriptenOpts = amendedEmscriptenOpts

    // # Setup extensions
    // This is the first step of loading PGlite extensions
    // We loop through each extension and call the setup function
    // This amends the emscriptenOpts and can return:
    // - emscriptenOpts: The updated emscripten options
    // - namespaceObj: The namespace object to attach to the PGlite instance
    // - init: A function to initialize the extension/plugin after the database is ready
    // - close: A function to close/tidy-up the extension/plugin when the database is closed
    // - dependencies: List of extension names that must be loaded first
    //
    // When lazyExtensions is enabled, we defer loading the extension bundles
    // until they are explicitly requested or when CREATE EXTENSION is called.
    for (const [extName, ext] of Object.entries(this.#extensions)) {
      // Check extension feature flag - if false, skip this extension
      if (this.#extensionFlags[extName] === false) {
        continue
      }

      if (ext instanceof URL) {
        if (this.#lazyExtensions) {
          // Store URL for lazy loading later
          this.#extensionSetupResults.set(extName, { bundlePath: ext })
        } else {
          // Extension with only a URL to a bundle - load immediately
          extensionBundlePromises[extName] = loadExtensionBundle(ext)
          this.#loadedExtensions.add(extName)
        }
      } else {
        if (this.#lazyExtensions) {
          // In lazy mode, we call setup but don't load bundles yet
          // This allows us to get the bundlePath and dependencies info
          const extRet = await ext.setup(this, emscriptenOpts)
          this.#extensionSetupResults.set(extName, extRet)

          if (extRet.emscriptenOpts) {
            emscriptenOpts = extRet.emscriptenOpts
          }
          if (extRet.namespaceObj) {
            const instance = this as any
            instance[extName] = extRet.namespaceObj
          }
          // Don't load bundle in lazy mode - defer until needed
          if (extRet.close) {
            this.#extensionsClose.push(extRet.close)
          }
        } else {
          // Extension with JS setup function - load immediately
          const extRet = await ext.setup(this, emscriptenOpts)
          this.#extensionSetupResults.set(extName, extRet)

          if (extRet.emscriptenOpts) {
            emscriptenOpts = extRet.emscriptenOpts
          }
          if (extRet.namespaceObj) {
            const instance = this as any
            instance[extName] = extRet.namespaceObj
          }
          if (extRet.bundlePath) {
            extensionBundlePromises[extName] = loadExtensionBundle(
              extRet.bundlePath,
            ) // Don't await here, this is parallel
            this.#loadedExtensions.add(extName)
          }
          if (extRet.init) {
            extensionInitFns.push(extRet.init)
          }
          if (extRet.close) {
            this.#extensionsClose.push(extRet.close)
          }
        }
      }
    }
    emscriptenOpts['pg_extensions'] = extensionBundlePromises

    // Await the fs bundle - we do this just before calling PostgresModFactory
    // as it needs the fs bundle to be ready.
    await fsBundleBufferPromise

    // Load the database engine
    this.mod = await PostgresModFactory(emscriptenOpts)

    // TRAMPOLINE MODE: Set up callbacks via Module._pgliteCallbacks
    // This approach uses EM_JS embedded in the C code to call these callbacks
    // without requiring addFunction (which needs runtime WASM compilation)
    // This makes PGlite compatible with Cloudflare Workers
    ;(this.mod as any)._pgliteCallbacks = {
      // Write callback - called when PostgreSQL sends output data
      write: (ptr: number, length: number) => {
        let bytes
        try {
          bytes = this.mod!.HEAPU8.subarray(ptr, ptr + length)
        } catch (e: any) {
          console.error('error', e)
          throw e
        }
        this.#protocolParser.parse(bytes, (msg) => {
          this.#parse(msg)
        })
        if (this.#keepRawResponse) {
          const copied = bytes.slice()

          let requiredSize = this.#writeOffset + copied.length

          if (requiredSize > this.#inputData.length) {
            const newSize =
              this.#inputData.length +
              (this.#inputData.length >> 1) +
              requiredSize
            if (requiredSize > PGlite.MAX_BUFFER_SIZE) {
              requiredSize = PGlite.MAX_BUFFER_SIZE
            }
            const newBuffer = new Uint8Array(newSize)
            newBuffer.set(this.#inputData.subarray(0, this.#writeOffset))
            this.#inputData = newBuffer
          }

          this.#inputData.set(copied, this.#writeOffset)
          this.#writeOffset += copied.length

          return this.#inputData.length
        }
        return length
      },

      // Read callback - called when PostgreSQL needs input data
      read: (ptr: number, max_length: number) => {
        // copy current data to wasm buffer
        let length = this.#outputData.length - this.#readOffset
        if (length > max_length) {
          length = max_length
        }
        try {
          this.mod!.HEAP8.set(
            (this.#outputData as Uint8Array).subarray(
              this.#readOffset,
              this.#readOffset + length,
            ),
            ptr,
          )
          this.#readOffset += length
        } catch (e) {
          console.log(e)
        }
        return length
      },
    }

    // Note: _set_read_write_cbs is now a no-op in trampoline mode
    // The callbacks above are called directly via EM_JS trampolines in the C code

    // Sync the filesystem from any previous store
    await this.fs!.initialSyncFs()

    // If the user has provided a tarball to load the database from, do that now.
    // We do this after the initial sync so that we can throw if the database
    // already exists.
    if (options.loadDataDir) {
      if (this.mod.FS.analyzePath(PGDATA + '/PG_VERSION').exists) {
        throw new Error('Database already exists, cannot load from tarball')
      }
      this.#log('pglite: loading data from tarball')
      await loadTar(this.mod.FS, options.loadDataDir, PGDATA)
    }

    // Check and log if the database exists
    if (this.mod.FS.analyzePath(PGDATA + '/PG_VERSION').exists) {
      this.#log('pglite: found DB, resuming')
    } else {
      this.#log('pglite: no db')
    }

    // Start compiling dynamic extensions present in FS.
    await loadExtensions(this.mod, (...args) => this.#log(...args))

    // Initialize the database
    const idb = this.mod._pgl_initdb()

    if (!idb) {
      // This would be a sab worker crash before pg_initdb can be called
      throw new Error('INITDB failed to return value')
    }

    // initdb states:
    // - populating pgdata
    // - reconnect a previous db
    // - found valid db+user
    // currently unhandled:
    // - db does not exist
    // - user is invalid for db

    if (idb & 0b0001) {
      // this would be a wasm crash inside pg_initdb from a sab worker.
      throw new Error('INITDB: failed to execute')
    } else if (idb & 0b0010) {
      // initdb was called to init PGDATA if required
      const pguser = options.username ?? 'postgres'
      const pgdatabase = options.database ?? 'template1'
      if (idb & 0b0100) {
        // initdb has found a previous database
        if (idb & (0b0100 | 0b1000)) {
          // initdb found db+user, and we switched to that user
        } else {
          // TODO: invalid user for db?
          throw new Error(
            `INITDB: Invalid db ${pgdatabase}/user ${pguser} combination`,
          )
        }
      } else {
        // initdb has created a new database for us, we can only continue if we are
        // in template1 and the user is postgres
        if (pgdatabase !== 'template1' && pguser !== 'postgres') {
          // throw new Error(`Invalid database ${pgdatabase} requested`);
          throw new Error(
            `INITDB: created a new datadir ${PGDATA}, but an alternative db ${pgdatabase}/user ${pguser} was requested`,
          )
        }
      }
    }

    // (re)start backed after possible initdb boot/single.
    this.mod._pgl_backend()

    // Sync any changes back to the persisted store (if there is one)
    // TODO: only sync here if initdb did init db.
    await this.syncToFs()

    this.#ready = true

    // Initialize peak heap size tracking
    this.#peakHeapSize = this.mod!.HEAPU8.buffer.byteLength

    // Set the search path to public for this connection
    await this.exec('SET search_path TO public;')

    // Init array types
    await this._initArrayTypes()

    // Init extensions
    for (const initFn of extensionInitFns) {
      await initFn()
    }
  }

  /**
   * Initialize from a pre-captured memory snapshot for fast cold starts.
   * This method bypasses the expensive initdb phase by restoring WASM memory state.
   *
   * SECURITY: RNG is automatically reseeded after restore to prevent
   * deterministic random sequences across instances.
   *
   * @param options PGlite options including the memory snapshot
   */
  async #initFromSnapshot(options: PGliteOptions) {
    const snapshot = options.memorySnapshot!

    // Validate snapshot version
    if (snapshot.version !== '1.0') {
      throw new Error(
        `Unsupported snapshot version: ${snapshot.version}. Expected: 1.0`,
      )
    }

    this.#log('pglite: initializing from memory snapshot')

    // Set up filesystem (still needed for runtime operations)
    if (options.fs) {
      this.fs = options.fs
    } else {
      const { dataDir, fsType } = parseDataDir(options.dataDir)
      this.fs = await loadFs(dataDir, fsType)
    }

    const args = [
      `PGDATA=${PGDATA}`,
      `PREFIX=${WASM_PREFIX}`,
      `PGUSER=${options.username ?? 'postgres'}`,
      `PGDATABASE=${options.database ?? 'template1'}`,
      'MODE=REACT',
      'REPL=N',
      ...(this.debug ? ['-d', this.debug.toString()] : []),
    ]

    // Get the fs bundle - required for module initialization
    const fsBundleBufferPromise = options.fsBundle
      ? options.fsBundle.arrayBuffer()
      : getFsBundle()
    let fsBundleBuffer: ArrayBuffer
    fsBundleBufferPromise.then((buffer) => {
      fsBundleBuffer = buffer
    })

    let emscriptenOpts: Partial<PostgresMod> = {
      WASM_PREFIX,
      arguments: args,
      INITIAL_MEMORY: options.initialMemory ?? snapshot.heapSize,
      noExitRuntime: true,
      ...(this.debug > 0
        ? { print: console.info, printErr: console.error }
        : { print: () => {}, printErr: () => {} }),
      instantiateWasm: (imports, successCallback) => {
        instantiateWasm(imports, options.wasmModule).then(
          ({ instance, module }) => {
            // @ts-ignore wrong type in Emscripten typings
            successCallback(instance, module)
          },
        )
        return {}
      },
      getPreloadedPackage: (remotePackageName, remotePackageSize) => {
        if (remotePackageName === 'pglite.data') {
          if (fsBundleBuffer.byteLength !== remotePackageSize) {
            throw new Error(
              `Invalid FS bundle size: ${fsBundleBuffer.byteLength} !== ${remotePackageSize}`,
            )
          }
          return fsBundleBuffer
        }
        throw new Error(`Unknown package: ${remotePackageName}`)
      },
      preRun: [
        (mod: any) => {
          // Register /dev/blob device (same as normal init)
          const devId = mod.FS.makedev(64, 0)
          const devOpt = {
            open: (_stream: any) => {},
            close: (_stream: any) => {},
            read: (
              _stream: any,
              buffer: Uint8Array,
              offset: number,
              length: number,
              position: number,
            ) => {
              const buf = this.#queryReadBuffer
              if (!buf) {
                throw new Error(
                  'No /dev/blob File or Blob provided to read from',
                )
              }
              const contents = new Uint8Array(buf)
              if (position >= contents.length) return 0
              const size = Math.min(contents.length - position, length)
              for (let i = 0; i < size; i++) {
                buffer[offset + i] = contents[position + i]
              }
              return size
            },
            write: (
              _stream: any,
              buffer: Uint8Array,
              offset: number,
              length: number,
              _position: number,
            ) => {
              this.#queryWriteChunks ??= []
              this.#queryWriteChunks.push(buffer.slice(offset, offset + length))
              return length
            },
            llseek: (stream: any, offset: number, whence: number) => {
              const buf = this.#queryReadBuffer
              if (!buf) {
                throw new Error('No /dev/blob File or Blob provided to llseek')
              }
              let position = offset
              if (whence === 1) {
                position += stream.position
              } else if (whence === 2) {
                position = new Uint8Array(buf).length
              }
              if (position < 0) {
                throw new mod.FS.ErrnoError(28)
              }
              return position
            },
          }
          mod.FS.registerDevice(devId, devOpt)
          mod.FS.mkdev('/dev/blob', devId)
        },
      ],
    }

    const { emscriptenOpts: amendedEmscriptenOpts } = await this.fs!.init(
      this,
      emscriptenOpts,
    )
    emscriptenOpts = amendedEmscriptenOpts

    // Await the fs bundle before creating the module
    await fsBundleBufferPromise

    // Create the Emscripten module
    this.mod = await PostgresModFactory(emscriptenOpts)

    // Restore WASM memory from snapshot
    this.#log('pglite: restoring memory snapshot')
    const snapshotData = new Uint8Array(snapshot.heap)

    // Validate memory size compatibility
    if (snapshotData.length > this.mod.HEAPU8.buffer.byteLength) {
      throw new Error(
        `Snapshot heap size (${snapshotData.length}) exceeds current memory allocation (${this.mod.HEAPU8.buffer.byteLength}). ` +
          `Try increasing initialMemory option.`,
      )
    }

    // Copy snapshot data to WASM memory
    this.mod.HEAPU8.set(snapshotData)

    // Re-register callbacks (CRITICAL - callbacks are JS, not in snapshot)
    this.#log('pglite: re-registering callbacks after snapshot restore')
    ;(this.mod as any)._pgliteCallbacks = {
      // Write callback - called when PostgreSQL sends output data
      write: (ptr: number, length: number) => {
        let bytes
        try {
          bytes = this.mod!.HEAPU8.subarray(ptr, ptr + length)
        } catch (e: any) {
          console.error('error', e)
          throw e
        }
        this.#protocolParser.parse(bytes, (msg) => {
          this.#parse(msg)
        })
        if (this.#keepRawResponse) {
          const copied = bytes.slice()

          let requiredSize = this.#writeOffset + copied.length

          if (requiredSize > this.#inputData.length) {
            const newSize =
              this.#inputData.length +
              (this.#inputData.length >> 1) +
              requiredSize
            if (requiredSize > PGlite.MAX_BUFFER_SIZE) {
              requiredSize = PGlite.MAX_BUFFER_SIZE
            }
            const newBuffer = new Uint8Array(newSize)
            newBuffer.set(this.#inputData.subarray(0, this.#writeOffset))
            this.#inputData = newBuffer
          }

          this.#inputData.set(copied, this.#writeOffset)
          this.#writeOffset += copied.length

          return this.#inputData.length
        }
        return length
      },

      // Read callback - called when PostgreSQL needs input data
      read: (ptr: number, max_length: number) => {
        let length = this.#outputData.length - this.#readOffset
        if (length > max_length) {
          length = max_length
        }
        try {
          this.mod!.HEAP8.set(
            (this.#outputData as Uint8Array).subarray(
              this.#readOffset,
              this.#readOffset + length,
            ),
            ptr,
          )
          this.#readOffset += length
        } catch (e) {
          console.log(e)
        }
        return length
      },
    }

    // Reseed RNG (CRITICAL for security - prevents deterministic random sequences)
    this.#log('pglite: reseeding RNG after snapshot restore')
    this.#reseedRandom()

    // Reset protocol parser state (fresh instance for clean communication)
    this.#protocolParser = new ProtocolParser()

    // Sync the filesystem
    await this.fs!.initialSyncFs()

    // Restart the backend (required after memory restore)
    this.#log('pglite: restarting backend after snapshot restore')
    this.mod._pgl_backend()

    // Sync changes to filesystem
    await this.syncToFs()

    this.#ready = true

    // Initialize peak heap size tracking
    this.#peakHeapSize = this.mod!.HEAPU8.buffer.byteLength

    // Set the search path to public
    await this.exec('SET search_path TO public;')

    // Init array types
    await this._initArrayTypes()

    this.#log('pglite: snapshot restore complete')
  }

  /**
   * Reseed PostgreSQL's random number generator with fresh entropy.
   * Called after snapshot restore to ensure unique random sequences.
   */
  #reseedRandom() {
    // Generate cryptographically secure random seed
    // Use crypto.getRandomValues if available, otherwise fall back to Date.now()
    let seedHigh: number
    let seedLow: number

    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const seedArray = new Uint32Array(2)
      crypto.getRandomValues(seedArray)
      seedHigh = seedArray[0]
      seedLow = seedArray[1]
    } else {
      // Fallback for environments without crypto
      const now = Date.now()
      seedHigh = (now / 0x100000000) >>> 0
      seedLow = now >>> 0
    }

    // Call the C function to reseed PostgreSQL's RNG
    // This function must be exported from the WASM build
    if (typeof this.mod!._pgl_reseed_random === 'function') {
      this.mod!._pgl_reseed_random(seedHigh, seedLow)
    } else {
      // Log warning if RNG reseeding is not available
      // This is a security concern but shouldn't block operation
      console.warn(
        'pglite: _pgl_reseed_random not available - RNG state may be deterministic after snapshot restore',
      )
    }
  }

  /**
   * Capture a memory snapshot of the current PGlite state.
   * This can be used for fast cold starts by skipping initdb.
   *
   * IMPORTANT: Only capture snapshots from a freshly initialized instance
   * without user data. Snapshots should be created at build time.
   *
   * @returns A MemorySnapshot that can be used to restore the state
   */
  async captureSnapshot(): Promise<MemorySnapshot> {
    await this._checkReady()

    this.#log('pglite: capturing memory snapshot')

    // Sync any pending changes to ensure consistent state
    await this.syncToFs()

    // Capture the entire WASM heap
    // Note: We use slice() to create a copy, as the underlying buffer may change
    const heapView = this.mod!.HEAPU8
    const heap = heapView.buffer.slice(0) as ArrayBuffer

    const snapshot: MemorySnapshot = {
      version: '1.0',
      heapSize: heap.byteLength,
      heap,
      capturedAt: Date.now(),
      extensions: Object.keys(this.#extensions),
    }

    this.#log(
      `pglite: snapshot captured (${(heap.byteLength / 1024 / 1024).toFixed(2)} MB)`,
    )

    return snapshot
  }

  /**
   * The Postgres Emscripten Module
   */
  get Module() {
    return this.mod!
  }

  /**
   * The ready state of the database
   */
  get ready() {
    return this.#ready && !this.#closing && !this.#closed
  }

  /**
   * The closed state of the database
   */
  get closed() {
    return this.#closed
  }

  /**
   * Get memory statistics for monitoring WASM heap usage.
   * Useful for tracking memory consumption in constrained environments
   * like Cloudflare Workers (128MB limit).
   *
   * @returns Memory statistics including heap size and PostgreSQL settings
   */
  async getMemoryStats(): Promise<MemoryStats> {
    await this._checkReady()

    // Get current heap size from WASM module
    const currentHeapSize = this.mod!.HEAPU8.buffer.byteLength

    // Update peak heap size if current is larger
    if (currentHeapSize > this.#peakHeapSize) {
      this.#peakHeapSize = currentHeapSize
    }

    // Query PostgreSQL for memory settings
    const result = await this.query<{ name: string; setting: string }>(`
      SELECT name, setting
      FROM pg_settings
      WHERE name IN (
        'shared_buffers',
        'work_mem',
        'temp_buffers',
        'wal_buffers',
        'maintenance_work_mem'
      )
    `)

    // Build settings object from query results
    const settingsMap = new Map<string, string>()
    for (const row of result.rows) {
      settingsMap.set(row.name, row.setting)
    }

    // Format settings with units (PostgreSQL returns values in various units)
    // shared_buffers, temp_buffers, wal_buffers are in 8kB blocks
    // work_mem, maintenance_work_mem are in kB
    const formatMemorySetting = (
      name: string,
      unit: 'blocks' | 'kb',
    ): string => {
      const value = settingsMap.get(name)
      if (!value) return 'unknown'
      const numValue = parseInt(value, 10)
      if (isNaN(numValue)) return value
      if (unit === 'blocks') {
        // 8kB blocks
        const kb = numValue * 8
        return kb >= 1024 ? `${kb / 1024}MB` : `${kb}kB`
      } else {
        // Already in kB
        return numValue >= 1024 ? `${numValue / 1024}MB` : `${numValue}kB`
      }
    }

    return {
      heapSize: currentHeapSize,
      peakHeapSize: this.#peakHeapSize,
      postgresSettings: {
        sharedBuffers: formatMemorySetting('shared_buffers', 'blocks'),
        workMem: formatMemorySetting('work_mem', 'kb'),
        tempBuffers: formatMemorySetting('temp_buffers', 'blocks'),
        walBuffers: formatMemorySetting('wal_buffers', 'blocks'),
        maintenanceWorkMem: formatMemorySetting('maintenance_work_mem', 'kb'),
      },
    }
  }

  /**
   * Load a single extension on demand.
   *
   * This method enables lazy loading of PostgreSQL extensions, deferring the
   * memory cost of extension bundles until they are actually needed. This is
   * particularly valuable in memory-constrained environments like Cloudflare
   * Workers (128MB limit).
   *
   * **Performance Characteristics:**
   * - First call: Resolves dependencies, fetches bundle, compiles WASM (~100-500ms)
   * - Subsequent calls: Returns immediately (no-op)
   * - Memory: Bundle size + ~10-50% overhead for compiled code
   *
   * **Thread Safety:**
   * This method is protected by a mutex to prevent race conditions when
   * multiple concurrent calls attempt to load the same extension.
   *
   * @param extName The name of the extension to load (must match key in extensions option)
   * @throws Error if extension is not configured, disabled by feature flag, or loading fails
   *
   * @example
   * ```typescript
   * const pg = await PGlite.create({
   *   extensions: { vector: vectorExtension },
   *   lazyExtensions: true,
   * });
   *
   * // Extension not loaded yet - minimal memory footprint
   * await pg.loadExtension('vector');
   * // Now vector extension is available for use
   *
   * await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;');
   * ```
   */
  async loadExtension(extName: string): Promise<void> {
    await this._checkReady()

    // Fast path: already loaded (check before mutex for performance)
    if (this.#loadedExtensions.has(extName)) {
      return
    }

    // Use mutex to prevent concurrent loading of the same extension
    return this.#extensionLoadMutex.runExclusive(async () => {
      // Double-check after acquiring mutex (another call may have loaded it)
      if (this.#loadedExtensions.has(extName)) {
        return
      }

      // Validate extension configuration
      const ext = this.#extensions[extName]
      if (!ext) {
        throw new Error(`Extension '${extName}' is not configured. Add it to the extensions option when creating PGlite.`)
      }

      if (this.#extensionFlags[extName] === false) {
        throw new Error(`Extension '${extName}' is disabled by feature flag.`)
      }

      // Get or create setup result (lazy setup for URL-only extensions)
      const setupResult = await this.#getOrCreateSetupResult(extName, ext)

      // Build dependency graph and load in topological order
      if (setupResult.dependencies && setupResult.dependencies.length > 0) {
        await this.#loadExtensionDependencies(extName, setupResult.dependencies, new Set([extName]))
      }

      // Load the extension bundle
      await this.#loadExtensionBundle(extName, setupResult)
    })
  }

  /**
   * Get or create setup result for an extension.
   * Caches results to avoid redundant setup calls.
   */
  async #getOrCreateSetupResult(extName: string, ext: Extension | URL): Promise<ExtensionSetupResult> {
    let setupResult = this.#extensionSetupResults.get(extName)
    if (setupResult) {
      return setupResult
    }

    if (ext instanceof URL) {
      setupResult = { bundlePath: ext }
    } else {
      setupResult = await ext.setup(this, {})
    }
    this.#extensionSetupResults.set(extName, setupResult)
    return setupResult
  }

  /**
   * Load extension dependencies using depth-first traversal with cycle detection.
   *
   * This method performs a post-order traversal of the dependency graph, ensuring
   * dependencies are loaded before their dependents. The algorithm:
   * 1. Maintains a "loading chain" to detect circular dependencies
   * 2. Skips already-loaded extensions for efficiency
   * 3. Recursively resolves transitive dependencies
   *
   * **Complexity:** O(V + E) where V = extensions, E = dependency edges
   *
   * @param extName The extension that has dependencies (for error messages)
   * @param dependencies List of direct dependency extension names
   * @param loadingChain Set tracking the current DFS path (for cycle detection)
   * @throws Error if circular dependency detected or dependency not configured
   */
  async #loadExtensionDependencies(
    extName: string,
    dependencies: string[],
    loadingChain: Set<string>,
  ): Promise<void> {
    for (const depName of dependencies) {
      // Cycle detection: check if we're already loading this extension
      if (loadingChain.has(depName)) {
        const chain = Array.from(loadingChain).join(' -> ')
        throw new Error(`Circular dependency detected: ${chain} -> ${depName}`)
      }

      // Skip already-loaded extensions (idempotent loading)
      if (this.#loadedExtensions.has(depName)) {
        continue
      }

      // Validate dependency is configured
      const depExt = this.#extensions[depName]
      if (!depExt) {
        throw new Error(`Extension '${extName}' requires dependency '${depName}' which is not configured.`)
      }

      // Get or create setup result for dependency
      const depSetupResult = await this.#getOrCreateSetupResult(depName, depExt)

      // Recursively resolve transitive dependencies (post-order traversal)
      if (depSetupResult.dependencies && depSetupResult.dependencies.length > 0) {
        const newChain = new Set(loadingChain)
        newChain.add(depName)
        await this.#loadExtensionDependencies(depName, depSetupResult.dependencies, newChain)
      }

      // Load the dependency bundle (dependencies of this dep are already loaded)
      await this.#loadExtensionBundle(depName, depSetupResult)
    }
  }

  /**
   * Load an extension bundle into the WASM module and mark it as loaded.
   *
   * This method handles the actual loading of extension bundles:
   * 1. Fetches and decompresses the bundle (if bundlePath provided)
   * 2. Loads the extension files into the Emscripten filesystem
   * 3. Runs the extension's init function (if provided)
   * 4. Tracks memory usage for monitoring
   *
   * **Memory Management:**
   * - Bundle blob is released after loading into FS
   * - Heap increase is tracked for memory monitoring
   * - Peak heap size is updated if needed
   *
   * @param extName The extension name (used for error messages and tracking)
   * @param setupResult The setup result containing bundlePath and/or init function
   * @throws Error if bundle fetch fails or init function throws
   */
  async #loadExtensionBundle(extName: string, setupResult: ExtensionSetupResult): Promise<void> {
    // Idempotent: skip if already loaded
    if (this.#loadedExtensions.has(extName)) {
      return
    }

    // Capture heap size before loading for memory tracking
    const heapBefore = this.mod!.HEAPU8.buffer.byteLength

    try {
      if (setupResult.bundlePath) {
        this.#log(`pglite: loading extension bundle for '${extName}'`)

        const blob = await loadExtensionBundle(setupResult.bundlePath)
        if (blob) {
          // Track bundle size for memory monitoring
          this.#extensionBundleSizes.set(extName, blob.size)

          // Load the extension bundle into the Emscripten filesystem
          // Using a single-entry map to match the eager loading pattern
          const extensionBundlePromises: Record<string, Promise<Blob | null>> = {
            [extName]: Promise.resolve(blob)
          }
          ;(this.mod as any)['pg_extensions'] = extensionBundlePromises

          // Compile and load extension files
          await loadExtensions(this.mod!, (...args) => this.#log(...args))

          // Clear reference to help GC (blob is now in Emscripten FS)
          ;(this.mod as any)['pg_extensions'] = {}
        }
      }

      // Run extension-specific initialization
      if (setupResult.init) {
        await setupResult.init()
      }

      // Mark as successfully loaded
      this.#loadedExtensions.add(extName)

      // Track memory impact
      const heapAfter = this.mod!.HEAPU8.buffer.byteLength
      if (heapAfter > heapBefore) {
        this.#extensionHeapIncrease.set(extName, heapAfter - heapBefore)
        // Update peak heap size if this is a new maximum
        if (heapAfter > this.#peakHeapSize) {
          this.#peakHeapSize = heapAfter
        }
      }

      this.#log(`pglite: extension '${extName}' loaded successfully`)

      // Notify registered listeners asynchronously
      this.#notifyExtensionLoaded(extName)
    } catch (error) {
      // Wrap error with extension context for better debugging
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to load extension '${extName}': ${message}`)
    }
  }

  /**
   * Load multiple extensions concurrently.
   *
   * This method loads multiple extensions in parallel where possible, while
   * respecting dependency ordering. Each extension's loadExtension call is
   * protected by a mutex, so dependencies are resolved correctly even with
   * concurrent calls.
   *
   * **Performance Note:**
   * For extensions with shared dependencies, this is more efficient than
   * sequential loading because the dependency is only loaded once (the
   * loadExtension mutex ensures idempotent loading).
   *
   * @param extNames Array of extension names to load
   *
   * @example
   * ```typescript
   * // Load vector and pgcrypto concurrently
   * await pg.loadExtensions(['vector', 'pgcrypto']);
   * ```
   */
  async loadExtensions(extNames: string[]): Promise<void> {
    await this._checkReady()

    // Load extensions concurrently - mutex inside loadExtension ensures
    // thread-safe loading and deduplication
    await Promise.all(extNames.map((name) => this.loadExtension(name)))
  }

  /**
   * Get the load status of all configured extensions.
   *
   * This method returns information about which extensions are configured
   * and whether they have been loaded into memory. Useful for:
   * - Debugging extension availability
   * - Monitoring lazy loading progress
   * - Building UI that shows extension status
   *
   * **Note:** Extensions disabled by feature flags are excluded from the result.
   *
   * @returns Object mapping extension names to their status (configured/loaded)
   *
   * @example
   * ```typescript
   * const status = await pg.getExtensionStatus();
   * // { vector: { configured: true, loaded: false },
   * //   pgcrypto: { configured: true, loaded: true } }
   *
   * const unloaded = Object.entries(status)
   *   .filter(([_, s]) => !s.loaded)
   *   .map(([name]) => name);
   * ```
   */
  async getExtensionStatus(): Promise<Record<string, ExtensionStatus>> {
    await this._checkReady()

    const status: Record<string, ExtensionStatus> = {}

    for (const extName of Object.keys(this.#extensions)) {
      // Exclude extensions disabled by feature flag
      if (this.#extensionFlags[extName] === false) {
        continue
      }

      status[extName] = {
        configured: true,
        loaded: this.#loadedExtensions.has(extName),
      }
    }

    return status
  }

  /**
   * Check if an extension is available for use.
   *
   * An extension is available if it:
   * 1. Is configured in the extensions option
   * 2. Is not disabled by a feature flag
   *
   * This does NOT check if the extension is loaded - use `getExtensionStatus()`
   * to check load state.
   *
   * **Use Case:** Check availability before attempting to use extension features,
   * enabling graceful degradation when extensions are not configured.
   *
   * @param extName The extension name to check
   * @returns true if the extension can be loaded and used
   *
   * @example
   * ```typescript
   * if (await pg.isExtensionAvailable('vector')) {
   *   await pg.loadExtension('vector');
   *   await pg.exec('CREATE EXTENSION vector;');
   * } else {
   *   console.log('Vector search not available');
   * }
   * ```
   */
  async isExtensionAvailable(extName: string): Promise<boolean> {
    await this._checkReady()

    // Check configuration and feature flag
    return this.#extensions[extName] !== undefined &&
           this.#extensionFlags[extName] !== false
  }

  /**
   * Get memory statistics for each configured extension.
   *
   * Returns detailed memory information for monitoring and optimization:
   * - **bundleSize**: Compressed bundle size in bytes (0 if not loaded)
   * - **loaded**: Whether the extension is currently in memory
   * - **heapIncrease**: WASM heap growth when extension was loaded (if measurable)
   *
   * **Memory Monitoring Use Cases:**
   * - Track which extensions consume the most memory
   * - Monitor total extension memory in constrained environments
   * - Identify candidates for lazy loading optimization
   *
   * **Note:** heapIncrease may not always be available if the heap didn't grow
   * during loading (e.g., if sufficient memory was already allocated).
   *
   * @returns Object mapping extension names to their memory statistics
   *
   * @example
   * ```typescript
   * const memStats = await pg.getExtensionMemoryStats();
   * const totalBundleSize = Object.values(memStats)
   *   .reduce((sum, s) => sum + s.bundleSize, 0);
   * console.log(`Total extension bundles: ${(totalBundleSize / 1024).toFixed(1)} KB`);
   * ```
   */
  async getExtensionMemoryStats(): Promise<Record<string, ExtensionMemoryStats>> {
    await this._checkReady()

    const stats: Record<string, ExtensionMemoryStats> = {}

    for (const extName of Object.keys(this.#extensions)) {
      // Exclude extensions disabled by feature flag
      if (this.#extensionFlags[extName] === false) {
        continue
      }

      const loaded = this.#loadedExtensions.has(extName)
      const bundleSize = this.#extensionBundleSizes.get(extName) ?? 0
      const heapIncrease = this.#extensionHeapIncrease.get(extName)

      stats[extName] = {
        bundleSize,
        loaded,
        ...(heapIncrease !== undefined ? { heapIncrease } : {}),
      }
    }

    return stats
  }

  /**
   * Register a callback to be notified when an extension is loaded.
   *
   * Callbacks are invoked asynchronously (via queueMicrotask) after each
   * extension finishes loading. This allows you to:
   * - Track loading progress in real-time
   * - Update UI when extensions become available
   * - Log extension loading for debugging
   *
   * **Thread Safety:** Callbacks are invoked after the loading mutex is released,
   * so it's safe to call other PGlite methods from within the callback.
   *
   * @param callback Function called with extension name when loading completes
   * @returns Unsubscribe function to remove the listener
   *
   * @example
   * ```typescript
   * const unsubscribe = pg.onExtensionLoad((extName) => {
   *   console.log(`Extension ${extName} is now available`);
   * });
   *
   * await pg.loadExtension('vector');
   * // Logs: "Extension vector is now available"
   *
   * unsubscribe(); // Stop listening
   * ```
   */
  onExtensionLoad(callback: (extName: string) => void): () => void {
    this.#extensionLoadListeners.add(callback)
    return () => {
      this.#extensionLoadListeners.delete(callback)
    }
  }

  /**
   * Notify all registered listeners that an extension was loaded.
   * Uses queueMicrotask for async notification without blocking.
   */
  #notifyExtensionLoaded(extName: string): void {
    for (const listener of this.#extensionLoadListeners) {
      queueMicrotask(() => listener(extName))
    }
  }

  /**
   * Internal log function
   */
  #log(...args: any[]) {
    if (this.debug > 0) {
      console.log(...args)
    }
  }

  /**
   * Close the database
   * @returns A promise that resolves when the database is closed
   */
  async close() {
    await this._checkReady()
    this.#closing = true

    // Close all extensions
    for (const closeFn of this.#extensionsClose) {
      await closeFn()
    }

    // Close the database
    try {
      await this.execProtocol(serialize.end())
      this.mod!._pgl_shutdown()
      // TRAMPOLINE MODE: Clean up callbacks by setting to null
      // No removeFunction needed since we didn't use addFunction
      ;(this.mod as any)._pgliteCallbacks = null
    } catch (e) {
      const err = e as { name: string; status: number }
      if (err.name === 'ExitStatus' && err.status === 0) {
        // Database closed successfully
        // An earlier build of PGlite would throw an error here when closing
        // leaving this here for now. I believe it was a bug in Emscripten.
      } else {
        throw e
      }
    }

    // Close the filesystem
    await this.fs!.closeFs()

    this.#closed = true
    this.#closing = false
  }

  /**
   * Close the database when the object exits scope
   * Stage 3 ECMAScript Explicit Resource Management
   * https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html#using-declarations-and-explicit-resource-management
   */
  async [Symbol.asyncDispose]() {
    await this.close()
  }

  /**
   * Handle a file attached to the current query
   * @param file The file to handle
   */
  async _handleBlob(blob?: File | Blob) {
    this.#queryReadBuffer = blob ? await blob.arrayBuffer() : undefined
  }

  /**
   * Cleanup the current file
   */
  async _cleanupBlob() {
    this.#queryReadBuffer = undefined
  }

  /**
   * Get the written blob from the current query
   * @returns The written blob
   */
  async _getWrittenBlob(): Promise<Blob | undefined> {
    if (!this.#queryWriteChunks) {
      return undefined
    }
    const blob = new Blob(this.#queryWriteChunks.map((chunk) => chunk.buffer as ArrayBuffer))
    this.#queryWriteChunks = undefined
    return blob
  }

  /**
   * Wait for the database to be ready
   */
  async _checkReady() {
    if (this.#closing) {
      throw new Error('PGlite is closing')
    }
    if (this.#closed) {
      throw new Error('PGlite is closed')
    }
    if (!this.#ready) {
      // Starting the database can take a while and it might not be ready yet
      // We'll wait for it to be ready before continuing
      await this.waitReady
    }
  }

  /**
   * Execute a postgres wire protocol synchronously
   * @param message The postgres wire protocol message to execute
   * @returns The direct message data response produced by Postgres
   */
  execProtocolRawSync(message: Uint8Array) {
    const mod = this.mod!

    this.#readOffset = 0
    this.#writeOffset = 0
    this.#outputData = message

    if (
      this.#keepRawResponse &&
      this.#inputData.length !== PGlite.DEFAULT_RECV_BUF_SIZE
    ) {
      // the previous call might have increased the size of the buffer so reset it to its default
      this.#inputData = new Uint8Array(PGlite.DEFAULT_RECV_BUF_SIZE)
    }

    // execute the message
    mod._interactive_one(message.length, message[0])

    this.#outputData = []

    if (this.#keepRawResponse && this.#writeOffset)
      return this.#inputData.subarray(0, this.#writeOffset)
    return new Uint8Array(0)
  }

  /**
   * Execute a postgres wire protocol message directly without wrapping the response.
   * Only use if `execProtocol()` doesn't suite your needs.
   *
   * **Warning:** This bypasses PGlite's protocol wrappers that manage error/notice messages,
   * transactions, and notification listeners. Only use if you need to bypass these wrappers and
   * don't intend to use the above features.
   *
   * @param message The postgres wire protocol message to execute
   * @returns The direct message data response produced by Postgres
   */
  async execProtocolRaw(
    message: Uint8Array,
    { syncToFs = true }: ExecProtocolOptions = {},
  ) {
    const data = this.execProtocolRawSync(message)
    if (syncToFs) {
      await this.syncToFs()
    }
    return data
  }

  /**
   * Execute a postgres wire protocol message
   * @param message The postgres wire protocol message to execute
   * @returns The result of the query
   */
  async execProtocol(
    message: Uint8Array,
    {
      syncToFs = true,
      throwOnError = true,
      onNotice,
    }: ExecProtocolOptions = {},
  ): Promise<ExecProtocolResult> {
    this.#currentThrowOnError = throwOnError
    this.#currentOnNotice = onNotice
    this.#currentResults = []
    this.#currentDatabaseError = null

    const data = await this.execProtocolRaw(message, { syncToFs })

    const databaseError = this.#currentDatabaseError
    this.#currentThrowOnError = false
    this.#currentOnNotice = undefined
    this.#currentDatabaseError = null
    const result = { messages: this.#currentResults, data }
    this.#currentResults = []

    if (throwOnError && databaseError) {
      this.#protocolParser = new ProtocolParser() // Reset the parser
      throw databaseError
    }

    return result
  }

  /**
   * Execute a postgres wire protocol message
   * @param message The postgres wire protocol message to execute
   * @returns The parsed results of the query
   */
  async execProtocolStream(
    message: Uint8Array,
    { syncToFs, throwOnError = true, onNotice }: ExecProtocolOptions = {},
  ): Promise<BackendMessage[]> {
    this.#currentThrowOnError = throwOnError
    this.#currentOnNotice = onNotice
    this.#currentResults = []
    this.#currentDatabaseError = null

    this.#keepRawResponse = false

    await this.execProtocolRaw(message, { syncToFs })

    this.#keepRawResponse = true

    const databaseError = this.#currentDatabaseError
    this.#currentThrowOnError = false
    this.#currentOnNotice = undefined
    this.#currentDatabaseError = null
    const result = this.#currentResults
    this.#currentResults = []

    if (throwOnError && databaseError) {
      this.#protocolParser = new ProtocolParser() // Reset the parser
      throw databaseError
    }

    return result
  }

  #parse(msg: BackendMessage) {
    // keep the existing logic of throwing the first db exception
    // as soon as there is a db error, we're not interested in the remaining data
    // but since the parser is plugged into the pglite_write callback, we can't just throw
    // and need to ack the messages received from the db
    if (!this.#currentDatabaseError) {
      if (msg instanceof DatabaseError) {
        if (this.#currentThrowOnError) {
          this.#currentDatabaseError = msg
        }
        // TODO: Do we want to wrap the error in a custom error?
      } else if (msg instanceof NoticeMessage) {
        if (this.debug > 0) {
          // Notice messages are warnings, we should log them
          console.warn(msg)
        }
        if (this.#currentOnNotice) {
          this.#currentOnNotice(msg)
        }
      } else if (msg instanceof CommandCompleteMessage) {
        // Keep track of the transaction state
        switch (msg.text) {
          case 'BEGIN':
            this.#inTransaction = true
            break
          case 'COMMIT':
          case 'ROLLBACK':
            this.#inTransaction = false
            break
        }
      } else if (msg instanceof NotificationResponseMessage) {
        // We've received a notification, call the listeners
        const listeners = this.#notifyListeners.get(msg.channel)
        if (listeners) {
          listeners.forEach((cb) => {
            // We use queueMicrotask so that the callback is called after any
            // synchronous code has finished running.
            queueMicrotask(() => cb(msg.payload))
          })
        }
        this.#globalNotifyListeners.forEach((cb) => {
          queueMicrotask(() => cb(msg.channel, msg.payload))
        })
      }
      this.#currentResults.push(msg)
    }
  }

  /**
   * Check if the database is in a transaction
   * @returns True if the database is in a transaction, false otherwise
   */
  isInTransaction() {
    return this.#inTransaction
  }

  /**
   * Perform any sync operations implemented by the filesystem, this is
   * run after every query to ensure that the filesystem is synced.
   */
  async syncToFs() {
    if (this.#fsSyncScheduled) {
      return
    }
    this.#fsSyncScheduled = true

    const doSync = async () => {
      await this.#fsSyncMutex.runExclusive(async () => {
        this.#fsSyncScheduled = false
        await this.fs!.syncToFs(this.#relaxedDurability)
      })
    }

    if (this.#relaxedDurability) {
      doSync()
    } else {
      await doSync()
    }
  }

  /**
   * Listen for a notification
   * @param channel The channel to listen on
   * @param callback The callback to call when a notification is received
   */
  async listen(
    channel: string,
    callback: (payload: string) => void,
    tx?: Transaction,
  ) {
    return this._runExclusiveListen(() => this.#listen(channel, callback, tx))
  }

  async #listen(
    channel: string,
    callback: (payload: string) => void,
    tx?: Transaction,
  ) {
    const pgChannel = toPostgresName(channel)
    const pg = tx ?? this
    if (!this.#notifyListeners.has(pgChannel)) {
      this.#notifyListeners.set(pgChannel, new Set())
    }
    this.#notifyListeners.get(pgChannel)!.add(callback)
    try {
      await pg.exec(`LISTEN ${channel}`)
    } catch (e) {
      this.#notifyListeners.get(pgChannel)!.delete(callback)
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        this.#notifyListeners.delete(pgChannel)
      }
      throw e
    }
    return async (tx?: Transaction) => {
      await this.unlisten(pgChannel, callback, tx)
    }
  }

  /**
   * Stop listening for a notification
   * @param channel The channel to stop listening on
   * @param callback The callback to remove
   */
  async unlisten(
    channel: string,
    callback?: (payload: string) => void,
    tx?: Transaction,
  ) {
    return this._runExclusiveListen(() => this.#unlisten(channel, callback, tx))
  }

  async #unlisten(
    channel: string,
    callback?: (payload: string) => void,
    tx?: Transaction,
  ) {
    const pgChannel = toPostgresName(channel)
    const pg = tx ?? this
    const cleanUp = async () => {
      await pg.exec(`UNLISTEN ${channel}`)
      // While that query was running, another query might have subscribed
      // so we need to check again
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        this.#notifyListeners.delete(pgChannel)
      }
    }
    if (callback) {
      this.#notifyListeners.get(pgChannel)?.delete(callback)
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        await cleanUp()
      }
    } else {
      await cleanUp()
    }
  }

  /**
   * Listen to notifications
   * @param callback The callback to call when a notification is received
   */
  onNotification(
    callback: (channel: string, payload: string) => void,
  ): () => void {
    this.#globalNotifyListeners.add(callback)
    return () => {
      this.#globalNotifyListeners.delete(callback)
    }
  }

  /**
   * Stop listening to notifications
   * @param callback The callback to remove
   */
  offNotification(callback: (channel: string, payload: string) => void) {
    this.#globalNotifyListeners.delete(callback)
  }

  /**
   * Dump the PGDATA dir from the filesystem to a gzipped tarball.
   * @param compression The compression options to use - 'gzip', 'auto', 'none'
   * @returns The tarball as a File object where available, and fallback to a Blob
   */
  async dumpDataDir(
    compression?: DumpTarCompressionOptions,
  ): Promise<File | Blob> {
    await this._checkReady()
    const dbname = this.dataDir?.split('/').pop() ?? 'pgdata'
    return this.fs!.dumpTar(dbname, compression)
  }

  /**
   * Run a function in a mutex that's exclusive to queries
   * @param fn The query to run
   * @returns The result of the query
   */
  _runExclusiveQuery<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queryMutex.runExclusive(fn)
  }

  /**
   * Run a function in a mutex that's exclusive to transactions
   * @param fn The function to run
   * @returns The result of the function
   */
  _runExclusiveTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const x = this.#transactionMutex.runExclusive(fn)
    return x
  }

  async clone(): Promise<PGliteInterface> {
    const dump = await this.dumpDataDir('none')
    return PGlite.create({ loadDataDir: dump, extensions: this.#extensions })
  }

  _runExclusiveListen<T>(fn: () => Promise<T>): Promise<T> {
    return this.#listenMutex.runExclusive(fn)
  }
}
