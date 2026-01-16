/**
 * pglite-workers.ts
 *
 * Modified PGlite implementation that works in Cloudflare Workers.
 * Uses EM_JS trampolines instead of Emscripten's addFunction.
 *
 * This is a drop-in replacement for the initialization code in pglite.ts
 * that eliminates runtime WASM compilation.
 *
 * Key changes from original pglite.ts:
 * 1. No mod.addFunction() calls
 * 2. No mod.removeFunction() calls
 * 3. Callbacks set via Module._pgliteCallbacks object
 * 4. Works in environments that block eval/new Function (Cloudflare Workers)
 *
 * Usage:
 * ```typescript
 * import { PGliteWorkers } from './pglite-workers';
 * const db = await PGliteWorkers.create();
 * ```
 */

import { Mutex } from 'async-mutex';
import { Parser as ProtocolParser, serialize } from '@electric-sql/pg-protocol';
import {
  BackendMessage,
  CommandCompleteMessage,
  DatabaseError,
  NoticeMessage,
  NotificationResponseMessage,
} from '@electric-sql/pg-protocol/messages';

/**
 * PostgresMod interface for trampoline approach.
 * Note the absence of addFunction/removeFunction.
 */
export interface PostgresModWorkers {
  HEAPU8: Uint8Array;
  HEAP8: Int8Array;
  HEAPU32: Uint32Array;

  // The EM_JS callbacks are stored here (set by pglite_init_callbacks)
  _pgliteCallbacks?: {
    read: ((ptr: number, maxLength: number) => number) | null;
    write: ((ptr: number, length: number) => number) | null;
  };

  // Core exported functions
  _pgl_initdb: () => number;
  _pgl_backend: () => void;
  _pgl_shutdown: () => void;
  _interactive_one: (length: number, peek: number) => void;

  // Trampoline init (from EM_JS in pglite-comm-trampoline.h)
  _pglite_init_callbacks?: () => void;

  // Legacy function (no-op in trampoline mode)
  _set_read_write_cbs?: (read_cb: number, write_cb: number) => void;

  // Filesystem
  FS: any;

  // Other standard Emscripten exports
  UTF8ToString: (ptr: number) => string;
  stringToNewUTF8: (str: string) => number;
}

/**
 * PGlite implementation for Cloudflare Workers.
 * Uses EM_JS trampolines for callbacks instead of addFunction.
 */
export class PGliteWorkers {
  private mod: PostgresModWorkers;
  private protocolParser = new ProtocolParser();

  // Query state
  private queryReadBuffer?: ArrayBuffer;
  private queryWriteChunks?: Uint8Array[];
  private outputData: Uint8Array = new Uint8Array(0);
  private readOffset = 0;
  private writeOffset = 0;
  private inputData = new Uint8Array(1024 * 1024); // 1MB default

  // Results
  private currentResults: BackendMessage[] = [];
  private currentThrowOnError = false;
  private currentDatabaseError: DatabaseError | null = null;
  private currentOnNotice?: (notice: NoticeMessage) => void;

  // Mutex for query serialization
  private queryMutex = new Mutex();

  // State
  private ready = false;
  private closed = false;

  constructor(mod: PostgresModWorkers) {
    this.mod = mod;
  }

  /**
   * Initialize the database with trampoline callbacks.
   * This replaces the addFunction-based initialization.
   */
  async init(): Promise<void> {
    // Initialize the callback storage (EM_JS function from C)
    if (this.mod._pglite_init_callbacks) {
      this.mod._pglite_init_callbacks();
    }

    // Ensure callback storage exists
    if (!this.mod._pgliteCallbacks) {
      this.mod._pgliteCallbacks = { read: null, write: null };
    }

    // Set up the write callback (PostgreSQL -> JavaScript)
    // This is the equivalent of the addFunction call for #pglite_write
    this.mod._pgliteCallbacks.write = (ptr: number, length: number): number => {
      return this.handleWrite(ptr, length);
    };

    // Set up the read callback (JavaScript -> PostgreSQL)
    // This is the equivalent of the addFunction call for #pglite_read
    this.mod._pgliteCallbacks.read = (ptr: number, maxLength: number): number => {
      return this.handleRead(ptr, maxLength);
    };

    // NOTE: We don't call _set_read_write_cbs because the trampoline version
    // of pglite-comm.h directly uses Module._pgliteCallbacks

    console.log('[PGliteWorkers] Trampoline callbacks initialized (no addFunction used)');

    // Initialize the database
    const idb = this.mod._pgl_initdb();
    if (!idb) {
      throw new Error('INITDB failed');
    }

    // Start the backend
    this.mod._pgl_backend();

    this.ready = true;
  }

  /**
   * Handle write callback from PostgreSQL.
   * This is called when PostgreSQL has output data.
   */
  private handleWrite(ptr: number, length: number): number {
    let bytes: Uint8Array;
    try {
      bytes = this.mod.HEAPU8.subarray(ptr, ptr + length);
    } catch (e) {
      console.error('[PGliteWorkers] handleWrite error:', e);
      return -1;
    }

    // Parse the protocol messages
    this.protocolParser.parse(bytes, (msg) => {
      this.parseMessage(msg);
    });

    // Store raw response
    const copied = bytes.slice();
    let requiredSize = this.writeOffset + copied.length;

    if (requiredSize > this.inputData.length) {
      const newSize = this.inputData.length + (this.inputData.length >> 1) + requiredSize;
      const newBuffer = new Uint8Array(Math.min(newSize, 1024 * 1024 * 1024)); // Max 1GB
      newBuffer.set(this.inputData.subarray(0, this.writeOffset));
      this.inputData = newBuffer;
    }

    this.inputData.set(copied, this.writeOffset);
    this.writeOffset += copied.length;

    return this.inputData.length;
  }

