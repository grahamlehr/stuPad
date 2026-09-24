#!/usr/bin/env node
/**
 * Builds public/template.pptx (the downloadable, "good" template) using pptxgenjs,
 * and writes test fixtures to tests/fixtures/:
 *   good.pptx           - same design as the template (copy)
 *   one-button.pptx      - only 1 button on the home slide -> too_few_buttons error
 *   with-image.pptx      - image + gradient background
 *   broken-link.pptx     - crafted from good.pptx with a rels target pointed at nothing
 *   grouped-button.pptx  - crafted from good.pptx: two shapes wrapped in a group that
 *                          carries the hyperlink (group-as-button)
 *   multi-slide.pptx     - home (2 buttons) -> destination slides that link onward:
 *                          an explicit slide-link "Next", a `nextslide`-action "Next"
 *                          (patched in via JSZip; pptxgenjs can't emit hlinkshowjump),
 *                          a self-link (authoring mistake -> self_link warning), and a
 *                          Terms slide whose Back shape uses `lastslideviewed`
 *
 * Run: npm run template
 */
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');

const FONT = 'Helvetica Neue';
const NAVY = '1B2A4A';
const ACCENT = '2E7D6B';
const LIGHT = 'F5F3EE';
const WHITE = 'FFFFFF';

const BUTTONS = [
  { name: 'BTN_Sustainability', label: 'Sustainability', slide: 2, color: '2E7D6B' },
  { name: 'BTN_Innovation', label: 'Innovation', slide: 3, color: '2E5D8A' },
  { name: 'BTN_People', label: 'People', slide: 4, color: '8A5D2E' },
  { name: 'BTN_Contact', label: 'Contact', slide: 5, color: '7A2E5D' },
];

/** Build the "good" 6-slide deck (home + 4 destinations + an unlinked info slide). */
function buildGoodDeck() {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'STUPAD_16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'STUPAD_16x9';
  pptx.author = 'stuPad';
  pptx.title = 'stuPad Template';

  // ---- Slide 1: Home ----
  const home = pptx.addSlide();
  home.background = { color: NAVY };
  home.addText('stuPad Kiosk Template', {
    x: 0.6, y: 0.5, w: 12.13, h: 1.0,
    fontFace: FONT, fontSize: 32, bold: true, color: WHITE, align: 'left',
  });
  home.addText('Tap a topic to explore', {
    x: 0.6, y: 1.35, w: 12.13, h: 0.5,
    fontFace: FONT, fontSize: 16, color: 'C8CEDB', align: 'left',
  });

  const btnW = 2.7, btnH = 2.2, gap = 0.35;
  const totalW = BUTTONS.length * btnW + (BUTTONS.length - 1) * gap;
  const startX = (13.333 - totalW) / 2;
  const btnY = 2.6;

  BUTTONS.forEach((b, i) => {
    home.addText(b.label, {
      x: startX + i * (btnW + gap), y: btnY, w: btnW, h: btnH,
      shape: pptx.ShapeType.roundRect, rectRadius: 0.12,
      fill: { color: b.color }, line: { color: WHITE, width: 1 },
      fontFace: FONT, fontSize: 20, bold: true, color: WHITE,
      align: 'center', valign: 'middle',
      objectName: b.name,
      hyperlink: { slide: b.slide },
    });
  });

  home.addText('stuPad · offline kiosk', {
    x: 0.6, y: 7.05, w: 6, h: 0.35,
    fontFace: FONT, fontSize: 10, color: '8892A6',
  });

  // ---- Slides 2-5: destinations ----
  const destSlides = [];
  BUTTONS.forEach((b) => {
    const s = pptx.addSlide();
    s.background = { color: LIGHT };
    s.addText(b.label, {
      x: 0.6, y: 0.5, w: 12.13, h: 1.0,
      fontFace: FONT, fontSize: 30, bold: true, color: NAVY,
    });
    s.addText(
      `This is the ${b.label} destination slide. It demonstrates text, a solid background ` +
      `and a Home link back to slide 1.`,
      {
        x: 0.6, y: 1.7, w: 9.5, h: 2,
        fontFace: FONT, fontSize: 16, color: '333333', valign: 'top',
      }
    );
    s.addText('Home', {
      x: 0.6, y: 6.5, w: 1.8, h: 0.6,
      shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
      fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
      align: 'center', valign: 'middle',
      objectName: 'BTN_Home',
      hyperlink: { slide: 1 },
    });
    destSlides.push(s);
  });

  // ---- Slide 6: rules info (unlinked from home; flagged as a warning, not an error) ----
  const info = pptx.addSlide();
  info.background = { color: WHITE };
  info.addText('Template rules (this slide is not linked from Home)', {
    x: 0.6, y: 0.4, w: 12.1, h: 0.6, fontFace: FONT, fontSize: 20, bold: true, color: NAVY,
  });
  const rules = [
    'Slide 1 is the home slide and must contain at least 2 button shapes.',
    'Each button links to a later slide via Insert > Link > Place in This Document > Slide N.',
    'Destination slides should include a shape linked back to slide 1 ("Home").',
    'Slides not linked from slide 1 are ignored (flagged as a warning).',
    'Use system or bundled fonts only; anything else is flagged at setup.',
  ];
  info.addText(rules.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), {
    x: 0.8, y: 1.2, w: 11.5, h: 4, fontFace: FONT, fontSize: 14, color: '333333',
  });

  // ---- Slide 7: chained onward from Sustainability (slide 2) via a "Next" button ----
  // Demonstrates that destination slides can link onward to further slides, not just
  // back to Home: slide 2 gets a "Next" button targeting this slide, and this slide has
  // both a "Home" and a "Back" (to slide 2), so it works as a self-contained loop too.
  const more = pptx.addSlide();
  more.background = { color: LIGHT };
  more.addText('Sustainability (continued)', {
    x: 0.6, y: 0.5, w: 12.13, h: 1.0,
    fontFace: FONT, fontSize: 30, bold: true, color: NAVY,
  });
  more.addText(
    'A second slide chained from the Sustainability destination via its "Next" button, ' +
    'showing multi-level navigation beyond the Home <-> Destination pair.',
    {
      x: 0.6, y: 1.7, w: 9.5, h: 2,
      fontFace: FONT, fontSize: 16, color: '333333', valign: 'top',
    }
  );
  more.addText('Back', {
    x: 0.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Back',
    hyperlink: { slide: 2 },
  });
  more.addText('Home', {
    x: 2.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Home',
    hyperlink: { slide: 1 },
  });

  // Add the "Next" button to the Sustainability slide (destSlides[0]) now that slide 7
  // exists to target. Adding to an earlier slide object after later slides have been
  // created is fine in pptxgenjs; nothing is finalised until pptx.write().
  destSlides[0].addText('Next', {
    x: 2.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Next',
    hyperlink: { slide: 7 },
  });

  return pptx;
}

