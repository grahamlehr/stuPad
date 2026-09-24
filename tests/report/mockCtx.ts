import { vi } from 'vitest';

/** A minimal recording stub for CanvasRenderingContext2D, since jsdom has no real canvas. */
export interface MockCtx {
  ctx: CanvasRenderingContext2D;
  calls: Array<{ method: string; args: unknown[] }>;
  callCount: (method: string) => number;
}

export function makeMockCtx(): MockCtx {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const methodNames = [
    'save',
    'restore',
    'fillRect',
    'strokeRect',
    'clearRect',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arc',
    'fill',
    'stroke',
    'fillText',
    'strokeText',
    'rect',
    'scale',
    'translate',
    'measureText',
  ];
  const ctx: Record<string, unknown> = {
    // settable properties
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
  };
  for (const name of methodNames) {
    ctx[name] = vi.fn((...args: unknown[]) => {
      calls.push({ method: name, args });
      if (name === 'measureText') return { width: 40 };
      return undefined;
    });
  }
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    calls,
    callCount: (method: string) => calls.filter((c) => c.method === method).length,
  };
}
