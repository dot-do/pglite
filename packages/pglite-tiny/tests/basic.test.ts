import { describe, it, expect } from 'vitest'
import {
  PGlite,
  VERSION,
  VARIANT,
  TINY_MEMORY_BUDGET,
  BUILD_CONFIG,
  uuid,
  formatQuery,
  MemoryFS,
  IdbFs,
} from '../src/index'
import type { Variant, TinyMemoryBudget, BuildConfig } from '../src/index'

describe('@dotdo/pglite-tiny', () => {
  describe('exports', () => {
    it('should export VERSION constant', () => {
      expect(VERSION).toBe('0.1.0')
    })

    it('should export VARIANT constant', () => {
      expect(VARIANT).toBe('tiny')
    })

    it('should export TINY_MEMORY_BUDGET with correct values', () => {
      expect(TINY_MEMORY_BUDGET).toHaveProperty('wasmBinary')
      expect(TINY_MEMORY_BUDGET).toHaveProperty('dataBundle')
      expect(TINY_MEMORY_BUDGET).toHaveProperty('postgresRuntime')
      expect(TINY_MEMORY_BUDGET).toHaveProperty('availableForApp')
      expect(TINY_MEMORY_BUDGET).toHaveProperty('workersLimit')
      expect(TINY_MEMORY_BUDGET.workersLimit).toBe(128 * 1024 * 1024)
      expect(TINY_MEMORY_BUDGET.wasmBinary).toBe(3 * 1024 * 1024)
      expect(TINY_MEMORY_BUDGET.dataBundle).toBe(2 * 1024 * 1024)
    })

    it('should export PGlite class', () => {
      expect(PGlite).toBeDefined()
      expect(typeof PGlite).toBe('function')
    })

    it('should have PGlite with expected static methods', () => {
      // Verify the class has the expected API shape
      expect(PGlite.prototype).toBeDefined()
      expect(typeof PGlite.prototype.query).toBe('function')
      expect(typeof PGlite.prototype.exec).toBe('function')
      expect(typeof PGlite.prototype.transaction).toBe('function')
      expect(typeof PGlite.prototype.close).toBe('function')
    })

    it('should export BUILD_CONFIG with build settings', () => {
      expect(BUILD_CONFIG).toHaveProperty('PGLITE_TINY', true)
      expect(BUILD_CONFIG).toHaveProperty('PGLITE_UTF8_ONLY', true)
      expect(BUILD_CONFIG).toHaveProperty('SKIP_CONTRIB', true)
      expect(BUILD_CONFIG).toHaveProperty('SNOWBALL_LANGUAGES', '')
      expect(BUILD_CONFIG).toHaveProperty('TOTAL_MEMORY', '32MB')
      expect(BUILD_CONFIG).toHaveProperty('CMA_MB', 4)
    })

    it('should export uuid utility function', () => {
      expect(uuid).toBeDefined()
      expect(typeof uuid).toBe('function')
      const id = uuid()
      expect(typeof id).toBe('string')
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    })

    it('should export formatQuery utility function', () => {
      expect(formatQuery).toBeDefined()
      expect(typeof formatQuery).toBe('function')
    })

    it('should export filesystem implementations', () => {
      expect(MemoryFS).toBeDefined()
      expect(IdbFs).toBeDefined()
    })
  })

  describe('type exports', () => {
    it('should compile with type imports', () => {
      // This test verifies that the types compile correctly
      // Type assertions are compile-time only
      const variant: Variant = 'tiny'
      const version: typeof VERSION = '0.1.0'
      expect(variant).toBe('tiny')
      expect(version).toBe('0.1.0')
    })

    it('should have correct TinyMemoryBudget type', () => {
      const budget: TinyMemoryBudget = TINY_MEMORY_BUDGET
      expect(budget.workersLimit).toBe(128 * 1024 * 1024)
    })

    it('should have correct BuildConfig type', () => {
      const config: BuildConfig = BUILD_CONFIG
      expect(config.PGLITE_TINY).toBe(true)
    })
  })
})
