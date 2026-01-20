/**
 * Full-Text Search Tests for PGlite FTS Variant
 *
 * RED TESTS: These tests are designed to verify full-text search functionality
 * that requires the FTS variant build. They test comprehensive FTS features
 * including stemming, ranking, highlighting, and GIN indexes.
 *
 * Test categories:
 * 1. tsvector creation - Document vectorization
 * 2. tsquery parsing - Query parsing and operators
 * 3. Full-text search with ts_rank - Relevance ranking
 * 4. GIN index creation and usage - Index performance
 * 5. Language configuration - Multi-language support
 * 6. Highlighting with ts_headline - Result excerpts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '../dist/index.js'

describe('Full-Text Search', () => {
  let pg: InstanceType<typeof PGlite>

  beforeAll(async () => {
    pg = await PGlite.create()
  })

  afterAll(async () => {
    await pg.close()
  })

  // ===========================================================================
  // 1. TSVECTOR CREATION
  // ===========================================================================

  describe('tsvector creation', () => {
    it('creates tsvector from plain text', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('simple', 'The quick brown fox') as ts
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].ts).toContain('quick')
      expect(result.rows[0].ts).toContain('brown')
      expect(result.rows[0].ts).toContain('fox')
    })

    it('creates tsvector with word positions', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('simple', 'hello world hello') as ts
      `)

      expect(result.rows).toHaveLength(1)
      // tsvector should include position information
      // 'hello':1,3 'world':2
      expect(result.rows[0].ts).toMatch(/hello.*:.*1.*3/)
      expect(result.rows[0].ts).toMatch(/world.*:.*2/)
    })

    it('creates tsvector with English stemming', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('english', 'running dogs are jumping') as ts
      `)

      expect(result.rows).toHaveLength(1)
      const tsvector = result.rows[0].ts

      // English stemmer should normalize words
      expect(tsvector).toContain('run')  // running -> run
      expect(tsvector).toContain('dog')  // dogs -> dog
      expect(tsvector).toContain('jump') // jumping -> jump
    })

    it('creates weighted tsvector with setweight', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT setweight(to_tsvector('simple', 'important'), 'A') ||
               setweight(to_tsvector('simple', 'regular'), 'B') as ts
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].ts).toContain("'important':1A")
      expect(result.rows[0].ts).toContain("'regular':1B")
    })

    it('concatenates multiple tsvectors', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('simple', 'title text') ||
               to_tsvector('simple', 'body content') as ts
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].ts).toContain('title')
      expect(result.rows[0].ts).toContain('body')
      expect(result.rows[0].ts).toContain('content')
    })

    it('handles special characters in tsvector', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('simple', 'user@example.com https://test.com') as ts
      `)

      expect(result.rows).toHaveLength(1)
      // Should handle URLs and emails
      expect(result.rows[0].ts.length).toBeGreaterThan(0)
    })

    it('casts text directly to tsvector', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT 'a fat cat sat on a mat'::tsvector as ts
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].ts).toBe("'a' 'cat' 'fat' 'mat' 'on' 'sat'")
    })
  })

  // ===========================================================================
  // 2. TSQUERY PARSING
  // ===========================================================================

  describe('tsquery parsing', () => {
    it('parses basic tsquery with AND operator', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('simple', 'cat & dog') as tq
      `)

      expect(result.rows[0].tq).toBe("'cat' & 'dog'")
    })

    it('parses tsquery with OR operator', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('simple', 'cat | dog') as tq
      `)

      expect(result.rows[0].tq).toBe("'cat' | 'dog'")
    })

    it('parses tsquery with NOT operator', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('simple', 'cat & !dog') as tq
      `)

      expect(result.rows[0].tq).toBe("'cat' & !'dog'")
    })

    it('parses tsquery with phrase operator', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('simple', 'quick <-> brown') as tq
      `)

      expect(result.rows[0].tq).toBe("'quick' <-> 'brown'")
    })

    it('parses tsquery with distance operator', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('simple', 'cat <2> dog') as tq
      `)

      expect(result.rows[0].tq).toBe("'cat' <2> 'dog'")
    })

    it('parses tsquery with prefix matching', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('simple', 'super:*') as tq
      `)

      expect(result.rows[0].tq).toBe("'super':*")
    })

    it('parses plainto_tsquery for user input', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT plainto_tsquery('english', 'The Fat Rats') as tq
      `)

      expect(result.rows[0].tq).toBe("'fat' & 'rat'")
    })

    it('parses phraseto_tsquery for phrase matching', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT phraseto_tsquery('english', 'The Fat Rats') as tq
      `)

      expect(result.rows[0].tq).toBe("'fat' <-> 'rat'")
    })

    it('parses websearch_to_tsquery for web-style queries', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT websearch_to_tsquery('english', '"sad cat" or "fat rat"') as tq
      `)

      expect(result.rows[0].tq).toBe("'sad' <-> 'cat' | 'fat' <-> 'rat'")
    })

    it('parses websearch_to_tsquery with negation', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT websearch_to_tsquery('english', 'signal -"segmentation fault"') as tq
      `)

      expect(result.rows[0].tq).toBe("'signal' & !( 'segment' <-> 'fault' )")
    })

    it('handles complex nested queries', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT to_tsquery('simple', '(cat | dog) & !bird') as tq
      `)

      expect(result.rows[0].tq).toBe("( 'cat' | 'dog' ) & !'bird'")
    })
  })

  // ===========================================================================
  // 3. FULL-TEXT SEARCH WITH TS_RANK
  // ===========================================================================

  describe('ts_rank ranking', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS rank_test_docs;
        CREATE TABLE rank_test_docs (
          id SERIAL PRIMARY KEY,
          title TEXT,
          body TEXT
        );
        INSERT INTO rank_test_docs (title, body) VALUES
          ('PostgreSQL Guide', 'PostgreSQL is a powerful database system.'),
          ('Database Basics', 'Learn about relational databases and SQL.'),
          ('PostgreSQL Advanced', 'Advanced PostgreSQL features include full-text search and JSON support. PostgreSQL is great.');
      `)
    })

    it('ranks documents by relevance with ts_rank', async () => {
      const result = await pg.query<{ title: string; rank: number }>(`
        SELECT title,
               ts_rank(to_tsvector('english', body), to_tsquery('english', 'postgresql')) as rank
        FROM rank_test_docs
        WHERE to_tsvector('english', body) @@ to_tsquery('english', 'postgresql')
        ORDER BY rank DESC
      `)

      expect(result.rows.length).toBeGreaterThan(0)
      // Documents with more matches should rank higher
      expect(result.rows[0].rank).toBeGreaterThan(0)
    })

    it('ranks documents with ts_rank_cd (cover density)', async () => {
      const result = await pg.query<{ title: string; rank: number }>(`
        SELECT title,
               ts_rank_cd(to_tsvector('english', body), to_tsquery('english', 'postgresql & database')) as rank
        FROM rank_test_docs
        ORDER BY rank DESC
      `)

      expect(result.rows).toHaveLength(3)
      // ts_rank_cd considers term proximity
      expect(result.rows[0].rank).toBeGreaterThanOrEqual(result.rows[1].rank)
    })

    it('supports normalization options in ts_rank', async () => {
      const result = await pg.query<{ title: string; normalized_rank: number; raw_rank: number }>(`
        SELECT title,
               ts_rank(to_tsvector('english', body), to_tsquery('english', 'database'), 32) as normalized_rank,
               ts_rank(to_tsvector('english', body), to_tsquery('english', 'database')) as raw_rank
        FROM rank_test_docs
        WHERE to_tsvector('english', body) @@ to_tsquery('english', 'database')
        ORDER BY normalized_rank DESC
      `)

      expect(result.rows.length).toBeGreaterThan(0)
      // Normalization should divide by document length
      expect(result.rows[0].normalized_rank).toBeLessThanOrEqual(result.rows[0].raw_rank)
    })

    it('ranks with weighted fields', async () => {
      const result = await pg.query<{ title: string; rank: number }>(`
        SELECT title,
               ts_rank(
                 setweight(to_tsvector('english', title), 'A') ||
                 setweight(to_tsvector('english', body), 'B'),
                 to_tsquery('english', 'postgresql')
               ) as rank
        FROM rank_test_docs
        ORDER BY rank DESC
      `)

      expect(result.rows.length).toBeGreaterThan(0)
      // Title match (weight A) should contribute more
      expect(result.rows[0].title).toContain('PostgreSQL')
    })

    it('ranks with custom weights array', async () => {
      const result = await pg.query<{ title: string; rank: number }>(`
        SELECT title,
               ts_rank(
                 '{0.1, 0.2, 0.4, 1.0}',
                 setweight(to_tsvector('english', title), 'A') ||
                 setweight(to_tsvector('english', body), 'D'),
                 to_tsquery('english', 'postgresql')
               ) as rank
        FROM rank_test_docs
        ORDER BY rank DESC
      `)

      expect(result.rows.length).toBeGreaterThan(0)
    })
  })

  // ===========================================================================
  // 4. GIN INDEX CREATION AND USAGE
  // ===========================================================================

  describe('GIN index', () => {
    it('creates GIN index on tsvector column', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS gin_fts_docs;
        CREATE TABLE gin_fts_docs (
          id SERIAL PRIMARY KEY,
          content TEXT,
          tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
        );
        CREATE INDEX gin_fts_docs_idx ON gin_fts_docs USING GIN (tsv);
      `)

      const result = await pg.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'gin_fts_docs' AND indexname = 'gin_fts_docs_idx'
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].indexdef.toLowerCase()).toContain('gin')
    })

    it('creates GIN index on expression', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS gin_expr_docs;
        CREATE TABLE gin_expr_docs (
          id SERIAL PRIMARY KEY,
          title TEXT,
          body TEXT
        );
        CREATE INDEX gin_expr_docs_idx ON gin_expr_docs
        USING GIN (to_tsvector('english', title || ' ' || body));
      `)

      const result = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'gin_expr_docs' AND indexname = 'gin_expr_docs_idx'
      `)

      expect(result.rows).toHaveLength(1)
    })

    it('uses GIN index for full-text search queries', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS gin_search_docs;
        CREATE TABLE gin_search_docs (
          id SERIAL PRIMARY KEY,
          content TEXT,
          tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
        );
        CREATE INDEX gin_search_idx ON gin_search_docs USING GIN (tsv);

        INSERT INTO gin_search_docs (content) VALUES
          ('PostgreSQL full-text search'),
          ('MySQL database tutorial'),
          ('MongoDB document storage'),
          ('PostgreSQL performance tuning'),
          ('Redis caching strategies');
      `)

      const result = await pg.query<{ content: string }>(`
        SELECT content FROM gin_search_docs
        WHERE tsv @@ to_tsquery('english', 'postgresql')
        ORDER BY content
      `)

      expect(result.rows).toHaveLength(2)
      expect(result.rows.map(r => r.content)).toContain('PostgreSQL full-text search')
      expect(result.rows.map(r => r.content)).toContain('PostgreSQL performance tuning')
    })

    it('creates GIN index with fastupdate option', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS gin_fastupdate_docs;
        CREATE TABLE gin_fastupdate_docs (
          id SERIAL PRIMARY KEY,
          tsv tsvector
        );
        CREATE INDEX gin_fastupdate_idx ON gin_fastupdate_docs
        USING GIN (tsv) WITH (fastupdate = on);
      `)

      const result = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'gin_fastupdate_docs'
      `)

      expect(result.rows).toHaveLength(1)
    })

    it('supports GIN index with gin_trgm_ops', async () => {
      // This may require pg_trgm extension
      await pg.exec(`
        DROP TABLE IF EXISTS trgm_test;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE TABLE trgm_test (
          id SERIAL PRIMARY KEY,
          name TEXT
        );
        CREATE INDEX trgm_test_idx ON trgm_test USING GIN (name gin_trgm_ops);
      `)

      const result = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'trgm_test'
      `)

      expect(result.rows.length).toBeGreaterThan(0)
    })
  })

  // ===========================================================================
  // 5. LANGUAGE CONFIGURATION
  // ===========================================================================

  describe('language configuration', () => {
    it('supports simple configuration (no stemming)', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('simple', 'running dogs') as ts
      `)

      expect(result.rows[0].ts).toContain('running')
      expect(result.rows[0].ts).toContain('dogs')
    })

    it('supports English configuration with stemming', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('english', 'running dogs') as ts
      `)

      expect(result.rows[0].ts).toContain('run')
      expect(result.rows[0].ts).toContain('dog')
    })

    it('filters English stop words', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('english', 'the a an and or but') as ts
      `)

      // All stop words should result in empty tsvector
      expect(result.rows[0].ts).toBe('')
    })

    it('lists available text search configurations', async () => {
      const result = await pg.query<{ cfgname: string }>(`
        SELECT cfgname FROM pg_ts_config ORDER BY cfgname
      `)

      expect(result.rows.length).toBeGreaterThan(0)
      const configs = result.rows.map(r => r.cfgname)
      expect(configs).toContain('simple')
      expect(configs).toContain('english')
    })

    it('lists available text search dictionaries', async () => {
      const result = await pg.query<{ dictname: string }>(`
        SELECT dictname FROM pg_ts_dict ORDER BY dictname
      `)

      expect(result.rows.length).toBeGreaterThan(0)
      const dicts = result.rows.map(r => r.dictname)
      expect(dicts).toContain('simple')
    })

    it('shows default text search configuration', async () => {
      const result = await pg.query<{ setting: string }>(`
        SHOW default_text_search_config
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].setting).toBeDefined()
    })

    it('allows setting custom search configuration', async () => {
      await pg.exec(`SET default_text_search_config = 'simple'`)

      const result = await pg.query<{ ts: string }>(`
        SELECT to_tsvector('running dogs') as ts
      `)

      // With simple config, no stemming
      expect(result.rows[0].ts).toContain('running')
    })

    it('supports Spanish configuration if available', async () => {
      const configCheck = await pg.query<{ count: number }>(`
        SELECT COUNT(*) as count FROM pg_ts_config WHERE cfgname = 'spanish'
      `)

      if (configCheck.rows[0].count > 0) {
        const result = await pg.query<{ ts: string }>(`
          SELECT to_tsvector('spanish', 'Los perros corren rapidamente') as ts
        `)

        expect(result.rows[0].ts.length).toBeGreaterThan(0)
      } else {
        // Skip test if Spanish not available
        expect(true).toBe(true)
      }
    })

    it('supports German configuration if available', async () => {
      const configCheck = await pg.query<{ count: number }>(`
        SELECT COUNT(*) as count FROM pg_ts_config WHERE cfgname = 'german'
      `)

      if (configCheck.rows[0].count > 0) {
        const result = await pg.query<{ ts: string }>(`
          SELECT to_tsvector('german', 'Die Hunde laufen schnell') as ts
        `)

        expect(result.rows[0].ts.length).toBeGreaterThan(0)
      } else {
        expect(true).toBe(true)
      }
    })
  })

  // ===========================================================================
  // 6. HIGHLIGHTING WITH TS_HEADLINE
  // ===========================================================================

  describe('ts_headline highlighting', () => {
    it('highlights matching words with default markers', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'PostgreSQL is a powerful open-source database system.',
          to_tsquery('english', 'powerful')
        ) as headline
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].headline).toContain('<b>')
      expect(result.rows[0].headline).toContain('</b>')
      expect(result.rows[0].headline).toContain('powerful')
    })

    it('highlights with custom start/stop markers', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'The quick brown fox jumps over the lazy dog.',
          to_tsquery('english', 'fox'),
          'StartSel=<mark>, StopSel=</mark>'
        ) as headline
      `)

      expect(result.rows[0].headline).toContain('<mark>')
      expect(result.rows[0].headline).toContain('</mark>')
    })

    it('limits headline with MaxWords option', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'PostgreSQL is a powerful, open source object-relational database system with over 35 years of active development.',
          to_tsquery('english', 'database'),
          'MaxWords=10, MinWords=1'
        ) as headline
      `)

      expect(result.rows[0].headline).toBeDefined()
      // Headline should be limited
      const wordCount = result.rows[0].headline.split(/\s+/).length
      expect(wordCount).toBeLessThanOrEqual(15) // Allow some flexibility
    })

    it('supports MaxFragments option', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'PostgreSQL is great. It is a powerful database. PostgreSQL supports JSON.',
          to_tsquery('english', 'postgresql'),
          'MaxFragments=2, FragmentDelimiter= ... '
        ) as headline
      `)

      expect(result.rows[0].headline).toBeDefined()
    })

    it('highlights multiple matching terms', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'PostgreSQL is a powerful database system with advanced features.',
          to_tsquery('english', 'powerful & database'),
          'StartSel=[[, StopSel=]]'
        ) as headline
      `)

      expect(result.rows[0].headline).toContain('[[')
      expect(result.rows[0].headline).toContain(']]')
    })

    it('handles phrase highlighting', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'The quick brown fox jumps over the lazy dog.',
          phraseto_tsquery('english', 'brown fox'),
          'StartSel=**, StopSel=**'
        ) as headline
      `)

      expect(result.rows[0].headline).toContain('**')
    })

    it('uses HighlightAll option', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'english',
          'Dog runs. Dog jumps. Dog sleeps.',
          to_tsquery('english', 'dog'),
          'HighlightAll=true, StartSel=<em>, StopSel=</em>'
        ) as headline
      `)

      // Count occurrences of <em>
      const matches = result.rows[0].headline.match(/<em>/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(1)
    })

    it('works with simple configuration', async () => {
      const result = await pg.query<{ headline: string }>(`
        SELECT ts_headline(
          'simple',
          'Testing simple configuration for highlighting.',
          to_tsquery('simple', 'simple')
        ) as headline
      `)

      expect(result.rows[0].headline).toContain('<b>simple</b>')
    })
  })

  // ===========================================================================
  // ADDITIONAL FTS FEATURES
  // ===========================================================================

  describe('additional FTS features', () => {
    it('supports tsvector match operator (@@)', async () => {
      const result = await pg.query<{ match: boolean }>(`
        SELECT to_tsvector('english', 'The fat cat sat on the mat') @@
               to_tsquery('english', 'cat & mat') as match
      `)

      expect(result.rows[0].match).toBe(true)
    })

    it('supports NOT match', async () => {
      const result = await pg.query<{ match: boolean }>(`
        SELECT to_tsvector('english', 'PostgreSQL database') @@
               to_tsquery('english', '!mysql') as match
      `)

      expect(result.rows[0].match).toBe(true)
    })

    it('extracts lexemes with ts_debug', async () => {
      const result = await pg.query<{ alias: string; token: string; lexemes: string[] }>(`
        SELECT alias, token, lexemes FROM ts_debug('english', 'PostgreSQL database')
      `)

      expect(result.rows.length).toBeGreaterThan(0)
    })

    it('gets query tree with ts_lexize', async () => {
      const result = await pg.query<{ ts_lexize: string[] }>(`
        SELECT ts_lexize('english_stem', 'running')
      `)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].ts_lexize).toContain('run')
    })

    it('supports numnode to count query terms', async () => {
      const result = await pg.query<{ count: number }>(`
        SELECT numnode(to_tsquery('english', 'cat & dog | bird')) as count
      `)

      expect(result.rows[0].count).toBeGreaterThan(0)
    })

    it('supports querytree to see query structure', async () => {
      const result = await pg.query<{ tree: string }>(`
        SELECT querytree(to_tsquery('english', 'cat & dog')) as tree
      `)

      expect(result.rows[0].tree).toBeDefined()
    })

    it('gets tsvector stats with ts_stat', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS stat_docs;
        CREATE TABLE stat_docs (tsv tsvector);
        INSERT INTO stat_docs VALUES
          (to_tsvector('english', 'cat dog bird')),
          (to_tsvector('english', 'cat bird fish')),
          (to_tsvector('english', 'dog fish cat'));
      `)

      const result = await pg.query<{ word: string; ndoc: number; nentry: number }>(`
        SELECT * FROM ts_stat('SELECT tsv FROM stat_docs')
        ORDER BY ndoc DESC, word
      `)

      expect(result.rows.length).toBeGreaterThan(0)
      // 'cat' should appear in all 3 documents
      const catRow = result.rows.find(r => r.word === 'cat')
      expect(catRow).toBeDefined()
      expect(catRow?.ndoc).toBe(3)
    })

    it('rewrites queries with ts_rewrite', async () => {
      const result = await pg.query<{ tq: string }>(`
        SELECT ts_rewrite(
          'a & b'::tsquery,
          'a'::tsquery,
          'c'::tsquery
        ) as tq
      `)

      expect(result.rows[0].tq).toBe("'c' & 'b'")
    })

    it('calculates tsvector length', async () => {
      const result = await pg.query<{ len: number }>(`
        SELECT length(to_tsvector('english', 'The quick brown fox')) as len
      `)

      expect(result.rows[0].len).toBeGreaterThan(0)
    })

    it('strips positions from tsvector', async () => {
      const result = await pg.query<{ ts: string }>(`
        SELECT strip(to_tsvector('english', 'cat dog')) as ts
      `)

      expect(result.rows[0].ts).not.toContain(':')
    })
  })
})
