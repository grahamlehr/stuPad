import { describe, it, expect } from 'vitest';
import { scopeToFilter } from '../../src/ui/export-scope';

describe('scopeToFilter', () => {
  it('maps session scope to a sessionId filter', () => {
    expect(scopeToFilter({ kind: 'session', sessionId: 'abc' })).toEqual({ sessionId: 'abc' });
  });

  it('maps range scope to a from/to filter', () => {
    expect(scopeToFilter({ kind: 'range', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })).toEqual({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
    });
  });

  it('maps all scope to an empty filter', () => {
    expect(scopeToFilter({ kind: 'all' })).toEqual({});
  });
});