/** A small deck with only 1 button on the home slide -> too_few_buttons. */
function buildOneButtonDeck() {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'STUPAD_16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'STUPAD_16x9';

  const home = pptx.addSlide();
  home.background = { color: NAVY };
  home.addText('Only one button', {
    x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: WHITE,
  });
  home.addText('Sustainability', {
    x: 5.3, y: 2.6, w: 2.7, h: 2.2,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.12,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 20, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Sustainability',
    hyperlink: { slide: 2 },
  });

  const dest = pptx.addSlide();
  dest.background = { color: LIGHT };
  dest.addText('Sustainability', { x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: NAVY });
  dest.addText('Home', {
    x: 0.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Home',
    hyperlink: { slide: 1 },
  });

  return pptx;
}

/** Image + gradient background slide. */
async function buildWithImageDeck() {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'STUPAD_16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'STUPAD_16x9';

  // A tiny generated PNG (1x1 red pixel, base64) so we don't depend on external assets.
  const redPixelPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  const home = pptx.addSlide();
  home.background = { color: NAVY };
  home.addText('With Image', {
    x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: WHITE,
  });
  home.addText('Topic A', {
    x: 1, y: 2.6, w: 2.7, h: 2.2,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.12,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 20, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_TopicA',
    hyperlink: { slide: 2 },
  });
  home.addText('Topic B', {
    x: 4, y: 2.6, w: 2.7, h: 2.2,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.12,
    fill: { color: '2E5D8A' }, fontFace: FONT, fontSize: 20, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_TopicB',
    hyperlink: { slide: 2 },
  });

  const dest = pptx.addSlide();
  // Gradient background via raw XML override is not exposed by pptxgenjs; use a
  // two-stop background image workaround isn't needed for the fixture's purpose,
  // so we set a solid background plus an embedded image + crop.
  dest.background = { color: '203A5C' };
  dest.addImage({
    data: `image/png;base64,${redPixelPng}`,
    x: 4.5, y: 2, w: 4, h: 3,
    objectName: 'IMG_Hero',
    sizing: { type: 'crop', w: 4, h: 3, x: 0, y: 0 },
  });
  dest.addText('Home', {
    x: 0.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Home',
    hyperlink: { slide: 1 },
  });

  return pptx;
}

