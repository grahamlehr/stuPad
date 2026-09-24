/**
 * Colour-blind-friendly categorical palette (Okabe-Ito based, extended to 10).
 * Ordering is stable and consistent across every chart: index i always maps
 * to the same colour, and callers pass buttons in deck order so a given
 * button gets the same colour on every page of the report.
 */
const PALETTE = [
  '#E69F00', // orange
  '#56B4E9', // sky blue
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#CC79A7', // reddish purple
  '#999999', // grey
  '#44AA99', // teal
  '#882255', // wine
] as const;

/** Deterministic colour for the i-th button (0-based), wrapping if there are more than 10. */
export function buttonColor(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export const PALETTE_SIZE = PALETTE.length;

/**
 * Neutral, deliberately un-categorical colours for the three return methods
 * (Home button / Tap / Timeout). Kept visually distinct from `PALETTE` above
 * so a return-method chart never reuses a colour a nearby button chart
 * assigned to an actual button.
 */
const RETURN_METHOD_PALETTE: Record<'home_button' | 'tap' | 'timeout', string> = {
  home_button: '#3B5169', // slate blue-grey
  tap: '#8A8D91', // neutral grey
  timeout: '#A15C2E', // burnt sienna
};

/** Deterministic colour for a return method, distinct from every `buttonColor(i)`. */
export function returnMethodColor(method: 'home_button' | 'tap' | 'timeout'): string {
  return RETURN_METHOD_PALETTE[method];
}