  /**
   * Handle read callback from PostgreSQL.
   * This is called when PostgreSQL needs input data.
   */
  private handleRead(ptr: number, maxLength: number): number {
    let length = this.outputData.length - this.readOffset;
    if (length > maxLength) {
      length = maxLength;
    }

    try {
      this.mod.HEAP8.set(
        this.outputData.subarray(this.readOffset, this.readOffset + length),
        ptr
      );
      this.readOffset += length;
    } catch (e) {
      console.error('[PGliteWorkers] handleRead error:', e);
      return -1;
    }

    return length;
  }

  /**
   * Parse a backend message.
   */
  private parseMessage(msg: BackendMessage): void {
    if (!this.currentDatabaseError) {
      if (msg instanceof DatabaseError) {
        if (this.currentThrowOnError) {
          this.currentDatabaseError = msg;
        }
      } else if (msg instanceof NoticeMessage) {
        if (this.currentOnNotice) {
          this.currentOnNotice(msg);
        }
      }
      this.currentResults.push(msg);
    }
  }

  /**
   * Execute a protocol message synchronously.
   */
  execProtocolRawSync(message: Uint8Array): Uint8Array {
    this.readOffset = 0;
    this.writeOffset = 0;
    this.outputData = message;

    // Reset input buffer to default size
    if (this.inputData.length !== 1024 * 1024) {
      this.inputData = new Uint8Array(1024 * 1024);
    }

    // Execute the message
    this.mod._interactive_one(message.length, message[0]);

    this.outputData = new Uint8Array(0);

    if (this.writeOffset) {
      return this.inputData.subarray(0, this.writeOffset);
    }
    return new Uint8Array(0);
  }

  /**
   * Execute a protocol message.
   */
  async execProtocol(
    message: Uint8Array,
    options: { throwOnError?: boolean; onNotice?: (notice: NoticeMessage) => void } = {}
  ): Promise<{ messages: BackendMessage[]; data: Uint8Array }> {
    this.currentThrowOnError = options.throwOnError ?? true;
    this.currentOnNotice = options.onNotice;
    this.currentResults = [];
    this.currentDatabaseError = null;

    const data = this.execProtocolRawSync(message);

    const databaseError = this.currentDatabaseError;
    this.currentThrowOnError = false;
    this.currentOnNotice = undefined;
    this.currentDatabaseError = null;
    const result = { messages: this.currentResults, data };
    this.currentResults = [];

    if (options.throwOnError !== false && databaseError) {
      this.protocolParser = new ProtocolParser(); // Reset parser
      throw databaseError;
    }

    return result;
  }

  /**
   * Execute a SQL query.
   */
  async query<T = any>(sql: string): Promise<{ rows: T[] }> {
    if (!this.ready) {
      throw new Error('PGlite is not ready');
    }

    return this.queryMutex.runExclusive(async () => {
      const message = serialize.query(sql);
      const { messages } = await this.execProtocol(new Uint8Array(message.buffer));

      const rows: T[] = [];
      // Parse rows from messages (simplified)
      for (const msg of messages) {
        if ((msg as any).name === 'dataRow') {
          // Parse row data
          rows.push((msg as any).fields as T);
        }
      }

      return { rows };
    });
  }

  /**
   * Close the database.
   * Note: No removeFunction calls needed!
   */
  async close(): Promise<void> {
    if (this.closed) return;

    try {
      await this.execProtocol(serialize.end());
      this.mod._pgl_shutdown();

      // Clean up callbacks (no removeFunction needed!)
      if (this.mod._pgliteCallbacks) {
        this.mod._pgliteCallbacks.read = null;
        this.mod._pgliteCallbacks.write = null;
      }
    } catch (e) {
      const err = e as { name: string; status: number };
      if (err.name !== 'ExitStatus' || err.status !== 0) {
        throw e;
      }
    }

    this.closed = true;
    console.log('[PGliteWorkers] Database closed');
  }

  /**
   * Create a new PGliteWorkers instance.
   */
  static async create(modFactory: () => Promise<PostgresModWorkers>): Promise<PGliteWorkers> {
    const mod = await modFactory();
    const instance = new PGliteWorkers(mod);
    await instance.init();
    return instance;
  }
}

/**
 * Example usage in a Cloudflare Worker:
 *
 * ```typescript
 * import { PGliteWorkers } from './pglite-workers';
 * import PostgresModFactory from './pglite.js';  // Built with trampoline headers
 *
 * export default {
 *   async fetch(request: Request): Promise<Response> {
 *     const db = await PGliteWorkers.create(() => PostgresModFactory());
 *
 *     const result = await db.query('SELECT 1 + 1 as sum');
 *
 *     await db.close();
 *
 *     return new Response(JSON.stringify(result));
 *   }
 * };
 * ```
 */