/**
 * Deck for testing multi-level nav links (SPEC: destination slides can now link onward,
 * not just back to Home):
 *   Slide 1: home, 2 buttons (Topic A -> 2, Topic B -> 3)
 *   Slide 2: "Next" via an explicit Link-to-Slide-4 (ppaction://hlinksldjump), + Home
 *   Slide 3: "Next" via a `nextslide` action, injected below since pptxgenjs's
 *            `hyperlink` option only emits explicit slide links, not
 *            ppaction://hlinkshowjump?jump=nextslide, + Home
 *   Slide 4: "BTN_Self" links to its own slide (authoring mistake -> self_link warning,
 *            ignored rather than crashing), + Home
 *   Slide 5: Terms, linked from slides 2 and 3; its only way out is a "Back" shape with
 *            PowerPoint's "Last Slide Viewed" action (lastslideviewed, injected below)
 */
function buildMultiSlideDeck() {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'STUPAD_16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'STUPAD_16x9';

  const home = pptx.addSlide();
  home.background = { color: NAVY };
  home.addText('Multi-slide chain test', {
    x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: WHITE,
  });
  home.addText('Topic A', {
    x: 2, y: 2.6, w: 2.7, h: 2.2,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.12,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 20, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_TopicA',
    hyperlink: { slide: 2 },
  });
  home.addText('Topic B', {
    x: 6, y: 2.6, w: 2.7, h: 2.2,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.12,
    fill: { color: '2E5D8A' }, fontFace: FONT, fontSize: 20, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_TopicB',
    hyperlink: { slide: 3 },
  });

  // Slide 2: explicit slide-link "Next" -> slide 4.
  const s2 = pptx.addSlide();
  s2.background = { color: LIGHT };
  s2.addText('Topic A', { x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: NAVY });
  s2.addText('Next', {
    x: 0.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_NextExplicit',
    hyperlink: { slide: 4 },
  });
  s2.addText('Home', {
    x: 2.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Home',
    hyperlink: { slide: 1 },
  });

  s2.addText('Terms', {
    x: 4.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: '8A5D2E' }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Terms',
    hyperlink: { slide: 5 },
  });

  // Slide 3: "Next" shape with no hyperlink yet -> injectNextSlideAction() below gives it
  // ppaction://hlinkshowjump?jump=nextslide, resolving to slide 4 at parse time.
  const s3 = pptx.addSlide();
  s3.background = { color: LIGHT };
  s3.addText('Topic B', { x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: NAVY });
  s3.addText('Next', {
    x: 0.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_NextAction',
  });
  s3.addText('Home', {
    x: 2.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Home',
    hyperlink: { slide: 1 },
  });

  s3.addText('Terms', {
    x: 4.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: '8A5D2E' }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Terms',
    hyperlink: { slide: 5 },
  });

  // Slide 4: BTN_Self links to its own slide (an authoring mistake we must not crash on).
  const s4 = pptx.addSlide();
  s4.background = { color: LIGHT };
  s4.addText('Slide 4', { x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: NAVY });
  s4.addText('Next (mistake)', {
    x: 0.6, y: 6.5, w: 2.4, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: ACCENT }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Self',
    hyperlink: { slide: 4 },
  });
  s4.addText('Home', {
    x: 3.2, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Home',
    hyperlink: { slide: 1 },
  });

  // Slide 5: Terms. BTN_Back gets ppaction://hlinkshowjump?jump=lastslideviewed below.
  const s5 = pptx.addSlide();
  s5.background = { color: LIGHT };
  s5.addText('Terms and conditions', { x: 0.6, y: 0.5, w: 12, h: 1, fontFace: FONT, fontSize: 28, bold: true, color: NAVY });
  s5.addText('Back', {
    x: 0.6, y: 6.5, w: 1.8, h: 0.6,
    shape: pptx.ShapeType.roundRect, rectRadius: 0.15,
    fill: { color: NAVY }, fontFace: FONT, fontSize: 14, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
    objectName: 'BTN_Back',
  });

  return pptx;
}

