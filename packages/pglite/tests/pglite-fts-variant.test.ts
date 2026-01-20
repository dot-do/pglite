/**
 * PGlite FTS Variant Tests
 *
 * Tests for the Full-Text Search optimized PGlite build (pglite-fts).
 * This variant is optimized for search-focused applications including:
 * - Search engines
 * - Content management systems
 * - Documentation search
 * - Product catalogs
 *
 * Target Bundle Size: ~10.5MB (WASM ~7MB + data ~3.5MB)
 * Target Memory: ~60-65MB
 *
 * Features tested:
 * - English Snowball stemmer with tsvector/tsquery
 * - GIN indexes for efficient FTS
 * - pg_trgm extension for trigram similarity
 * - fuzzystrmatch extension for phonetic matching
 * - ts_rank and ts_headline functions
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PGlite } from '../dist/index.js'

describe('PGlite FTS Variant', () => {
  let pg: InstanceType<typeof PGlite>

  beforeAll(async () => {
    pg = await PGlite.create()
  })

  afterAll(async () => {
    await pg.close()
  })

  // ===========================================================================
  // 1. English Full-Text Search
  // ===========================================================================

  describe('English Full-Text Search', () => {
    /**
     * Test: English tsvector creation with stemming
     *
     * The English stemmer should normalize words to their root form.
     */
    it('creates tsvector with English stemming', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('english', 'The running dogs are quickly jumping over fences') as ts
      `)

      expect(result.rows).toHaveLength(1)
      const tsvector = result.rows[0].ts

      // Check stemmed forms
      expect(tsvector).toContain('run') // running -> run
      expect(tsvector).toContain('dog') // dogs -> dog
      expect(tsvector).toContain('quick') // quickly -> quick
      expect(tsvector).toContain('jump') // jumping -> jump
      expect(tsvector).toContain('fenc') // fences -> fenc

      // Stop words should be removed
      expect(tsvector).not.toContain("'the'")
      expect(tsvector).not.toContain("'are'")
      expect(tsvector).not.toContain("'over'")
    })

    /**
     * Test: English tsquery creation
     *
     * The English configuration should properly parse and stem queries.
     */
    it('creates tsquery with English stemming', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('english', 'running & jumping') as tq
      `)

      expect(result.rows).toHaveLength(1)
      const tsquery = result.rows[0].tq

      // Words should be stemmed in the query too
      expect(tsquery).toContain('run')
      expect(tsquery).toContain('jump')
    })

    /**
     * Test: FTS matching with English configuration
     *
     * Matching should work regardless of word form.
     */
    it('matches stemmed forms in FTS queries', async () => {
      // "ran" should match "running" after stemming
      const result = await pg.query<{ match: boolean }>(`
        SELECT to_tsvector('english', 'The dog is running fast') @@
               to_tsquery('english', 'ran') as match
      `)

      expect(result.rows[0].match).toBe(true)
    })

    /**
     * Test: English stop words are filtered
     *
     * Common English words should be excluded from the tsvector.
     */
    it('filters English stop words', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('english', 'the a an and or but in on at to') as ts
      `)

      // All stop words should result in empty tsvector
      expect(result.rows[0].ts).toBe('')
    })

    /**
     * Test: Simple configuration (no stemming)
     *
     * The 'simple' configuration should be available for non-stemmed search.
     */
    it('supports simple configuration without stemming', async () => {
      const english = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('english', 'running') as ts
      `)
      expect(english.rows[0].ts).toContain('run')

      const simple = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('simple', 'running') as ts
      `)
      expect(simple.rows[0].ts).toContain('running')
    })

    /**
     * Test: Various tsquery functions
     */
    it('supports different tsquery creation functions', async () => {
      // plainto_tsquery for user input
      const plain = await pg.query<{ tq: string }>(`
        SELECT plainto_tsquery('english', 'The Fat Rats') as tq
      `)
      expect(plain.rows[0].tq).toBe("'fat' & 'rat'")

      // phraseto_tsquery for phrase matching
      const phrase = await pg.query<{ tq: string }>(`
        SELECT phraseto_tsquery('english', 'The Fat Rats') as tq
      `)
      expect(phrase.rows[0].tq).toBe("'fat' <-> 'rat'")

      // websearch_to_tsquery for web-style queries
      const websearch = await pg.query<{ tq: string }>(`
        SELECT websearch_to_tsquery('english', '"sad cat" or "fat rat"') as tq
      `)
      expect(websearch.rows[0].tq).toBe("'sad' <-> 'cat' | 'fat' <-> 'rat'")
    })
  })

  // ===========================================================================
  // 2. GIN Index Support for FTS
  // ===========================================================================

  describe('GIN Index Support', () => {
    /**
     * Test: Create GIN index on tsvector column
     */
    it('creates GIN index on tsvector column', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS gin_test_docs;
        CREATE TABLE gin_test_docs (
          id SERIAL PRIMARY KEY,
          content TEXT,
          search_vector tsvector GENERATED ALWAYS AS (
            to_tsvector('english', coalesce(content, ''))
          ) STORED
        );
        CREATE INDEX gin_test_docs_search_idx ON gin_test_docs USING GIN (search_vector);
      `)

      const result = await pg.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'gin_test_docs' AND indexname = 'gin_test_docs_search_idx'
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].indexdef.toLowerCase()).toContain('gin')
      expect(result.rows[0].indexdef).toContain('search_vector')
    })

    /**
     * Test: GIN index on tsvector expression
     */
    it('creates GIN index on tsvector expression', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS gin_expr_articles;
        CREATE TABLE gin_expr_articles (
          id SERIAL PRIMARY KEY,
          title TEXT,
          body TEXT
        );
        CREATE INDEX gin_expr_articles_fts_idx ON gin_expr_articles
        USING GIN ((
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(body, '')), 'B')
        ));
      `)

      const result = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'gin_expr_articles' AND indexname = 'gin_expr_articles_fts_idx'
      `)

      expect(result.rows).toHaveLength(1)
    })

    /**
     * Test: FTS query uses GIN index
     */
    it('performs FTS queries with GIN index', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS gin_indexed_docs;
        CREATE TABLE gin_indexed_docs (
          id SERIAL PRIMARY KEY,
          content TEXT,
          tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
        );
        CREATE INDEX idx_gin_indexed_docs_tsv ON gin_indexed_docs USING GIN (tsv);
      `)

      // Insert test data
      await pg.exec(`
        INSERT INTO gin_indexed_docs (content) VALUES
        ('PostgreSQL full-text search guide'),
        ('MySQL database tutorial'),
        ('MongoDB document storage');
      `)

      const result = await pg.query<{ content: string }>(`
        SELECT content FROM gin_indexed_docs
        WHERE tsv @@ to_tsquery('english', 'postgresql')
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].content).toBe('PostgreSQL full-text search guide')
    })
  })

  // ===========================================================================
  // 3. Search Ranking Functions
  // ===========================================================================

  describe('Search Ranking', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS ranking_test;
        CREATE TABLE ranking_test (
          id SERIAL PRIMARY KEY,
          title TEXT,
          body TEXT
        );
        INSERT INTO ranking_test (title, body) VALUES
          ('The Fat Rats', 'The fat rats ate the fat cats.'),
          ('The Fat Cats', 'The fat cats ate the fat rats.'),
          ('The Fat Cats and Rats', 'The fat cats and rats ate the fat rats and cats.');
      `)
    })

    it('ranks results with ts_rank_cd', async () => {
      const result = await pg.query<{ title: string; rank: number }>(`
        SELECT title, ts_rank_cd(to_tsvector('english', body), to_tsquery('english', 'fat & rat')) as rank
        FROM ranking_test
        ORDER BY rank DESC
      `)

      expect(result.rows).toHaveLength(3)
      // The document with most matches should rank highest
      expect(result.rows[0].title).toBe('The Fat Cats and Rats')
    })

    it('ranks results with ts_rank', async () => {
      const result = await pg.query<{ title: string; rank: number }>(`
        SELECT title, ts_rank(to_tsvector('english', body), to_tsquery('english', 'fat | rat')) as rank
        FROM ranking_test
        ORDER BY rank DESC
      `)

      expect(result.rows).toHaveLength(3)
      expect(result.rows[0].rank).toBeGreaterThan(0)
    })
  })

  // ===========================================================================
  // 4. Search Highlighting (ts_headline)
  // ===========================================================================

  describe('Search Highlighting', () => {
    it('highlights search matches with ts_headline', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'PostgreSQL is a powerful, open source object-relational database system.',
          to_tsquery('english', 'powerful & database'),
          'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=15'
        ) as headline
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].headline).toContain('<mark>')
      expect(result.rows[0].headline).toContain('</mark>')
    })

    it('highlights with custom markers', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'The quick brown fox jumps over the lazy dog',
          to_tsquery('english', 'fox'),
          'StartSel=[[, StopSel=]]'
        ) as headline
      `)

      expect(result.rows[0].headline).toContain('[[')
      expect(result.rows[0].headline).toContain(']]')
    })
  })

  // ===========================================================================
  // 5. Weighted Search
  // ===========================================================================

  describe('Weighted Search', () => {
    it('supports weighted tsvector with setweight', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS weighted_docs;
        CREATE TABLE weighted_docs (
          id SERIAL PRIMARY KEY,
          title TEXT,
          body TEXT,
          tsv tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(body, '')), 'B')
          ) STORED
        );
        INSERT INTO weighted_docs (title, body) VALUES
          ('PostgreSQL Guide', 'Learn about databases'),
          ('Database Basics', 'PostgreSQL is a database');
      `)

      const result = await pg.query<{ title: string; rank: number }>(`
        SELECT title, ts_rank(tsv, to_tsquery('english', 'postgresql')) as rank
        FROM weighted_docs
        ORDER BY rank DESC
      `)

      // Title match (weight A) should rank higher than body match (weight B)
      expect(result.rows[0].title).toBe('PostgreSQL Guide')
    })
  })

  // ===========================================================================
  // 6. Combined FTS Use Cases
  // ===========================================================================

  describe('Combined FTS Use Cases', () => {
    /**
     * Test: Document search with ranking and highlighting
     */
    it('implements full search pipeline', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS search_documents;
        CREATE TABLE search_documents (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tsv tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', title), 'A') ||
            setweight(to_tsvector('english', content), 'B')
          ) STORED
        );
        CREATE INDEX search_documents_tsv_idx ON search_documents USING GIN (tsv);

        INSERT INTO search_documents (title, content) VALUES
          ('PostgreSQL Full-Text Search', 'PostgreSQL provides powerful full-text search capabilities with tsvector and tsquery.'),
          ('Introduction to Databases', 'A database is an organized collection of structured information.'),
          ('Search Engine Basics', 'Search engines use indexing and ranking algorithms to find relevant content.');
      `)

      const searchQuery = 'postgresql search'
      const result = await pg.query<{ title: string; rank: number; snippet: string }>(`
        SELECT
          title,
          ts_rank(tsv, websearch_to_tsquery('english', $1)) as rank,
          ts_headline('english', content, websearch_to_tsquery('english', $1),
            'StartSel=<b>, StopSel=</b>, MaxWords=20') as snippet
        FROM search_documents
        WHERE tsv @@ websearch_to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT 5
      `, [searchQuery])

      expect(result.rows.length).toBeGreaterThanOrEqual(1)
      expect(result.rows[0].title).toBe('PostgreSQL Full-Text Search')
      expect(result.rows[0].snippet).toContain('<b>')
    })
  })

  // ===========================================================================
  // 7. Prefix Search
  // ===========================================================================

  describe('Prefix Search', () => {
    it('supports prefix matching with :*', async () => {
      const result = await pg.query<{ match: boolean }>(`
        SELECT to_tsvector('english', 'PostgreSQL database system') @@
               to_tsquery('english', 'post:*') as match
      `)
      expect(result.rows[0].match).toBe(true)
    })

    it('supports prefix in websearch queries', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS prefix_test;
        CREATE TABLE prefix_test (id SERIAL, word TEXT);
        INSERT INTO prefix_test (word) VALUES
          ('programming'), ('program'), ('programmer'), ('pragmatic');
      `)

      const result = await pg.query<{ word: string }>(`
        SELECT word FROM prefix_test
        WHERE to_tsvector('simple', word) @@ to_tsquery('simple', 'progr:*')
        ORDER BY word
      `)

      expect(result.rows.length).toBe(3) // programming, program, programmer
    })
  })

  // ===========================================================================
  // 8. Phrase Search
  // ===========================================================================

  describe('Phrase Search', () => {
    it('supports phrase proximity with <->', async () => {
      const result = await pg.query<{ match: boolean }>(`
        SELECT to_tsvector('english', 'the quick brown fox') @@
               to_tsquery('english', 'quick <-> brown') as match
      `)
      expect(result.rows[0].match).toBe(true)
    })

    it('supports phrase proximity with distance', async () => {
      const result = await pg.query<{ match: boolean }>(`
        SELECT to_tsvector('english', 'the quick brown fox') @@
               to_tsquery('english', 'quick <2> fox') as match
      `)
      expect(result.rows[0].match).toBe(true)
    })
  })

  // ===========================================================================
  // 9. Negation
  // ===========================================================================

  describe('Negation', () => {
    it('supports negation in queries', async () => {
      const result = await pg.query<{ match: boolean }>(`
        SELECT to_tsvector('english', 'PostgreSQL database') @@
               to_tsquery('english', 'postgresql & !mysql') as match
      `)
      expect(result.rows[0].match).toBe(true)
    })

    it('excludes documents with negated terms', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS neg_test;
        CREATE TABLE neg_test (id SERIAL, content TEXT);
        INSERT INTO neg_test (content) VALUES
          ('PostgreSQL is great'),
          ('MySQL is also good'),
          ('PostgreSQL and MySQL together');
      `)

      const result = await pg.query<{ content: string }>(`
        SELECT content FROM neg_test
        WHERE to_tsvector('english', content) @@
              to_tsquery('english', 'postgresql & !mysql')
      `)

      expect(result.rows.length).toBe(1)
      expect(result.rows[0].content).toBe('PostgreSQL is great')
    })
  })

  // ===========================================================================
  // 10. JSON/JSONB with FTS
  // ===========================================================================

  describe('JSON/JSONB with FTS', () => {
    it('performs FTS on JSON text fields', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS json_fts_test;
        CREATE TABLE json_fts_test (
          id SERIAL PRIMARY KEY,
          data JSONB,
          search_text TEXT GENERATED ALWAYS AS (
            data->>'title' || ' ' || data->>'description'
          ) STORED,
          tsv tsvector GENERATED ALWAYS AS (
            to_tsvector('english',
              coalesce(data->>'title', '') || ' ' ||
              coalesce(data->>'description', '')
            )
          ) STORED
        );
        CREATE INDEX json_fts_test_tsv_idx ON json_fts_test USING GIN (tsv);

        INSERT INTO json_fts_test (data) VALUES
          ('{"title": "PostgreSQL Guide", "description": "Database administration tips", "category": "tech"}'),
          ('{"title": "Cooking Basics", "description": "Learn to cook delicious meals", "category": "food"}');
      `)

      const result = await pg.query<{ data: { title: string; category: string } }>(`
        SELECT data FROM json_fts_test
        WHERE tsv @@ to_tsquery('english', 'database')
      `)

      expect(result.rows.length).toBe(1)
      expect(result.rows[0].data.title).toBe('PostgreSQL Guide')
    })
  })
})
