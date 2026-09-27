/**
 * Shared contracts between modules. Every module codes against these types.
 * Change only with care: parser, renderer, kiosk, store, report and UI all depend on them.
 *
 * Geometry convention: all positions/sizes are in "slide px". The slide is always
 * SLIDE_W (1920) px wide; its height is 1920 * slideHeightEmu / slideWidthEmu
 * (1080 for a 16:9 deck). The renderer scales/letterboxes this canvas to the screen.
 */

export const SLIDE_W = 1920;
/** EMU per inch; 1 pt = 12700 EMU. */
export const EMU_PER_INCH = 914400;

// ---------------------------------------------------------------- deck model

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Xfrm extends Rect {
  /** degrees clockwise */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/** CSS colour string, e.g. "#1a2b3c" or "rgba(26,43,60,0.5)". Theme/scheme colours are resolved by the parser. */
export type Color = string;

export type Fill =
  | { type: 'none' }
  | { type: 'solid'; color: Color }
  | { type: 'gradient'; kind: 'linear' | 'radial'; angle: number; stops: { pos: number; color: Color }[] }
  | { type: 'image'; mediaKey: string; mode: 'stretch' | 'tile' };

export interface Line {
  color: Color;
  /** slide px */
  width: number;
  dash?: 'solid' | 'dash' | 'dot';
}

export interface TextRun {
  text: string;
  /** resolved font family (theme fonts like +mn-lt resolved) */
  font: string;
  /** slide px (pt * SLIDE_W / slideWidthPt) */
  size: number;
  color: Color;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** hyperlink on the run itself (rare) */
  link?: SlideLink;
}

export interface Paragraph {
  align: 'left' | 'center' | 'right' | 'justify';
  level: number;
  bullet?: { type: 'char'; char: string; color?: Color } | { type: 'autoNum'; scheme: string; startAt: number };
  /** multiplier, 1 = single */
  lineSpacing: number;
  /** slide px */
  spaceBefore: number;
  spaceAfter: number;
  /** slide px, left margin incl. level indent */
  marginLeft: number;
  indent: number;
  runs: TextRun[];
  /** true for an empty paragraph (still takes a line at endParaRPr size) */
  emptySize?: number;
}

export interface TextBody {
  paragraphs: Paragraph[];
  anchor: 'top' | 'middle' | 'bottom';
  /** slide px insets */
  inset: { l: number; t: number; r: number; b: number };
  wrap: boolean;
  vertical?: boolean;
}

/** A PowerPoint click action. Only slide jumps matter to us. */
export interface SlideLink {
  /** 1-based target slide index; 0 when `back` is set (the target is only known at run time) */
  targetSlide: number;
  /**
   * PowerPoint's "Last Slide Viewed" action (`ppaction://hlinkshowjump?jump=lastslideviewed`):
   * go back to whichever slide the visitor came from. Becomes a BackLinkDef, never a
   * button, Home link or nav link.
   */
  back?: boolean;
}

interface ElementBase {
  /** cNvPr id from the PPTX (unique per slide) */
  id: string;
  /** cNvPr name (Selection Pane name) */
  name: string;
  xfrm: Xfrm;
  /**
   * click action from cNvPr/a:hlinkClick: either `ppaction://hlinksldjump` (an explicit
   * "Link to: Slide N") or `ppaction://hlinkshowjump?jump=...` (firstslide/lastslide/
   * nextslide/previousslide, resolved relative to the shape's own slide and clamped to
   * the deck — see `resolveLink` in src/pptx/shapes.ts). Both forms end up as a plain
   * 1-based target slide index; callers don't need to distinguish them. The one
   * exception is `jump=lastslideviewed`, which sets `back` instead (see SlideLink).
   */
  link?: SlideLink;
  hidden?: boolean;
}

export interface ShapeElement extends ElementBase {
  kind: 'shape';
  /** preset geometry; unknown presets fall back to 'rect' and produce a warning */
  geom: 'rect' | 'roundRect' | 'ellipse' | 'line' | 'other';
  /** roundRect radius in slide px */
  cornerRadius?: number;
  fill: Fill;
  line?: Line;
  text?: TextBody;
}

export interface PictureElement extends ElementBase {
  kind: 'picture';
  mediaKey: string;
  /** srcRect crop as fractions 0..1 of the source image */
  crop?: { l: number; t: number; r: number; b: number };
  line?: Line;
}

export interface GroupElement extends ElementBase {
  kind: 'group';
  /** children already transformed into slide px coordinates (group child offsets applied) */
  children: SlideElement[];
}

export interface TableCell {
  text?: TextBody;
  fill: Fill;
  gridSpan?: number;
  rowSpan?: number;
  /** true for cells covered by a span */
  merged?: boolean;
}

export interface TableElement extends ElementBase {
  kind: 'table';
  /** slide px */
  colWidths: number[];
  rowHeights: number[];
  rows: TableCell[][];
}

export type SlideElement = ShapeElement | PictureElement | GroupElement | TableElement;

export interface Slide {
  /** 1-based */
  index: number;
  /** resolved: slide bg, else layout bg, else master bg */
  background: Fill;
  /** layout + master shapes that are visible on this slide (non-placeholder), then slide shapes, in z-order */
  elements: SlideElement[];
  /** Optional pre-rasterised PNG (fallback rendering mode). Key into Deck.media. */
  rasterKey?: string;
}

export interface MediaItem {
  blob: Blob;
  mime: string;
}

export interface ButtonDef {
  /** shape id on the home slide (top-level element id, even if the link is inside a group) */
  id: string;
  /** Selection Pane name, e.g. BTN_Sustainability */
  shapeName: string;
  /** concatenated text of the shape, trimmed */
  text: string;
  /** default label per spec: shape name (if not a PowerPoint default like "Rectangle 3"), else text, else "Button N" */
  defaultLabel: string;
  targetSlide: number;
  /** hit area in slide px (unrotated bounding box) */
  bounds: Rect;
}

/** A shape on a destination slide that links back to slide 1. */
export interface HomeLinkDef {
  slide: number;
  id: string;
  bounds: Rect;
}

/**
 * A shape on a non-home slide that links onward to some slide other than slide 1 and
 * other than its own slide (a "Next" / "Back" / etc. link, as opposed to a HomeLinkDef).
 */
export interface NavLinkDef {
  slide: number;
  id: string;
  /** Selection Pane name, e.g. BTN_Next */
  shapeName: string;
  /** default label per the same rule as ButtonDef.defaultLabel */
  label: string;
  targetSlide: number;
  bounds: Rect;
}

/**
 * A shape on a non-home slide with PowerPoint's "Last Slide Viewed" action: the kiosk
 * returns to the slide the visitor was on before this one (or to Home if they came
 * straight from slide 1).
 */
export interface BackLinkDef {
  slide: number;
  id: string;
  /** Selection Pane name, e.g. BTN_Back */
  shapeName: string;
  /** default label per the same rule as ButtonDef.defaultLabel */
  label: string;
  bounds: Rect;
}

/**
 * A `VOTE_<poll>_<choice>` or `RATE_<poll>_<choice>` shape (SPEC "PowerPoint template
 * rules"): a poll or rating option that may sit on any slide, including the home slide.
 * `poll` and `choice` are the raw, stable ids (as written in the shape name); a poll name
 * can't contain underscores (the segment right after the prefix, up to the next `_`), but
 * a choice name may (everything after that). `kind` reflects the shape's own prefix
 * (`VOTE_` or `RATE_`, case-insensitive); when a poll mixes both prefixes across its
 * options, callers (see `src/report/stats.ts`) treat the whole poll as `'vote'` and
 * `validateDeck` raises a `poll_mixed_kind` warning — `kind` here is never rewritten.
 */
export interface PollOptionDef {
  slide: number;
  /** shape id (or the group's id, for a group named VOTE_/RATE_) */
  id: string;
  /** Selection Pane name, e.g. VOTE_Topic_Sustainability */
  shapeName: string;
  /** raw poll segment, e.g. "Topic" */
  poll: string;
  /** raw choice segment, e.g. "Net_Zero" (may contain underscores) */
  choice: string;
  kind: 'vote' | 'rate';
  /** display label from the choice segment, prettified (underscores/hyphens to spaces) */
  label: string;
  bounds: Rect;
  /** true when the shape (or its group) has any link, including a "Last Slide Viewed" back link */
  linked: boolean;
  /** set only when `linked` is a slide jump (undefined for an unlinked option or a back link) */
  targetSlide?: number;
}

/** Builds the `KioskConfig.pollLabels` key for one poll choice; `\u0000` can't appear in a
 * shape name, so this is unambiguous even though poll/choice names may contain punctuation. */
export function pollLabelKey(poll: string, choice: string): string {
  return `${poll}\u0000${choice}`;
}

export interface Deck {
  /** uuid assigned at parse time */
  id: string;
  fileName: string;
  parsedAt: string;
  slideWidthEmu: number;
  slideHeightEmu: number;
  /** slide px height, see SLIDE_W */
  height: number;
  slides: Slide[];
  /** home-slide buttons in reading order (top-to-bottom, then left-to-right) */
  buttons: ButtonDef[];
  homeLinks: HomeLinkDef[];
  /**
   * Shapes on non-home slides that link onward to a further slide (not slide 1, not
   * their own slide). Decks stored before this field existed won't have it — treat a
   * missing value as `[]` (`deck.navLinks ?? []`) rather than assuming it's present.
   */
  navLinks: NavLinkDef[];
  /**
   * "Last Slide Viewed" shapes on non-home slides. Like navLinks, decks stored before this
   * field existed won't have it; the store normalises a missing value to `[]`.
   */
  backLinks: BackLinkDef[];
  /**
   * Poll/rating options anywhere in the deck (see `PollOptionDef`). Decks stored before
   * this field existed won't have it; the store normalises a missing value to `[]`.
   */
  pollOptions: PollOptionDef[];
  /** mediaKey -> media (images, rasters). Keys are zip paths like "ppt/media/image1.png" or "raster/3.png" */
  media: Record<string, MediaItem>;
  /** font families used in the deck */
  fonts: string[];
}

export interface Issue {
  severity: 'error' | 'warning';
  code:
    | 'unreadable_file'
    | 'too_few_buttons'
    | 'broken_link'
    | 'no_slides'
    | 'unlinked_slide'
    | 'missing_font'
    | 'unsupported_element'
    | 'non_16_9'
    | 'no_home_link'
    | 'too_large'
    | 'small_button'
    | 'self_link'
    | 'poll_single_option'
    | 'poll_duplicate_choice'
    | 'poll_bad_rating'
    | 'poll_mixed_kind';
  message: string;
  slide?: number;
}

export interface ParseResult {
  /** undefined only if the file could not be read at all */
  deck?: Deck;
  issues: Issue[];
}

// ---------------------------------------------------------------- config

export type SecretPattern = 'corners_cw' | 'corners_ccw' | 'tl3_br2';
export type PressFeedback = 'none' | 'highlight' | 'scale';

export interface KioskConfig {
  sessionName: string;
  /** buttonId -> admin-edited label */
  buttonLabels: Record<string, string>;
  /**
   * Admin-renamed poll/rating choice labels, keyed by `pollLabelKey(poll, choice)`. Configs
   * saved before this field existed won't have it; the store normalises a missing value to
   * `{}`. Reset to `{}` whenever a new deck is loaded, like `buttonLabels`.
   */
  pollLabels: Record<string, string>;
  /** seconds, 5..300; null = off */
  timeoutSec: number | null;
  returnMethods: { homeButton: boolean; tapAnywhere: boolean; timeout: boolean };
  idleWarning: boolean;
  pressFeedback: PressFeedback;
  transition: 'none' | 'fade';
  transitionMs: number;
  debounceMs: number;
  secretPattern: SecretPattern;
  /** ms allowed to complete the secret sequence */
  secretWindowMs: number;
  /** 4-6 digits, or null for off */
  adminPin: string | null;
  /** fallback: show pre-rasterised images instead of DOM rendering */
  useRaster: boolean;
  /**
   * Pulsing glow around every tappable area in kiosk mode. Configs saved before this field
   * existed won't have it; the store normalises a missing value to `defaultGlow()`.
   */
  glow: GlowConfig;
  /**
   * Free text identifying which physical iPad this is (e.g. "Stand A"), printed in the PDF
   * header so reports from different stands can be told apart. Describes the device, not the
   * deck, so loading a new deck keeps the previous value instead of resetting it (the one
   * exception to "loading a new deck resets every setting to its default", see SPEC). Configs
   * saved before this field existed won't have it; the store normalises a missing value to `''`.
   */
  deviceName: string;
  /**
   * Draws people in when nobody has touched the kiosk for a while (SPEC "Kiosk mode
   * behaviour"). Off by default. Configs saved before this field existed won't have it; the
   * store normalises a missing value to `defaultAttract()`. Deck-specific (like every other
   * setting except `deviceName`): loading a new deck resets it to the default.
   */
  attract: AttractConfig;
}

export interface AttractConfig {
  enabled: boolean;
  /** seconds of idle time on Home before the loop starts, 15..600 */
  idleSec: number;
  /** cycle: crossfades through `slides` (plus Home); pulse: stays on Home with a stronger glow */
  mode: 'cycle' | 'pulse';
  /** slide numbers (2+) to include when cycling, in addition to Home, which is always included */
  slides: number[];
  /** seconds each slide is shown before advancing, cycle mode only, 3..60 */
  slideSec: number;
}

export function defaultAttract(): AttractConfig {
  return { enabled: false, idleSec: 60, mode: 'cycle', slides: [], slideSec: 6 };
}

export interface GlowConfig {
  enabled: boolean;
  /** "#rrggbb" */
  color: string;
  /** GLOW_INTENSITY_MIN..GLOW_INTENSITY_MAX: size and brightness of the glow */
  intensity: number;
  /** ms for one full pulse (dim -> bright -> dim), GLOW_PERIOD_MIN_MS..GLOW_PERIOD_MAX_MS */
  periodMs: number;
}

export const GLOW_INTENSITY_MIN = 1;
export const GLOW_INTENSITY_MAX = 10;
export const GLOW_PERIOD_MIN_MS = 500;
export const GLOW_PERIOD_MAX_MS = 4000;

export function defaultGlow(): GlowConfig {
  return { enabled: false, color: '#ffffff', intensity: 5, periodMs: 2000 };
}

export function defaultConfig(fileName: string, now = new Date()): KioskConfig {
  const date = now.toISOString().slice(0, 10);
  return {
    sessionName: `${fileName.replace(/\.pptx$/i, '')} ${date}`,
    buttonLabels: {},
    pollLabels: {},
    timeoutSec: 20,
    returnMethods: { homeButton: true, tapAnywhere: false, timeout: true },
    idleWarning: false,
    pressFeedback: 'highlight',
    transition: 'fade',
    transitionMs: 300,
    debounceMs: 800,
    secretPattern: 'corners_cw',
    secretWindowMs: 5000,
    adminPin: null,
    useRaster: false,
    glow: defaultGlow(),
    deviceName: '',
    attract: defaultAttract(),
  };
}

// ---------------------------------------------------------------- persisted kiosk state

export interface KioskState {
  running: boolean;
  sessionId: string | null;
  startedAt: string | null;
}

// ---------------------------------------------------------------- event log

export type EventType =
  | 'kiosk_start'
  | 'kiosk_stop'
  | 'button_press'
  | 'return_home'
  | 'miss_tap'
  | 'app_resume'
  | 'admin_unlock_fail'
  | 'log_cleared'
  | 'slide_nav'
  | 'heartbeat'
  | 'attract_start'
  | 'attract_end'
  | 'vote';

export type ReturnMethod = 'home_button' | 'tap' | 'timeout';

/** One append-only log record. Optional fields are omitted when not applicable. */
export interface LogEvent {
  /** auto-increment, assigned by the store */
  id?: number;
  /** ISO 8601 with local offset, e.g. 2026-10-14T10:32:07.412+01:00 */
  ts: string;
  session_id: string;
  visit_id?: string;
  event: EventType;
  button_id?: string;
  button_label?: string;
  slide_from?: number;
  slide_to?: number;
  method?: ReturnMethod;
  dwell_ms?: number;
  /** % of slide width/height, miss taps only */
  x?: number;
  y?: number;
  /** poll name, `vote` events only */
  poll?: string;
  /** choice name, `vote` events only */
  choice?: string;
}

export const CSV_COLUMNS = [
  'id', 'ts', 'session_id', 'visit_id', 'event', 'button_id', 'button_label',
  'slide_from', 'slide_to', 'method', 'dwell_ms', 'x', 'y', 'poll', 'choice',
] as const;

export interface EventFilter {
  sessionId?: string;
  /** inclusive ISO bounds, compared by instant */
  from?: string;
  to?: string;
}