/**
 * Post-process a slide's XML to give a named shape a `ppaction://hlinkshowjump` click
 * action instead of an explicit slide link — pptxgenjs's `hyperlink` option only emits
 * explicit `ppaction://hlinksldjump` links, so shapes meant to exercise `nextslide` /
 * `previousslide` / `firstslide` / `lastslide` / `lastslideviewed` are added with no hyperlink and patched
 * here. Unlike hlinksldjump, this action needs no relationship id.
 */
async function injectShowJumpAction(pptxPath, slideFile, shapeName, jump) {
  const data = await fs.readFile(pptxPath);
  const zip = await JSZip.loadAsync(data);
  const slidePath = `ppt/slides/${slideFile}`;
  let xml = await zip.file(slidePath).async('string');

  const selfClosing = new RegExp(`<p:cNvPr([^>]*) name="${shapeName}"\\s*/>`);
  const openClose = new RegExp(`<p:cNvPr([^>]*) name="${shapeName}"([^>]*)>([\\s\\S]*?)</p:cNvPr>`);
  const hlink = `<a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" action="ppaction://hlinkshowjump?jump=${jump}"/>`;

  if (selfClosing.test(xml)) {
    xml = xml.replace(selfClosing, (_m, attrs) => `<p:cNvPr${attrs} name="${shapeName}">${hlink}</p:cNvPr>`);
  } else if (openClose.test(xml)) {
    xml = xml.replace(openClose, (_m, attrs, rest, body) => `<p:cNvPr${attrs} name="${shapeName}"${rest}>${body}${hlink}</p:cNvPr>`);
  } else {
    throw new Error(`injectShowJumpAction: could not find shape "${shapeName}" in ${slidePath}`);
  }

  zip.file(slidePath, xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(pptxPath, buf);
}

/** Confirm the ppaction://hlinkshowjump patch actually landed in the fixture. */
async function assertShowJumpAction(pptxPath, slideFile, jump) {
  const data = await fs.readFile(pptxPath);
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file(`ppt/slides/${slideFile}`).async('string');
  if (!xml.includes(`ppaction://hlinkshowjump?jump=${jump}`)) {
    throw new Error(`Expected ppaction://hlinkshowjump?jump=${jump} in ${pptxPath}/${slideFile}, not found`);
  }
}

async function writePptx(pptx, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  await fs.writeFile(filePath, await stripRunLinks(buf));
  return filePath;
}

/**
 * pptxgenjs copies a shape's `hyperlink` onto every text run as well, with u="sng", so
 * PowerPoint (and our renderer) underline button captions like web links. The shape-level
 * hlinkClick is all a button needs, so drop the run-level links and their underline.
 */
async function stripRunLinks(buf) {
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const xml = await zip.file(name).async('string');
    const cleaned = xml.replace(/<a:rPr([^>]*)>([\s\S]*?)<\/a:rPr>/g, (m, attrs, body) => {
      if (!body.includes('<a:hlinkClick')) return m;
      return `<a:rPr${attrs.replace(/\su="sng"/, '')}>${body.replace(/<a:hlinkClick[\s\S]*?<\/a:hlinkClick>|<a:hlinkClick[^>]*\/>/g, '')}</a:rPr>`;
    });
    zip.file(name, cleaned);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Confirm pptxgenjs actually emits ppaction://hlinksldjump for a slide hyperlink. */
async function assertSlideJumpAction(pptxPath) {
  const data = await fs.readFile(pptxPath);
  const zip = await JSZip.loadAsync(data);
  const slide1 = await zip.file('ppt/slides/slide1.xml').async('string');
  if (!slide1.includes('ppaction://hlinksldjump')) {
    throw new Error(`Expected ppaction://hlinksldjump in ${pptxPath}, not found`);
  }
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
  if (!rels.includes('slide2.xml')) {
    throw new Error(`Expected slide1 rels to target slide2.xml in ${pptxPath}`);
  }
}

/** Craft broken-link.pptx from good.pptx: point one hlink rel target at a missing file. */
async function makeBrokenLink(goodPath, outPath) {
  const data = await fs.readFile(goodPath);
  const zip = await JSZip.loadAsync(data);
  const relsPath = 'ppt/slides/_rels/slide1.xml.rels';
  let rels = await zip.file(relsPath).async('string');
  // Retarget the first slide-jump relationship to a slide file that doesn't exist.
  const before = rels;
  rels = rels.replace(/Target="slide2\.xml"/, 'Target="slide99.xml"');
  if (rels === before) throw new Error('broken-link fixture: could not find slide2.xml target to break');
  zip.file(relsPath, rels);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
}

/**
 * Craft grouped-button.pptx from good.pptx: take two of the destination-2 shapes on the
 * home slide out of top-level <p:spTree> and wrap them in a <p:grpSp> whose own cNvPr
 * carries the hlinkClick (group-as-button), removing the per-shape hyperlinks so the
 * link only resolves via the group.
 */
async function makeGroupedButton(goodPath, outPath) {
  const data = await fs.readFile(goodPath);
  const zip = await JSZip.loadAsync(data);
  const slidePath = 'ppt/slides/slide1.xml';
  let xml = await zip.file(slidePath).async('string');

  // Find the People button <p:sp>...</p:sp> block (objectName/name="BTN_People").
  const spRegex = /<p:sp>(?:(?!<p:sp>)[\s\S])*?name="BTN_People"[\s\S]*?<\/p:sp>/;
  const match = xml.match(spRegex);
  if (!match) throw new Error('grouped-button fixture: could not find BTN_People shape');
  let spXml = match[0];

  // Extract the shape's xfrm off/ext to build a group xfrm, and its hlinkClick r:id.
  const offMatch = spXml.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
  const extMatch = spXml.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  const ridMatch = spXml.match(/r:id="(rId\d+)"/);
  if (!offMatch || !extMatch) throw new Error('grouped-button fixture: could not read xfrm');
  const [, x, y] = offMatch;
  const [, cx, cy] = extMatch;
  const rid = ridMatch ? ridMatch[1] : null;

  // Strip the per-shape hlinkClick (link now lives on the group only).
  const spNoLink = spXml.replace(/<a:hlinkClick[^/]*\/>/, '');

  const groupXml =
    `<p:grpSp>` +
    `<p:nvGrpSpPr><p:cNvPr id="9001" name="Group Button"><a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"${rid ? ` r:id="${rid}"` : ''} action="ppaction://hlinksldjump"/></p:cNvPr><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></p:grpSpPr>` +
    spNoLink +
    `</p:grpSp>`;

  xml = xml.replace(spXml, groupXml);
  zip.file(slidePath, xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
}

async function main() {
  const good = buildGoodDeck();
  const templatePath = path.join(PUBLIC_DIR, 'template.pptx');
  await writePptx(good, templatePath);
  await assertSlideJumpAction(templatePath);
  console.log(`Wrote ${templatePath}`);

  const goodFixturePath = path.join(FIXTURES_DIR, 'good.pptx');
  await fs.copyFile(templatePath, goodFixturePath);
  console.log(`Wrote ${goodFixturePath}`);

  const oneButton = buildOneButtonDeck();
  const oneButtonPath = path.join(FIXTURES_DIR, 'one-button.pptx');
  await writePptx(oneButton, oneButtonPath);
  console.log(`Wrote ${oneButtonPath}`);

  const withImage = await buildWithImageDeck();
  const withImagePath = path.join(FIXTURES_DIR, 'with-image.pptx');
  await writePptx(withImage, withImagePath);
  console.log(`Wrote ${withImagePath}`);

  const brokenLinkPath = path.join(FIXTURES_DIR, 'broken-link.pptx');
  await makeBrokenLink(goodFixturePath, brokenLinkPath);
  console.log(`Wrote ${brokenLinkPath}`);

  const groupedButtonPath = path.join(FIXTURES_DIR, 'grouped-button.pptx');
  await makeGroupedButton(goodFixturePath, groupedButtonPath);
  console.log(`Wrote ${groupedButtonPath}`);

  const multiSlide = buildMultiSlideDeck();
  const multiSlidePath = path.join(FIXTURES_DIR, 'multi-slide.pptx');
  await writePptx(multiSlide, multiSlidePath);
  await injectShowJumpAction(multiSlidePath, 'slide3.xml', 'BTN_NextAction', 'nextslide');
  await assertShowJumpAction(multiSlidePath, 'slide3.xml', 'nextslide');
  await injectShowJumpAction(multiSlidePath, 'slide5.xml', 'BTN_Back', 'lastslideviewed');
  await assertShowJumpAction(multiSlidePath, 'slide5.xml', 'lastslideviewed');
  console.log(`Wrote ${multiSlidePath}`);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
