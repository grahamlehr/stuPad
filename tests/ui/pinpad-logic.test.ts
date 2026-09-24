import { describe, it, expect } from 'vitest';
import { PinPadState } from '../../src/ui/pinpad-logic';

describe('PinPadState', () => {
  it('accepts the correct PIN', () => {
    const state = new PinPadState('1234');
    expect(state.submit('1234')).toBe('success');
  });

  it('reports fail on a wrong PIN below the attempt limit', () => {
    const state = new PinPadState('1234', 3);
    expect(state.submit('0000')).toBe('fail');
    expect(state.attemptCount).toBe(1);
  });

  it('locks out after the max attempts', () => {
    const state = new PinPadState('1234', 3);
    expect(state.submit('0000')).toBe('fail');
    expect(state.submit('0001')).toBe('fail');
    expect(state.submit('0002')).toBe('locked');
  });

  it('a correct PIN after some failures still succeeds', () => {
    const state = new PinPadState('9999', 3);
    expect(state.submit('1111')).toBe('fail');
    expect(state.submit('9999')).toBe('success');
  });

  it('reset() clears the attempt counter', () => {
    const state = new PinPadState('1234', 3);
    state.submit('0000');
    state.submit('0000');
    state.reset();
    expect(state.attemptCount).toBe(0);
    expect(state.submit('0000')).toBe('fail');
  });
});
