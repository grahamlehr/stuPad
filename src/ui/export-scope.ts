import type { EventFilter } from '../types';

export type ExportScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'all' };

/** Maps an admin-panel export scope choice to the EventFilter the store API expects. */
export function scopeToFilter(scope: ExportScope): EventFilter {
  switch (scope.kind) {
    case 'session':
      return { sessionId: scope.sessionId };
    case 'range':
      return { from: scope.from, to: scope.to };
    case 'all':
      return {};
  }
}
