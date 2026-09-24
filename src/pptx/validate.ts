import type { Deck, Issue } from '../types';
import { SLIDE_W } from '../types';
import { isKnownFont } from './fonts';
import { ptToPx } from './geometry';

const SIXTEEN_NINE = 16 / 9;
const ASPECT_TOLERANCE = 0.01;
const MAX_BYTES = 100 * 1024 * 1024;
const MIN_BUTTON_PT = 44;

export function validateDeck(deck: Deck, fileSizeBytes: number): Issue[] {
  const issues: Issue[] = [];

  if (fileSizeBytes > MAX_BYTES) {
    issues.push({ severity: 'error', code: 'too_large', message: `File is ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB, which exceeds the 100 MB limit` });
  }

  if (deck.slides.length === 0) {
    issues.push({ severity: 'error', code: 'no_slides', message: 'The presentation has no slides' });
    return issues;
  }

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

  const targetSlides = new Set(deck.buttons.map((b) => b.targetSlide));
  const homeLinkSlides = new Set(deck.homeLinks.map((h) => h.slide));

  for (const target of targetSlides) {
    if (!homeLinkSlides.has(target)) {
      issues.push({ severity: 'warning', code: 'no_home_link', message: `Slide ${target} has no shape linking back to slide 1`, slide: target });
    }
  }

  for (const slide of deck.slides) {
    if (slide.index === 1) continue;
    if (!targetSlides.has(slide.index)) {
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
