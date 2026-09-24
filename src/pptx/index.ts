import type { ParseResult, Issue } from '../types';
import { Pkg } from './zip';
import { loadDeck } from './deck';
import { detectBackLinks, detectButtons, detectHomeLinks, detectNavLinks } from './buttons';
import { validateDeckAndSize } from './validate';

export { KNOWN_FONTS } from './fonts';
export { validateDeck } from './validate';

/**
 * Parse a .pptx file into the shared Deck model (src/types.ts).
 *
 * Never throws: an unreadable file produces `{ deck: undefined, issues: [unreadable_file] }`.
 */
export async function parsePptx(input: Blob | ArrayBuffer, fileName: string): Promise<ParseResult> {
  const sizeBytes = input instanceof Blob ? input.size : input.byteLength;

  let pkg: Pkg;
  try {
    pkg = await Pkg.load(input);
  } catch (e) {
    return {
      issues: [{ severity: 'error', code: 'unreadable_file', message: `Could not open "${fileName}" as a .pptx file: ${(e as Error).message}` }],
    };
  }

  let deck;
  let issues: Issue[];
  try {
    const result = await loadDeck(pkg, fileName);
    deck = result.deck;
    issues = result.issues;
  } catch (e) {
    return {
      issues: [{ severity: 'error', code: 'unreadable_file', message: `Could not parse "${fileName}": ${(e as Error).message}` }],
    };
  }

  if (deck.slides.length === 0) {
    return { deck, issues };
  }

  const home = deck.slides[0];
  deck.buttons = detectButtons(home.elements);

  const homeLinks = [];
  const navLinks = [];
  const backLinks = [];
  const navLinkIssues: Issue[] = [];
  for (const slide of deck.slides.slice(1)) {
    homeLinks.push(...detectHomeLinks(slide.index, slide.elements));
    navLinks.push(...detectNavLinks(slide.index, slide.elements, navLinkIssues));
    backLinks.push(...detectBackLinks(slide.index, slide.elements));
  }
  deck.homeLinks = homeLinks;
  deck.navLinks = navLinks;
  deck.backLinks = backLinks;
  issues.push(...navLinkIssues);

  const validationIssues = validateDeckAndSize(deck, sizeBytes);

  return { deck, issues: [...issues, ...validationIssues] };
}
