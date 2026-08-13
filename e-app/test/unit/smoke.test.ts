import { describe, it, expect } from 'vitest'
import { suggestNextNumber } from '../../src/core/invoicing/invoice-number.js'

describe('harness', () => {
  it('runs, and stubs throw so tests start RED', () => {
    expect(() => suggestNextNumber('0007/2026')).toThrow('not implemented')
  })
})
