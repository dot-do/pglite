import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterface,
} from '../interface'

/**
 * pg_textsearch extension for PGLite
 *
 * Provides BM25 full-text search with relevance ranking.
 * Based on Timescale's pg_textsearch extension.
 *
 * Features:
 * - BM25 ranking algorithm for relevance scoring
 * - Block-Max WAND optimization for efficient top-k queries
 * - Configurable text search configurations (language support)
 *
 * Usage:
 * ```typescript
 * import { PGlite } from '@dotdo/pglite'
 * import { pg_textsearch } from '@dotdo/pglite/pg_textsearch'
 *
 * const pg = await PGlite.create({
 *   extensions: { pg_textsearch }
 * })
 *
 * await pg.exec('CREATE EXTENSION pg_textsearch')
 *
 * // Create a BM25 index
 * await pg.exec(`
 *   CREATE TABLE documents (id serial, content text);
 *   CREATE INDEX ON documents USING bm25 (content) WITH (text_config = 'english');
 * `)
 *
 * // Search with BM25 ranking
 * const results = await pg.query(`
 *   SELECT id, content
 *   FROM documents
 *   ORDER BY content <@> 'search terms'
 *   LIMIT 10
 * `)
 * ```
 *
 * @see https://github.com/timescale/pg_textsearch
 */
const setup = async (_pg: PGliteInterface, emscriptenOpts: any) => {
  return {
    emscriptenOpts,
    bundlePath: new URL('../../release/pg_textsearch.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pg_textsearch = {
  name: 'pg_textsearch',
  setup,
} satisfies Extension
