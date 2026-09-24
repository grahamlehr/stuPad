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
