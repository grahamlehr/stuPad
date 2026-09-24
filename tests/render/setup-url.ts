import { vi } from 'vitest';

let counter = 0;

export function stubObjectUrl(): { revoke: ReturnType<typeof vi.fn> } {
  const revoke = vi.fn();
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(
    () => `blob:mock-${counter++}`
  );
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = revoke;
  return { revoke };
}
