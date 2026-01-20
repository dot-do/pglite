/**
 * Tests for the PGlite JSON Variant
 *
 * The JSON variant is built optimized for document-style JSON workloads with:
 * - Full JSON and JSONB support with all operators (@>, <@, ?, ?|, ?&, ->, ->>)
 * - GIN indexes for efficient JSONB queries
 * - JSONB path queries (jsonpath: @?, @@)
 * - English text search stemmer
 * - btree_gin and hstore extensions
 * - UUID support
 *
 * Target: ~8MB WASM bundle, ~50-60MB runtime memory
 *
 * This test file verifies:
 * 1. JSONB containment operators (@>, <@)
 * 2. JSONB existence operators (?, ?|, ?&)
 * 3. JSONB path operators (->, ->>, #>, #>>)
 * 4. JSONB path queries (@?, @@)
 * 5. GIN index creation and queries
 * 6. JSONB modification functions
 * 7. Document database use cases
 * 8. English text search on JSON content
 *
 * To run these tests against a JSON build:
 * 1. Build with: ./build-pglite-json.sh
 * 2. Copy release files to packages/pglite/release/
 * 3. Run: npm test -- pglite-json-variant
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '../dist/index.js'

describe('PGlite JSON Variant - JSONB Containment Operators', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL
      );

      INSERT INTO products (data) VALUES
        ('{"type": "phone", "brand": "Apple", "price": 999, "tags": ["premium", "flagship"]}'),
        ('{"type": "laptop", "brand": "Dell", "price": 1299, "tags": ["business", "professional"]}'),
        ('{"type": "phone", "brand": "Samsung", "price": 799, "tags": ["android", "premium"]}'),
        ('{"type": "tablet", "brand": "Apple", "price": 599, "tags": ["portable", "premium"]}');
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  describe('Contains operator @>', () => {
    it('should find objects containing a key-value pair', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT data FROM products WHERE data @> '{"type": "phone"}'
      `)
      expect(result.rows).toHaveLength(2)
    })

    it('should find objects containing multiple key-value pairs', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT data FROM products WHERE data @> '{"type": "phone", "brand": "Apple"}'
      `)
      expect(result.rows).toHaveLength(1)
    })

    it('should find objects containing array elements', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT data FROM products WHERE data @> '{"tags": ["premium"]}'
      `)
      expect(result.rows).toHaveLength(3)
    })
  })

  describe('Contained by operator <@', () => {
    it('should find objects contained by a larger object', async () => {
      await db.exec(`
        CREATE TABLE simple_docs (id SERIAL PRIMARY KEY, data JSONB);
        INSERT INTO simple_docs (data) VALUES
          ('{"a": 1}'),
          ('{"a": 1, "b": 2}'),
          ('{"a": 1, "b": 2, "c": 3}');
      `)

      const result = await db.query<{ data: object }>(`
        SELECT data FROM simple_docs WHERE data <@ '{"a": 1, "b": 2}'
      `)
      expect(result.rows).toHaveLength(2)
    })
  })
})

describe('PGlite JSON Variant - JSONB Existence Operators', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE TABLE contacts (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL
      );

      INSERT INTO contacts (data) VALUES
        ('{"name": "John", "email": "john@example.com", "phone": "555-1234"}'),
        ('{"name": "Jane", "email": "jane@example.com"}'),
        ('{"name": "Bob", "phone": "555-5678"}'),
        ('{"name": "Alice"}');
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  describe('Key exists operator ?', () => {
    it('should find objects with a specific key', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT data FROM contacts WHERE data ? 'email'
      `)
      expect(result.rows).toHaveLength(2)
    })

    it('should find objects with phone key', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT data FROM contacts WHERE data ? 'phone'
      `)
      expect(result.rows).toHaveLength(2)
    })
  })

  describe('Any key exists operator ?|', () => {
    it('should find objects with any of the specified keys', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT data FROM contacts WHERE data ?| array['email', 'phone']
      `)
      expect(result.rows).toHaveLength(3)
    })
  })

  describe('All keys exist operator ?&', () => {
    it('should find objects with all specified keys', async () => {
      const result = await db.query<{ data: object }>(`
        SELECT data FROM contacts WHERE data ?& array['email', 'phone']
      `)
      expect(result.rows).toHaveLength(1)
    })
  })
})

describe('PGlite JSON Variant - JSONB Path Operators', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
  })

  afterAll(async () => {
    await db.close()
  })

  describe('Arrow operators -> and ->>', () => {
    it('should access object field as JSON with ->', async () => {
      const result = await db.query<{ user: object }>(`
        SELECT '{"user": {"name": "John", "age": 30}}'::jsonb -> 'user' as user
      `)
      expect(result.rows[0].user).toEqual({ name: 'John', age: 30 })
    })

    it('should access object field as text with ->>', async () => {
      const result = await db.query<{ name: string }>(`
        SELECT '{"name": "John", "age": 30}'::jsonb ->> 'name' as name
      `)
      expect(result.rows[0].name).toBe('John')
    })

    it('should access array element with ->', async () => {
      const result = await db.query<{ first: string }>(`
        SELECT '["a", "b", "c"]'::jsonb -> 0 as first
      `)
      expect(result.rows[0].first).toBe('a')
    })
  })

  describe('Path operators #> and #>>', () => {
    it('should access nested path with #>', async () => {
      const result = await db.query<{ city: string }>(`
        SELECT '{"user": {"address": {"city": "NYC"}}}'::jsonb #> '{user,address,city}' as city
      `)
      expect(result.rows[0].city).toBe('NYC')
    })

    it('should access nested path as text with #>>', async () => {
      const result = await db.query<{ city: string }>(`
        SELECT '{"user": {"address": {"city": "NYC"}}}'::jsonb #>> '{user,address,city}' as city
      `)
      expect(result.rows[0].city).toBe('NYC')
    })

    it('should chain operators for complex access', async () => {
      const result = await db.query<{ name: string }>(`
        SELECT '{"users": [{"name": "John"}, {"name": "Jane"}]}'::jsonb
          -> 'users' -> 1 ->> 'name' as name
      `)
      expect(result.rows[0].name).toBe('Jane')
    })
  })
})

describe('PGlite JSON Variant - JSONB Path Queries (jsonpath)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL
      );

      INSERT INTO orders (data) VALUES
        ('{"customer": "John", "items": [{"name": "Widget", "qty": 5, "price": 10}, {"name": "Gadget", "qty": 2, "price": 50}]}'),
        ('{"customer": "Jane", "items": [{"name": "Widget", "qty": 1, "price": 10}]}'),
        ('{"customer": "Bob", "items": [{"name": "Gizmo", "qty": 10, "price": 100}]}');
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  describe('jsonpath exists @?', () => {
    it('should find documents matching jsonpath condition', async () => {
      const result = await db.query<{ id: number }>(`
        SELECT id FROM orders WHERE data @? '$.items[*] ? (@.price > 40)'
      `)
      expect(result.rows).toHaveLength(2)
    })

    it('should find documents with high quantity items', async () => {
      const result = await db.query<{ id: number }>(`
        SELECT id FROM orders WHERE data @? '$.items[*] ? (@.qty >= 10)'
      `)
      expect(result.rows).toHaveLength(1)
    })
  })

  describe('jsonpath predicate @@', () => {
    it('should evaluate jsonpath predicate', async () => {
      const result = await db.query<{ match: boolean }>(`
        SELECT '{"price": 150}'::jsonb @@ '$.price > 100' as match
      `)
      expect(result.rows[0].match).toBe(true)
    })
  })

  describe('jsonb_path_query functions', () => {
    it('should extract values with jsonb_path_query_array', async () => {
      const result = await db.query<{ names: string[] }>(`
        SELECT jsonb_path_query_array(
          '{"users": [{"name": "John"}, {"name": "Jane"}]}'::jsonb,
          '$.users[*].name'::jsonpath
        ) as names
      `)
      expect(result.rows[0].names).toEqual(['John', 'Jane'])
    })
  })
})

describe('PGlite JSON Variant - GIN Index for JSONB', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
  })

  afterAll(async () => {
    await db.close()
  })

  it('should create GIN index with default jsonb_ops', async () => {
    await db.exec(`
      CREATE TABLE indexed_docs (id SERIAL PRIMARY KEY, data JSONB NOT NULL);
      CREATE INDEX idx_docs_data ON indexed_docs USING GIN (data);
    `)

    const result = await db.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE indexname = 'idx_docs_data'
    `)
    expect(result.rows).toHaveLength(1)
  })

  it('should create GIN index with jsonb_path_ops', async () => {
    await db.exec(`
      CREATE TABLE path_indexed (id SERIAL PRIMARY KEY, data JSONB NOT NULL);
      CREATE INDEX idx_path_data ON path_indexed USING GIN (data jsonb_path_ops);
    `)

    const result = await db.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE indexname = 'idx_path_data'
    `)
    expect(result.rows).toHaveLength(1)
  })

  it('should use GIN index for containment queries', async () => {
    // Insert test data
    for (let i = 0; i < 50; i++) {
      await db.query(
        'INSERT INTO indexed_docs (data) VALUES ($1)',
        [{ type: i % 2 === 0 ? 'even' : 'odd', value: i }]
      )
    }

    await db.exec('ANALYZE indexed_docs;')

    const result = await db.query<{ count: string }>(`
      SELECT COUNT(*) as count FROM indexed_docs WHERE data @> '{"type": "even"}'
    `)
    expect(parseInt(result.rows[0].count)).toBe(25)
  })
})

describe('PGlite JSON Variant - JSONB Modification', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
  })

  afterAll(async () => {
    await db.close()
  })

  it('should update values with jsonb_set', async () => {
    const result = await db.query<{ data: object }>(`
      SELECT jsonb_set('{"name": "John", "age": 30}'::jsonb, '{age}', '31') as data
    `)
    expect(result.rows[0].data).toEqual({ name: 'John', age: 31 })
  })

  it('should concatenate JSONB with ||', async () => {
    const result = await db.query<{ data: object }>(`
      SELECT '{"a": 1}'::jsonb || '{"b": 2}'::jsonb as data
    `)
    expect(result.rows[0].data).toEqual({ a: 1, b: 2 })
  })

  it('should delete keys with -', async () => {
    const result = await db.query<{ data: object }>(`
      SELECT '{"a": 1, "b": 2, "c": 3}'::jsonb - 'b' as data
    `)
    expect(result.rows[0].data).toEqual({ a: 1, c: 3 })
  })

  it('should delete paths with #-', async () => {
    const result = await db.query<{ data: object }>(`
      SELECT '{"user": {"name": "John", "age": 30}}'::jsonb #- '{user,age}' as data
    `)
    expect(result.rows[0].data).toEqual({ user: { name: 'John' } })
  })

  it('should strip nulls with jsonb_strip_nulls', async () => {
    const result = await db.query<{ data: object }>(`
      SELECT jsonb_strip_nulls('{"a": 1, "b": null, "c": 3}'::jsonb) as data
    `)
    expect(result.rows[0].data).toEqual({ a: 1, c: 3 })
  })
})

describe('PGlite JSON Variant - Document Database Use Case', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE TABLE collection (
        _id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        doc JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX idx_collection_doc ON collection USING GIN (doc);
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  it('should support MongoDB-style insert and find', async () => {
    // Insert documents
    const doc1 = { type: 'user', name: 'John', email: 'john@example.com', tags: ['admin', 'active'] }
    const doc2 = { type: 'user', name: 'Jane', email: 'jane@example.com', tags: ['user'] }
    const doc3 = { type: 'product', name: 'Widget', price: 9.99, stock: 100 }

    await db.query('INSERT INTO collection (doc) VALUES ($1)', [doc1])
    await db.query('INSERT INTO collection (doc) VALUES ($1)', [doc2])
    await db.query('INSERT INTO collection (doc) VALUES ($1)', [doc3])

    // Find by type (like collection.find({type: 'user'}))
    const users = await db.query<{ doc: object }>(`
      SELECT doc FROM collection WHERE doc @> '{"type": "user"}'
    `)
    expect(users.rows).toHaveLength(2)
  })

  it('should support array containment queries', async () => {
    // Find users with admin tag (like collection.find({tags: 'admin'}))
    const admins = await db.query<{ doc: object }>(`
      SELECT doc FROM collection WHERE doc @> '{"tags": ["admin"]}'
    `)
    expect(admins.rows).toHaveLength(1)
  })

  it('should support document updates', async () => {
    // Update document (like collection.updateOne({name: 'John'}, {$push: {tags: 'superuser'}}))
    await db.exec(`
      UPDATE collection
      SET doc = jsonb_set(doc, '{tags}', doc->'tags' || '"superuser"'),
          updated_at = NOW()
      WHERE doc @> '{"name": "John"}'
    `)

    const updated = await db.query<{ doc: { tags: string[] } }>(`
      SELECT doc FROM collection WHERE doc @> '{"name": "John"}'
    `)
    expect(updated.rows[0].doc.tags).toContain('superuser')
  })

  it('should support field projection', async () => {
    // Project specific fields (like collection.find({}, {name: 1, email: 1}))
    const projected = await db.query<{ name: string; email: string }>(`
      SELECT doc->>'name' as name, doc->>'email' as email
      FROM collection
      WHERE doc @> '{"type": "user"}'
    `)
    expect(projected.rows).toHaveLength(2)
    expect(projected.rows[0]).toHaveProperty('name')
    expect(projected.rows[0]).toHaveProperty('email')
  })
})

describe('PGlite JSON Variant - English Text Search', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
  })

  afterAll(async () => {
    await db.close()
  })

  it('should support English text search', async () => {
    await db.exec(`
      CREATE TABLE articles (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(data->>'title', '') || ' ' || coalesce(data->>'body', ''))
        ) STORED
      );

      CREATE INDEX idx_articles_tsv ON articles USING GIN (tsv);

      INSERT INTO articles (data) VALUES
        ('{"title": "PostgreSQL Guide", "body": "Learn PostgreSQL database management"}'),
        ('{"title": "React Tutorial", "body": "Build web applications with React"}');
    `)

    const result = await db.query<{ data: object }>(`
      SELECT data FROM articles WHERE tsv @@ to_tsquery('english', 'postgresql')
    `)
    expect(result.rows).toHaveLength(1)
  })

  it('should use English stemmer', async () => {
    const result = await db.query<{ ts: string }>(`
      SELECT to_tsvector('english', 'running quickly')::text as ts
    `)
    expect(result.rows[0].ts).toContain('run')
    expect(result.rows[0].ts).toContain('quick')
  })
})

describe('PGlite JSON Variant - Performance', () => {
  it('should initialize quickly', async () => {
    const start = Date.now()
    const db = await PGlite.create()
    const duration = Date.now() - start

    // JSON build should initialize within reasonable time
    expect(duration).toBeLessThan(10000) // 10 seconds max

    await db.close()
  })

  it('should handle document workload efficiently', async () => {
    const db = await PGlite.create()

    await db.exec(`
      CREATE TABLE perf_docs (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL
      );
      CREATE INDEX idx_perf_docs ON perf_docs USING GIN (data);
    `)

    // Insert 100 documents
    const start = Date.now()
    for (let i = 0; i < 100; i++) {
      await db.query(
        'INSERT INTO perf_docs (data) VALUES ($1)',
        [{ type: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C', value: i, tags: [`tag${i % 10}`] }]
      )
    }
    const insertDuration = Date.now() - start

    // Query with containment
    const queryStart = Date.now()
    const result = await db.query<{ count: string }>(`
      SELECT COUNT(*) as count FROM perf_docs WHERE data @> '{"type": "A"}'
    `)
    const queryDuration = Date.now() - queryStart

    expect(parseInt(result.rows[0].count)).toBe(34) // Every 3rd item
    expect(insertDuration).toBeLessThan(30000) // 30 seconds max for inserts
    expect(queryDuration).toBeLessThan(1000) // 1 second max for query

    await db.close()
  })
})
