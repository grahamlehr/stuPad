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

async function writePptx(pptx, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  await fs.writeFile(filePath, buf);
  return filePath;
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

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
