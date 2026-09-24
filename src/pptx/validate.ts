import type { Deck, Issue } from '../types';
import { SLIDE_W } from '../types';
import { isKnownFont } from './fonts';
import { ptToPx } from './geometry';

const SIXTEEN_NINE = 16 / 9;
const ASPECT_TOLERANCE = 0.01;
const MAX_BYTES = 100 * 1024 * 1024;
const MIN_BUTTON_PT = 44;

/**
 * Slides reachable from slide 1 via a home-slide button, then any chain of nav links
 * (BFS). Always includes 1. Used for `unlinked_slide`/`no_home_link`, since a slide
 * reached only through a further nav link (e.g. Home -> slide 2 -> "Next" -> slide 3)
 * is still "linked" even though slide 1 has no button pointing at it directly.
 */
function reachableSlides(deck: Deck): Set<number> {
  const navBySource = new Map<number, number[]>();
  for (const n of deck.navLinks ?? []) {
    const list = navBySource.get(n.slide) ?? [];
    list.push(n.targetSlide);
    navBySource.set(n.slide, list);
  }

  const visited = new Set<number>([1]);
  const queue: number[] = [1, ...deck.buttons.map((b) => b.targetSlide)];
  for (const s of deck.buttons.map((b) => b.targetSlide)) visited.add(s);

  while (queue.length > 0) {
    const slide = queue.shift()!;
    for (const next of navBySource.get(slide) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

/**
 * Deck-level checks that need only the parsed `Deck` model — no zip, no file bytes. Safe to
 * re-run against a deck loaded straight from storage (e.g. when Setup re-opens with a stored
 * deck), unlike `too_large` (needs the original file size) and `broken_link` (only detectable
 * while parsing the raw XML — a link that couldn't be resolved never becomes part of the Deck
 * model in the first place, so there is nothing left in `deck` to check).
 */
export function validateDeck(deck: Deck): Issue[] {
  const issues: Issue[] = [];
  if (deck.slides.length === 0) return issues;

  const aspect = deck.slideWidthEmu / deck.slideHeightEmu;
  if (Math.abs(aspect - SIXTEEN_NINE) > ASPECT_TOLERANCE) {
    issues.push({ severity: 'warning', code: 'non_16_9', message: `Slide size is not 16:9 (got ${aspect.toFixed(3)}:1); it will be letterboxed` });
  }

  if (deck.buttons.length < 2) {
    issues.push({ severity: 'error', code: 'too_few_buttons', message: `Slide 1 has ${deck.buttons.length} button(s); at least 2 are required`, slide: 1 });
  }

  const minButtonPx = ptToPx(MIN_BUTTON_PT, deck.slideWidthEmu, SLIDE_W);
  for (const b of deck.buttons) {
    if (b.bounds.w < minButtonPx || b.bounds.h < minButtonPx) {
      issues.push({
        severity: 'warning',
        code: 'small_button',
        message: `Button "${b.defaultLabel}" is smaller than the 44pt accessibility minimum`,
        slide: 1,
      });
    }
  }

  // A "Last Slide Viewed" link always leads somewhere (the previous slide, or Home when
  // there is none), so it counts as a way back for no_home_link. It never makes a slide
  // reachable: its target is only known at run time.
  const homeLinkSlides = new Set([...deck.homeLinks, ...(deck.backLinks ?? [])].map((h) => h.slide));
  const reachable = reachableSlides(deck);

  for (const slide of reachable) {
    if (slide === 1) continue;
    if (!homeLinkSlides.has(slide)) {
      // A slide reachable only via a chain of nav links still needs a way home; the
      // kiosk falls back to a synthesized Home button and the idle timeout, so this
      // stays a warning rather than an error.
      issues.push({ severity: 'warning', code: 'no_home_link', message: `Slide ${slide} has no shape linking back to slide 1`, slide });
    }
  }

  for (const slide of deck.slides) {
    if (slide.index === 1) continue;
    if (!reachable.has(slide.index)) {
      issues.push({ severity: 'warning', code: 'unlinked_slide', message: `Slide ${slide.index} is not linked from slide 1`, slide: slide.index });
    }
  }

  for (const font of deck.fonts) {
    if (!isKnownFont(font)) {
      issues.push({ severity: 'warning', code: 'missing_font', message: `Font "${font}" is not a bundled or system font and will fall back` });
    }
  }

  return issues;
}

/**
 * Full validation run at parse time: file-size and empty-deck checks (which need the raw
 * file size and can't be re-derived from a stored `Deck`) plus every `validateDeck` check.
 */
export function validateDeckAndSize(deck: Deck, fileSizeBytes: number): Issue[] {
  const issues: Issue[] = [];

  if (fileSizeBytes > MAX_BYTES) {
    issues.push({ severity: 'error', code: 'too_large', message: `File is ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB, which exceeds the 100 MB limit` });
  }

  if (deck.slides.length === 0) {
    issues.push({ severity: 'error', code: 'no_slides', message: 'The presentation has no slides' });
    return issues;
  }

  issues.push(...validateDeck(deck));
  return issues;
}
