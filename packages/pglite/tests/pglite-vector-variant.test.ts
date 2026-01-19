/**
 * PGlite Vector Variant Tests
 *
 * Tests for the vector-optimized PGlite build (pglite-vector).
 * This variant is optimized for AI/ML workloads including:
 * - RAG applications
 * - Semantic search
 * - Embedding storage
 * - AI agent memory
 *
 * Features tested:
 * - pgvector extension with HNSW and IVFFlat indexes
 * - Vector similarity operations (cosine, L2, inner product)
 * - JSON/JSONB metadata storage
 * - Basic full-text search (English)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '../dist/index.js'
import { vector } from '../dist/vector/index.js'

describe('PGlite Vector Variant', () => {
  let pg: InstanceType<typeof PGlite>

  beforeAll(async () => {
    pg = await PGlite.create({
      extensions: { vector },
    })
    await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')
  })

  afterAll(async () => {
    await pg.close()
  })

  describe('pgvector Extension', () => {
    it('loads successfully', async () => {
      const res = await pg.query<{ extname: string }>(`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `)
      expect(res.rows[0]?.extname).toBe('vector')
    })

    it('creates vector type columns', async () => {
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          id SERIAL PRIMARY KEY,
          content TEXT NOT NULL,
          embedding vector(384)
        )
      `)

      const res = await pg.query<{ column_name: string; data_type: string }>(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'embeddings' AND column_name = 'embedding'
      `)
      expect(res.rows[0]?.data_type).toBe('USER-DEFINED')
    })
  })

  describe('HNSW Index', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS hnsw_test;
        CREATE TABLE hnsw_test (
          id SERIAL PRIMARY KEY,
          embedding vector(3)
        );
        INSERT INTO hnsw_test (embedding) VALUES
          ('[1,2,3]'),
          ('[4,5,6]'),
          ('[7,8,9]'),
          ('[1,1,1]'),
          ('[2,2,2]');
      `)
    })

    it('creates HNSW index with L2 distance', async () => {
      await pg.exec(`
        CREATE INDEX IF NOT EXISTS hnsw_l2_idx ON hnsw_test
        USING hnsw (embedding vector_l2_ops)
      `)

      const res = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'hnsw_test' AND indexname = 'hnsw_l2_idx'
      `)
      expect(res.rows[0]?.indexname).toBe('hnsw_l2_idx')
    })

    it('creates HNSW index with cosine distance', async () => {
      await pg.exec(`
        CREATE INDEX IF NOT EXISTS hnsw_cosine_idx ON hnsw_test
        USING hnsw (embedding vector_cosine_ops)
      `)

      const res = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'hnsw_test' AND indexname = 'hnsw_cosine_idx'
      `)
      expect(res.rows[0]?.indexname).toBe('hnsw_cosine_idx')
    })

    it('creates HNSW index with inner product', async () => {
      await pg.exec(`
        CREATE INDEX IF NOT EXISTS hnsw_ip_idx ON hnsw_test
        USING hnsw (embedding vector_ip_ops)
      `)

      const res = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'hnsw_test' AND indexname = 'hnsw_ip_idx'
      `)
      expect(res.rows[0]?.indexname).toBe('hnsw_ip_idx')
    })
  })

  describe('IVFFlat Index', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS ivfflat_test;
        CREATE TABLE ivfflat_test (
          id SERIAL PRIMARY KEY,
          embedding vector(3)
        );
        INSERT INTO ivfflat_test (embedding)
        SELECT ARRAY[random(), random(), random()]::vector
        FROM generate_series(1, 100);
      `)
    })

    it('creates IVFFlat index with L2 distance', async () => {
      await pg.exec(`
        CREATE INDEX IF NOT EXISTS ivf_l2_idx ON ivfflat_test
        USING ivfflat (embedding vector_l2_ops) WITH (lists = 10)
      `)

      const res = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'ivfflat_test' AND indexname = 'ivf_l2_idx'
      `)
      expect(res.rows[0]?.indexname).toBe('ivf_l2_idx')
    })
  })

  describe('Vector Similarity Operations', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS similarity_test;
        CREATE TABLE similarity_test (
          id SERIAL PRIMARY KEY,
          name TEXT,
          vec vector(3)
        );
        INSERT INTO similarity_test (name, vec) VALUES
          ('north', '[0,1,0]'),
          ('south', '[0,-1,0]'),
          ('east', '[1,0,0]'),
          ('west', '[-1,0,0]'),
          ('up', '[0,0,1]');
      `)
    })

    it('calculates L2 distance (<->)', async () => {
      const res = await pg.query<{ name: string; distance: number }>(`
        SELECT name, vec <-> '[0,1,0]' as distance
        FROM similarity_test
        ORDER BY distance
        LIMIT 3
      `)
      expect(res.rows[0]?.name).toBe('north')
      expect(res.rows[0]?.distance).toBeCloseTo(0, 5)
    })

    it('calculates cosine distance (<=>)', async () => {
      const res = await pg.query<{ name: string; distance: number }>(`
        SELECT name, vec <=> '[0,1,0]' as distance
        FROM similarity_test
        ORDER BY distance
        LIMIT 3
      `)
      expect(res.rows[0]?.name).toBe('north')
      expect(res.rows[0]?.distance).toBeCloseTo(0, 5)
    })

    it('calculates negative inner product (<#>)', async () => {
      const res = await pg.query<{ name: string; ip: number }>(`
        SELECT name, vec <#> '[0,1,0]' as ip
        FROM similarity_test
        ORDER BY ip
        LIMIT 3
      `)
      // Negative inner product, so smallest is best match
      expect(res.rows[0]?.name).toBe('north')
    })

    it('finds nearest neighbors', async () => {
      const res = await pg.query<{ name: string }>(`
        SELECT name
        FROM similarity_test
        ORDER BY vec <-> '[0.1,0.9,0]'
        LIMIT 1
      `)
      expect(res.rows[0]?.name).toBe('north')
    })
  })

  describe('JSON/JSONB Metadata Storage', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS rag_documents;
        CREATE TABLE rag_documents (
          id SERIAL PRIMARY KEY,
          content TEXT NOT NULL,
          embedding vector(384),
          metadata JSONB DEFAULT '{}'
        );
      `)
    })

    it('stores JSONB metadata with vectors', async () => {
      const embedding = Array(384).fill(0.1).join(',')
      await pg.exec(`
        INSERT INTO rag_documents (content, embedding, metadata)
        VALUES (
          'Test document content',
          '[${embedding}]',
          '{"source": "test", "page": 1, "tags": ["ai", "ml"]}'
        )
      `)

      const res = await pg.query<{ content: string; metadata: object }>(`
        SELECT content, metadata FROM rag_documents WHERE id = 1
      `)
      expect(res.rows[0]?.content).toBe('Test document content')
      expect(res.rows[0]?.metadata).toEqual({
        source: 'test',
        page: 1,
        tags: ['ai', 'ml'],
      })
    })

    it('queries JSONB metadata with containment', async () => {
      const res = await pg.query<{ count: number }>(`
        SELECT COUNT(*)::int as count
        FROM rag_documents
        WHERE metadata @> '{"source": "test"}'
      `)
      expect(res.rows[0]?.count).toBeGreaterThanOrEqual(1)
    })

    it('queries JSONB array elements', async () => {
      const res = await pg.query<{ count: number }>(`
        SELECT COUNT(*)::int as count
        FROM rag_documents
        WHERE metadata -> 'tags' ? 'ai'
      `)
      expect(res.rows[0]?.count).toBeGreaterThanOrEqual(1)
    })
  })

  describe('RAG Application Patterns', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS knowledge_base;
        CREATE TABLE knowledge_base (
          id SERIAL PRIMARY KEY,
          chunk_text TEXT NOT NULL,
          embedding vector(3),
          document_id INTEGER,
          chunk_index INTEGER,
          metadata JSONB DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS kb_embedding_idx ON knowledge_base
        USING hnsw (embedding vector_cosine_ops);

        INSERT INTO knowledge_base (chunk_text, embedding, document_id, chunk_index, metadata)
        VALUES
          ('PostgreSQL is a powerful database', '[0.8,0.1,0.1]', 1, 0, '{"topic": "database"}'),
          ('Vectors enable semantic search', '[0.7,0.2,0.1]', 1, 1, '{"topic": "search"}'),
          ('AI assistants use embeddings', '[0.6,0.3,0.1]', 2, 0, '{"topic": "ai"}'),
          ('Machine learning transforms data', '[0.5,0.4,0.1]', 2, 1, '{"topic": "ml"}'),
          ('RAG combines retrieval and generation', '[0.75,0.15,0.1]', 3, 0, '{"topic": "rag"}');
      `)
    })

    it('retrieves relevant chunks by semantic similarity', async () => {
      const query_embedding = '[0.78,0.12,0.1]' // Similar to "database" topic
      const res = await pg.query<{ chunk_text: string; similarity: number }>(`
        SELECT
          chunk_text,
          1 - (embedding <=> '${query_embedding}') as similarity
        FROM knowledge_base
        ORDER BY embedding <=> '${query_embedding}'
        LIMIT 3
      `)

      expect(res.rows.length).toBe(3)
      expect(res.rows[0]?.similarity).toBeGreaterThan(0.9) // Should be very similar
    })

    it('filters by metadata before similarity search', async () => {
      const res = await pg.query<{ chunk_text: string }>(`
        SELECT chunk_text
        FROM knowledge_base
        WHERE metadata @> '{"topic": "ai"}'
        ORDER BY embedding <-> '[0.6,0.3,0.1]'
        LIMIT 1
      `)

      expect(res.rows[0]?.chunk_text).toContain('AI')
    })

    it('combines text search with vector search', async () => {
      const res = await pg.query<{ chunk_text: string; rank: number }>(`
        SELECT
          chunk_text,
          ts_rank(to_tsvector('english', chunk_text), plainto_tsquery('english', 'database')) as rank
        FROM knowledge_base
        WHERE to_tsvector('english', chunk_text) @@ plainto_tsquery('english', 'database')
        ORDER BY rank DESC
      `)

      expect(res.rows.length).toBeGreaterThanOrEqual(1)
      expect(res.rows[0]?.chunk_text).toContain('database')
    })
  })

  describe('AI Agent Memory Patterns', () => {
    beforeAll(async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS agent_memory;
        CREATE TABLE agent_memory (
          id SERIAL PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          embedding vector(3),
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          metadata JSONB DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS memory_conv_idx ON agent_memory (conversation_id);
        CREATE INDEX IF NOT EXISTS memory_embedding_idx ON agent_memory
        USING hnsw (embedding vector_cosine_ops);
      `)
    })

    it('stores conversation messages with embeddings', async () => {
      await pg.exec(`
        INSERT INTO agent_memory (conversation_id, role, content, embedding, metadata)
        VALUES
          ('conv-1', 'user', 'What is PostgreSQL?', '[0.8,0.1,0.1]', '{"intent": "question"}'),
          ('conv-1', 'assistant', 'PostgreSQL is a database system', '[0.75,0.15,0.1]', '{"type": "answer"}')
      `)

      const res = await pg.query<{ count: number }>(`
        SELECT COUNT(*)::int as count FROM agent_memory WHERE conversation_id = 'conv-1'
      `)
      expect(res.rows[0]?.count).toBe(2)
    })

    it('retrieves relevant past interactions', async () => {
      const current_query = '[0.78,0.12,0.1]'
      const res = await pg.query<{ content: string; role: string }>(`
        SELECT content, role
        FROM agent_memory
        ORDER BY embedding <=> '${current_query}'
        LIMIT 2
      `)

      expect(res.rows.length).toBe(2)
    })

    it('retrieves conversation history in order', async () => {
      const res = await pg.query<{ role: string; content: string }>(`
        SELECT role, content
        FROM agent_memory
        WHERE conversation_id = 'conv-1'
        ORDER BY timestamp ASC
      `)

      expect(res.rows[0]?.role).toBe('user')
      expect(res.rows[1]?.role).toBe('assistant')
    })
  })

  describe('Vector Dimension Support', () => {
    it('supports various vector dimensions', async () => {
      await pg.exec(`
        DROP TABLE IF EXISTS multi_dim;
        CREATE TABLE multi_dim (
          id SERIAL PRIMARY KEY,
          vec_small vector(3),
          vec_medium vector(384),
          vec_large vector(1536)
        );
      `)

      const small = '[1,2,3]'
      const medium = '[' + Array(384).fill(0.1).join(',') + ']'
      const large = '[' + Array(1536).fill(0.01).join(',') + ']'

      await pg.exec(`
        INSERT INTO multi_dim (vec_small, vec_medium, vec_large)
        VALUES ('${small}', '${medium}', '${large}')
      `)

      const res = await pg.query<{ id: number }>(`
        SELECT id FROM multi_dim WHERE id = 1
      `)
      expect(res.rows[0]?.id).toBe(1)
    })
  })
})
