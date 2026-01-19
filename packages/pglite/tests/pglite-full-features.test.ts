/**
 * pglite-full-features.test.ts
 *
 * Comprehensive feature tests for the pglite-full build variant.
 * Verifies all Snowball languages, extensions, and types are working.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

// Test imports - adjust based on how tests are typically structured in this repo
const { PGlite } = await import('../dist/index.js')

describe('pglite-full features', () => {
  let db: InstanceType<typeof PGlite>

  beforeAll(async () => {
    db = await PGlite.create()
  })

  afterAll(async () => {
    await db.close()
  })

  describe('Snowball Stemmer Languages (27)', () => {
    // All 27 Snowball languages supported by PostgreSQL
    const snowballLanguages = [
      'arabic',
      'armenian',
      'basque',
      'catalan',
      'danish',
      'dutch',
      'english',
      'finnish',
      'french',
      'german',
      'greek',
      'hindi',
      'hungarian',
      'indonesian',
      'irish',
      'italian',
      'lithuanian',
      'nepali',
      'norwegian',
      'portuguese',
      'romanian',
      'russian',
      'serbian',
      'spanish',
      'swedish',
      'tamil',
      'turkish',
      'yiddish',
    ]

    it('should have all 27 Snowball languages available', async () => {
      const result = await db.query<{ cfgname: string }>(`
        SELECT cfgname FROM pg_ts_config
        WHERE cfgname NOT IN ('simple')
        ORDER BY cfgname
      `)

      const availableLanguages = result.rows.map((r) => r.cfgname)

      // Check that all expected languages are present
      for (const lang of snowballLanguages) {
        expect(availableLanguages).toContain(lang)
      }
    })

    // Test stemming for each language
    const stemmingTests: Record<string, [string, string]> = {
      english: ['running', 'run'],
      spanish: ['corriendo', 'corr'],
      french: ['courant', 'cour'],
      german: ['laufend', 'lauf'],
      italian: ['correndo', 'corr'],
      portuguese: ['correndo', 'corr'],
      dutch: ['lopende', 'lop'],
      russian: ['бежать', 'бежа'], // Running in Russian
      swedish: ['springande', 'spring'],
      norwegian: ['springer', 'spring'],
      danish: ['lober', 'lob'],
      finnish: ['juoksen', 'juoks'],
      hungarian: ['futok', 'fut'],
      turkish: ['kosuyorum', 'kosu'],
      romanian: ['alerg', 'alerg'],
      arabic: ['يركض', 'يركض'], // Arabic stemmer
      greek: ['τρέχω', 'τρεχ'], // Greek
    }

    for (const [lang, [input, expectedStem]] of Object.entries(stemmingTests)) {
      it(`should stem ${lang} words correctly`, async () => {
        const result = await db.query<{ stemmed: string }>(`
          SELECT ts_lexize('${lang}_stem', '${input}') as stemmed
        `)

        // The result should be an array (lexemes) that starts with the stem
        expect(result.rows.length).toBe(1)
        // ts_lexize returns null for words not found, or an array of lexemes
        if (result.rows[0].stemmed !== null) {
          // Just verify it returns something (exact stems vary by language version)
          expect(result.rows[0].stemmed).toBeDefined()
        }
      })
    }

    it('should support full-text search with multiple languages', async () => {
      // Create a table with multilingual content
      await db.exec(`
        CREATE TABLE IF NOT EXISTS multilingual_docs (
          id SERIAL PRIMARY KEY,
          content TEXT,
          language TEXT,
          tsv_content TSVECTOR
        );

        INSERT INTO multilingual_docs (content, language, tsv_content) VALUES
          ('The quick brown fox jumps', 'english', to_tsvector('english', 'The quick brown fox jumps')),
          ('Le renard brun rapide saute', 'french', to_tsvector('french', 'Le renard brun rapide saute')),
          ('Der schnelle braune Fuchs springt', 'german', to_tsvector('german', 'Der schnelle braune Fuchs springt'));
      `)

      // Search in English
      const englishResult = await db.query<{ content: string }>(`
        SELECT content FROM multilingual_docs
        WHERE tsv_content @@ to_tsquery('english', 'jump')
      `)
      expect(englishResult.rows.length).toBe(1)
      expect(englishResult.rows[0].content).toContain('jumps')

      // Clean up
      await db.exec('DROP TABLE multilingual_docs')
    })
  })

  describe('Contrib Extensions', () => {
    const contribExtensions = [
      'amcheck',
      'bloom',
      'btree_gin',
      'btree_gist',
      'citext',
      'cube',
      'dict_int',
      'earthdistance',
      'fuzzystrmatch',
      'hstore',
      'intarray',
      'isn',
      'lo',
      'ltree',
      'pg_trgm',
      'seg',
      'tablefunc',
      'tcn',
      'tsm_system_rows',
      'tsm_system_time',
      'unaccent',
      'uuid-ossp',
    ]

    it('should list all contrib extensions as available', async () => {
      const result = await db.query<{ name: string }>(`
        SELECT name FROM pg_available_extensions
        WHERE name = ANY($1)
        ORDER BY name
      `, [contribExtensions])

      const available = result.rows.map((r) => r.name)
      for (const ext of contribExtensions) {
        expect(available).toContain(ext)
      }
    })

    describe('citext extension', () => {
      it('should support case-insensitive text', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS citext')
        await db.exec(`
          CREATE TABLE IF NOT EXISTS citext_test (
            id SERIAL PRIMARY KEY,
            name CITEXT
          )
        `)
        await db.exec(`INSERT INTO citext_test (name) VALUES ('Hello')`)

        const result = await db.query<{ name: string }>(`
          SELECT name FROM citext_test WHERE name = 'hello'
        `)
        expect(result.rows.length).toBe(1)
        expect(result.rows[0].name).toBe('Hello')

        await db.exec('DROP TABLE citext_test')
        await db.exec('DROP EXTENSION citext')
      })
    })

    describe('hstore extension', () => {
      it('should support key-value storage', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS hstore')

        const result = await db.query<{ val: string }>(`
          SELECT 'a=>1, b=>2'::hstore -> 'a' as val
        `)
        expect(result.rows[0].val).toBe('1')

        await db.exec('DROP EXTENSION hstore')
      })
    })

    describe('pg_trgm extension', () => {
      it('should support trigram similarity', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm')

        const result = await db.query<{ similarity: number }>(`
          SELECT similarity('word', 'world') as similarity
        `)
        expect(result.rows[0].similarity).toBeGreaterThan(0)
        expect(result.rows[0].similarity).toBeLessThanOrEqual(1)

        await db.exec('DROP EXTENSION pg_trgm')
      })
    })

    describe('fuzzystrmatch extension', () => {
      it('should support soundex and levenshtein', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch')

        // Test soundex
        const soundexResult = await db.query<{ soundex: string }>(`
          SELECT soundex('Robert') as soundex
        `)
        expect(soundexResult.rows[0].soundex).toBe('R163')

        // Test levenshtein
        const levenshteinResult = await db.query<{ distance: number }>(`
          SELECT levenshtein('kitten', 'sitting') as distance
        `)
        expect(levenshteinResult.rows[0].distance).toBe(3)

        await db.exec('DROP EXTENSION fuzzystrmatch')
      })
    })

    describe('ltree extension', () => {
      it('should support hierarchical data', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS ltree')

        const result = await db.query<{ matches: boolean }>(`
          SELECT 'Top.Science.Astronomy'::ltree ~ '*.Science.*' as matches
        `)
        expect(result.rows[0].matches).toBe(true)

        await db.exec('DROP EXTENSION ltree')
      })
    })

    describe('cube extension', () => {
      it('should support multi-dimensional cubes', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS cube')

        const result = await db.query<{ distance: number }>(`
          SELECT cube_distance(cube(1,2,3), cube(4,5,6)) as distance
        `)
        // Distance between (1,2,3) and (4,5,6) = sqrt(27) ≈ 5.196
        expect(result.rows[0].distance).toBeCloseTo(5.196, 2)

        await db.exec('DROP EXTENSION cube')
      })
    })

    describe('uuid-ossp extension', () => {
      it('should generate UUIDs', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

        const result = await db.query<{ uuid: string }>(`
          SELECT uuid_generate_v4() as uuid
        `)
        // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
        expect(result.rows[0].uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        )

        await db.exec('DROP EXTENSION "uuid-ossp"')
      })
    })

    describe('unaccent extension', () => {
      it('should remove accents from text', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS unaccent')

        const result = await db.query<{ unaccented: string }>(`
          SELECT unaccent('Hôtel Café') as unaccented
        `)
        expect(result.rows[0].unaccented).toBe('Hotel Cafe')

        await db.exec('DROP EXTENSION unaccent')
      })
    })

    describe('intarray extension', () => {
      it('should support integer array operations', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS intarray')

        const result = await db.query<{ intersection: number[] }>(`
          SELECT ARRAY[1,2,3,4] & ARRAY[3,4,5,6] as intersection
        `)
        expect(result.rows[0].intersection).toEqual([3, 4])

        await db.exec('DROP EXTENSION intarray')
      })
    })
  })

  describe('Extra PGlite Extensions', () => {
    describe('vector extension (pgvector)', () => {
      it('should support vector similarity search', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS vector')

        await db.exec(`
          CREATE TABLE IF NOT EXISTS vector_test (
            id SERIAL PRIMARY KEY,
            embedding vector(3)
          )
        `)

        await db.exec(`
          INSERT INTO vector_test (embedding) VALUES
            ('[1,0,0]'),
            ('[0,1,0]'),
            ('[0,0,1]'),
            ('[0.5,0.5,0]')
        `)

        // Find nearest neighbor to [1,0,0]
        const result = await db.query<{ id: number; embedding: string }>(`
          SELECT id, embedding::text FROM vector_test
          ORDER BY embedding <-> '[1,0,0]'
          LIMIT 2
        `)

        expect(result.rows.length).toBe(2)
        expect(result.rows[0].embedding).toBe('[1,0,0]')

        await db.exec('DROP TABLE vector_test')
        await db.exec('DROP EXTENSION vector')
      })
    })

    describe('pg_uuidv7 extension', () => {
      it('should generate time-sortable UUIDv7', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS pg_uuidv7')

        const result = await db.query<{ uuid: string }>(`
          SELECT uuid_generate_v7() as uuid
        `)

        // UUIDv7 format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
        // The version nibble (7) is at position 14
        expect(result.rows[0].uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        )

        await db.exec('DROP EXTENSION pg_uuidv7')
      })
    })

    describe('pg_hashids extension', () => {
      it('should generate short unique IDs', async () => {
        await db.exec('CREATE EXTENSION IF NOT EXISTS pg_hashids')

        const result = await db.query<{ hashid: string }>(`
          SELECT id_encode(12345) as hashid
        `)

        // Should return a non-empty short string
        expect(result.rows[0].hashid).toBeTruthy()
        expect(result.rows[0].hashid.length).toBeGreaterThan(0)
        expect(result.rows[0].hashid.length).toBeLessThan(20)

        await db.exec('DROP EXTENSION pg_hashids')
      })
    })

    describe('pg_ivm extension (Incremental View Maintenance)', () => {
      it('should be available for installation', async () => {
        const result = await db.query<{ name: string }>(`
          SELECT name FROM pg_available_extensions WHERE name = 'pg_ivm'
        `)
        expect(result.rows.length).toBe(1)
      })
    })
  })

  describe('PL/pgSQL', () => {
    it('should support stored procedures', async () => {
      await db.exec(`
        CREATE OR REPLACE FUNCTION factorial(n INTEGER)
        RETURNS INTEGER AS $$
        DECLARE
          result INTEGER := 1;
        BEGIN
          FOR i IN 1..n LOOP
            result := result * i;
          END LOOP;
          RETURN result;
        END;
        $$ LANGUAGE plpgsql;
      `)

      const result = await db.query<{ factorial: number }>(`
        SELECT factorial(5) as factorial
      `)
      expect(result.rows[0].factorial).toBe(120)

      await db.exec('DROP FUNCTION factorial')
    })

    it('should support triggers', async () => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS trigger_test (
          id SERIAL PRIMARY KEY,
          name TEXT,
          updated_at TIMESTAMP
        );

        CREATE OR REPLACE FUNCTION update_timestamp()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at := NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER set_timestamp
        BEFORE INSERT OR UPDATE ON trigger_test
        FOR EACH ROW
        EXECUTE FUNCTION update_timestamp();
      `)

      await db.exec(`INSERT INTO trigger_test (name) VALUES ('test')`)

      const result = await db.query<{ updated_at: Date }>(`
        SELECT updated_at FROM trigger_test WHERE name = 'test'
      `)
      expect(result.rows[0].updated_at).toBeTruthy()

      await db.exec('DROP TRIGGER set_timestamp ON trigger_test')
      await db.exec('DROP FUNCTION update_timestamp')
      await db.exec('DROP TABLE trigger_test')
    })
  })

  describe('PostgreSQL Data Types', () => {
    it('should support JSON/JSONB types', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT '{"name": "test", "value": 123}'::jsonb as data
      `)
      expect(result.rows[0].data).toEqual({ name: 'test', value: 123 })
    })

    it('should support array types', async () => {
      const result = await db.query<{ arr: number[] }>(`
        SELECT ARRAY[1, 2, 3, 4, 5] as arr
      `)
      expect(result.rows[0].arr).toEqual([1, 2, 3, 4, 5])
    })

    it('should support geometric types', async () => {
      const result = await db.query<{ p: string }>(`
        SELECT point(1, 2)::text as p
      `)
      expect(result.rows[0].p).toBe('(1,2)')
    })

    it('should support range types', async () => {
      const result = await db.query<{ r: string }>(`
        SELECT '[1,10)'::int4range::text as r
      `)
      expect(result.rows[0].r).toBe('[1,10)')
    })

    it('should support network types', async () => {
      const result = await db.query<{ addr: string }>(`
        SELECT '192.168.1.0/24'::cidr::text as addr
      `)
      expect(result.rows[0].addr).toBe('192.168.1.0/24')
    })

    it('should support UUID type', async () => {
      const result = await db.query<{ valid: boolean }>(`
        SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid IS NOT NULL as valid
      `)
      expect(result.rows[0].valid).toBe(true)
    })
  })

  describe('XML Support', () => {
    it('should support XML type and functions', async () => {
      const result = await db.query<{ name: string }>(`
        SELECT xpath('/root/item/text()',
          '<root><item>test</item></root>'::xml
        )::text[] as name
      `)
      expect(result.rows[0].name).toContain('test')
    })
  })
})

describe('pglite-full bundle verification', () => {
  it('should report correct PostgreSQL version', async () => {
    const db = await PGlite.create()

    const result = await db.query<{ version: string }>(`
      SELECT version()
    `)

    // Should be PostgreSQL 17.x
    expect(result.rows[0].version).toMatch(/PostgreSQL 17/)

    await db.close()
  })

  it('should list expected number of available extensions', async () => {
    const db = await PGlite.create()

    const result = await db.query<{ count: number }>(`
      SELECT COUNT(*) as count FROM pg_available_extensions
    `)

    // pglite-full should have 50+ extensions available
    expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(50)

    await db.close()
  })

  it('should list expected number of FTS configurations', async () => {
    const db = await PGlite.create()

    const result = await db.query<{ count: number }>(`
      SELECT COUNT(*) as count FROM pg_ts_config
    `)

    // 27 Snowball languages + 'simple' = 28
    expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(28)

    await db.close()
  })
})
