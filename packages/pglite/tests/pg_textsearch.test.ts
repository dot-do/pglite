import { describe, it, expect } from 'vitest'
import { testEsmCjsAndDTC } from './test-utils.ts'

await testEsmCjsAndDTC(async (importType) => {
  const { PGlite } =
    importType === 'esm'
      ? await import('../dist/index.js')
      : ((await import(
          '../dist/index.cjs'
        )) as unknown as typeof import('../dist/index.js'))

  const { pg_textsearch } =
    importType === 'esm'
      ? await import('../dist/pg_textsearch/index.js')
      : ((await import(
          '../dist/pg_textsearch/index.cjs'
        )) as unknown as typeof import('../dist/pg_textsearch/index.js'))

  describe(`pg_textsearch`, () => {
    it('can load extension', async () => {
      const pg = new PGlite({
        extensions: {
          pg_textsearch,
        },
      })

      await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch;')

      const res = await pg.query<{ extname: string }>(`
        SELECT extname
        FROM pg_extension
        WHERE extname = 'pg_textsearch'
      `)

      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].extname).toBe('pg_textsearch')
    })

    it('can create BM25 index on text column', async () => {
      const pg = new PGlite({
        extensions: {
          pg_textsearch,
        },
      })

      await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch;')

      // Create a table with text content
      await pg.exec(`
        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          title TEXT,
          content TEXT
        );
      `)

      // Create BM25 index on content column with english text config
      await pg.exec(`
        CREATE INDEX documents_content_bm25_idx
        ON documents
        USING bm25 (content)
        WITH (text_config = 'english');
      `)

      // Verify index was created
      const res = await pg.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'documents'
          AND indexname = 'documents_content_bm25_idx'
      `)

      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].indexname).toBe('documents_content_bm25_idx')
      expect(res.rows[0].indexdef).toContain('bm25')
    })

    it('can search using BM25 ranking with <@> operator', async () => {
      const pg = new PGlite({
        extensions: {
          pg_textsearch,
        },
      })

      await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch;')

      // Create and populate table
      await pg.exec(`
        CREATE TABLE articles (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `)

      await pg.exec(`
        CREATE INDEX articles_bm25_idx
        ON articles
        USING bm25 (content)
        WITH (text_config = 'english');
      `)

      // Insert test documents
      await pg.exec(`
        INSERT INTO articles (content) VALUES
        ('PostgreSQL is a powerful open source database'),
        ('Full text search enables searching through documents'),
        ('BM25 is a ranking function used in information retrieval'),
        ('Database indexing improves query performance'),
        ('The quick brown fox jumps over the lazy dog');
      `)

      // Search with BM25 ranking using <@> operator
      // Lower scores = better matches (returns negative BM25 for ASC ordering)
      const res = await pg.query<{ id: number; content: string }>(`
        SELECT id, content
        FROM articles
        ORDER BY content <@> 'database search'
        LIMIT 3
      `)

      expect(res.rows.length).toBeGreaterThan(0)
      expect(res.rows.length).toBeLessThanOrEqual(3)

      // Verify results contain relevant terms
      const contents = res.rows.map((r) => r.content.toLowerCase())
      const hasRelevantResult = contents.some(
        (c) => c.includes('database') || c.includes('search'),
      )
      expect(hasRelevantResult).toBe(true)
    })

    it('can use to_bm25query for explicit index queries', async () => {
      const pg = new PGlite({
        extensions: {
          pg_textsearch,
        },
      })

      await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch;')

      await pg.exec(`
        CREATE TABLE docs (
          id SERIAL PRIMARY KEY,
          body TEXT
        );
      `)

      await pg.exec(`
        CREATE INDEX docs_bm25_idx
        ON docs
        USING bm25 (body)
        WITH (text_config = 'english');
      `)

      await pg.exec(`
        INSERT INTO docs (body) VALUES
        ('Machine learning algorithms'),
        ('Deep learning neural networks'),
        ('Natural language processing');
      `)

      // Query using explicit bm25query type with index name
      const res = await pg.query<{ id: number; body: string }>(`
        SELECT id, body
        FROM docs
        WHERE body <@> to_bm25query('docs_bm25_idx', 'learning')::bm25query < 0
        ORDER BY body <@> 'learning'
        LIMIT 2
      `)

      expect(res.rows.length).toBeGreaterThan(0)
      const bodies = res.rows.map((r) => r.body.toLowerCase())
      const hasLearning = bodies.some((b) => b.includes('learning'))
      expect(hasLearning).toBe(true)
    })

    it('supports BM25 parameters k1 and b', async () => {
      const pg = new PGlite({
        extensions: {
          pg_textsearch,
        },
      })

      await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch;')

      await pg.exec(`
        CREATE TABLE texts (
          id SERIAL PRIMARY KEY,
          data TEXT
        );
      `)

      // Create index with custom BM25 parameters
      // k1: term frequency saturation (default 1.2)
      // b: length normalization (default 0.75)
      await pg.exec(`
        CREATE INDEX texts_bm25_idx
        ON texts
        USING bm25 (data)
        WITH (text_config = 'english', k1 = 1.5, b = 0.5);
      `)

      // Verify index was created with custom parameters
      const res = await pg.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'texts'
          AND indexname = 'texts_bm25_idx'
      `)

      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].indexname).toBe('texts_bm25_idx')
    })

    it('supports bm25_dump_index debug function', async () => {
      const pg = new PGlite({
        extensions: {
          pg_textsearch,
        },
      })

      await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch;')

      await pg.exec(`
        CREATE TABLE test_dump (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `)

      await pg.exec(`
        CREATE INDEX test_dump_bm25_idx
        ON test_dump
        USING bm25 (content)
        WITH (text_config = 'english');
      `)

      await pg.exec(`
        INSERT INTO test_dump (content) VALUES
        ('Hello world'),
        ('Goodbye world');
      `)

      // Debug function should not throw
      const res = await pg.query<{ bm25_summarize_index: string }>(`
        SELECT bm25_summarize_index('test_dump_bm25_idx')
      `)

      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].bm25_summarize_index).toBeDefined()
    })
  })
})
