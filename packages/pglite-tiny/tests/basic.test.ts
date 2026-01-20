import { describe, it, expect } from 'vitest'
import { PGlite, VERSION, VARIANT, TINY_MEMORY_BUDGET } from '../src/index'

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
  })

  describe('type exports', () => {
    it('should compile with type imports', () => {
      // This test verifies that the types compile correctly
      // Type assertions are compile-time only
      const variant: typeof VARIANT = 'tiny'
      const version: typeof VERSION = '0.1.0'
      expect(variant).toBe('tiny')
      expect(version).toBe('0.1.0')
    })
  })
})
