import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { parsePptx } from '../../src/pptx';
import { validateDeck, totalVideoBytes, LARGE_VIDEO_BYTES } from '../../src/pptx/validate';
import { isSupportedVideoPath, Pkg, type Rel } from '../../src/pptx/zip';
import { parseShapeChildren, type ShapeParseCtx } from '../../src/pptx/shapes';
import { defaultTheme, defaultClrMap } from '../../src/pptx/color';
import { makeScale } from '../../src/pptx/geometry';
import { SLIDE_W } from '../../src/types';
import type { Deck, VideoElement, GroupElement } from '../../src/types';

const FIXTURES = path.resolve(__dirname, '../fixtures');

async function loadFixture(name: string): Promise<ArrayBuffer> {
  const buf = await fs.readFile(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function findVideo(deck: Deck, slideIndex: number): VideoElement | undefined {
  const slide = deck.slides[slideIndex - 1];
  return slide?.elements.find((e): e is VideoElement => e.kind === 'video');
}

describe('parsePptx: video.pptx', () => {
  it('parses slide 2 (no timing at all) as a VideoElement with autoplay true, loop false', async () => {
    const result = await parsePptx(await loadFixture('video.pptx'), 'video.pptx');
    const deck = result.deck!;
    const video = findVideo(deck, 2);
    expect(video).toBeDefined();
    expect(video!.kind).toBe('video');
    expect(video!.mediaKey).toBeTruthy();
    expect(video!.posterKey).toBeTruthy();
    expect(deck.media[video!.mediaKey]).toBeDefined();
    expect(deck.media[video!.mediaKey].mime).toBe('video/mp4');
    expect(deck.media[video!.posterKey]).toBeDefined();
    expect(video!.loop).toBe(false);
    expect(video!.autoplay).toBe(true);
  });

  it('parses slide 3 (patched <p:timing>: repeatCount + clickEffect) as loop true, autoplay false', async () => {
    const result = await parsePptx(await loadFixture('video.pptx'), 'video.pptx');
    const deck = result.deck!;
    const video = findVideo(deck, 3);
    expect(video).toBeDefined();
    expect(video!.loop).toBe(true);
    expect(video!.autoplay).toBe(false);
  });

  it('keeps slide 4 (linked/external video) as a picture, not a video, with an unsupported_element warning', async () => {
    const result = await parsePptx(await loadFixture('video.pptx'), 'video.pptx');
    const deck = result.deck!;
    const slide4 = deck.slides[3];
    expect(slide4.elements.some((e) => e.kind === 'video')).toBe(false);
    expect(slide4.elements.some((e) => e.kind === 'picture')).toBe(true);
    const warning = result.issues.find(
      (i) => i.code === 'unsupported_element' && i.slide === 4 && /linked video not embedded/.test(i.message),
    );
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });

  it('flags slide 4 as unlinked from Home (deliberately, like good.pptx\'s info slide)', async () => {
    const result = await parsePptx(await loadFixture('video.pptx'), 'video.pptx');
    expect(result.issues.some((i) => i.code === 'unlinked_slide' && i.slide === 4)).toBe(true);
  });

  it('parses with no errors and exactly 2 home buttons', async () => {
    const result = await parsePptx(await loadFixture('video.pptx'), 'video.pptx');
    const deck = result.deck!;
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(deck.buttons.length).toBe(2);
  });
});

describe('isSupportedVideoPath: format detection', () => {
  it('accepts mp4, m4v and mov by extension', () => {
    expect(isSupportedVideoPath('ppt/media/media1.mp4')).toBe(true);
    expect(isSupportedVideoPath('ppt/media/media1.m4v')).toBe(true);
    expect(isSupportedVideoPath('ppt/media/media1.MOV')).toBe(true);
  });

  it('rejects other formats (wmv, avi, webm)', () => {
    expect(isSupportedVideoPath('ppt/media/media1.wmv')).toBe(false);
    expect(isSupportedVideoPath('ppt/media/media1.avi')).toBe(false);
    expect(isSupportedVideoPath('ppt/media/media1.webm')).toBe(false);
  });
});

describe('large_video: total embedded video size warning', () => {
  function fakeBlob(bytes: number): Blob {
    return { size: bytes } as unknown as Blob;
  }

  function fakeDeckWithVideoBytes(bytes: number): Deck {
    const video: VideoElement = {
      kind: 'video',
      id: 'v1',
      name: 'Video 1',
      xfrm: { x: 0, y: 0, w: 100, h: 100, rot: 0, flipH: false, flipV: false },
      mediaKey: 'ppt/media/media1.mp4',
      posterKey: 'ppt/media/image1.png',
      loop: false,
      autoplay: true,
    };
    return {
      id: 'deck-1',
      fileName: 'video.pptx',
      parsedAt: '2026-09-24T00:00:00.000Z',
      slideWidthEmu: 12192000,
      slideHeightEmu: 6858000,
      height: 1080,
      slides: [{ index: 1, background: { type: 'none' }, elements: [video] }],
      buttons: [],
      homeLinks: [],
      navLinks: [],
      backLinks: [],
      pollOptions: [],
      media: {
        'ppt/media/media1.mp4': { blob: fakeBlob(bytes), mime: 'video/mp4' },
        'ppt/media/image1.png': { blob: fakeBlob(1000), mime: 'image/png' },
      },
      fonts: [],
    };
  }

  it('totalVideoBytes sums only the video media, not the poster', () => {
    const deck = fakeDeckWithVideoBytes(1000);
    expect(totalVideoBytes(deck)).toBe(1000);
  });

  it('does not warn at or below the 50 MB threshold', () => {
    const deck = fakeDeckWithVideoBytes(LARGE_VIDEO_BYTES);
    expect(validateDeck(deck).some((i) => i.code === 'large_video')).toBe(false);
  });

  it('warns above the 50 MB threshold', () => {
    const deck = fakeDeckWithVideoBytes(LARGE_VIDEO_BYTES + 1);
    const issue = validateDeck(deck).find((i) => i.code === 'large_video');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.message).toContain('50.0 MB');
  });
});

describe('parseShapeChildren: video edge cases (inline XML, not fixtures)', () => {
  const SLIDE_NS =
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"';

  function host(xml: string): Element {
    const doc = new DOMParser().parseFromString(`<host ${SLIDE_NS}>${xml}</host>`, 'application/xml');
    return doc.documentElement;
  }

  /** A slide document with no <p:timing> at all, so a video's timing defaults to autoplay. */
  function emptySlideDoc(): Document {
    return new DOMParser().parseFromString(`<p:sld ${SLIDE_NS}><p:cSld/></p:sld>`, 'application/xml');
  }

  async function makeCtx(rels: Rel[], media: Record<string, Uint8Array>): Promise<ShapeParseCtx> {
    const zip = new JSZip();
    for (const [zipPath, bytes] of Object.entries(media)) zip.file(zipPath, bytes);
    return {
      theme: defaultTheme(),
      clrMap: defaultClrMap(),
      slideWidthEmu: 12192000,
      slideWidthPx: SLIDE_W,
      scale: makeScale(12192000, SLIDE_W),
      rels,
      slidePathToIndex: new Map(),
      media: {},
      pkg: new Pkg(zip),
      issues: [],
      slideIndex: 1,
      slideDoc: emptySlideDoc(),
    };
  }

  const VIDEO_REL: Rel = { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video', target: 'ppt/media/media1.mp4' };
  const MEDIA_REL: Rel = { id: 'rId2', type: 'http://schemas.microsoft.com/office/2007/relationships/media', target: 'ppt/media/media1.mp4' };
  const IMAGE_REL: Rel = { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: 'ppt/media/poster1.png' };

  function videoPicXml(cNvPrId: string, name: string, blipEmbed: string | null): string {
    const blip = blipEmbed ? `<a:blip r:embed="${blipEmbed}"/>` : '<a:blip/>';
    return (
      `<p:pic>` +
      `<p:nvPicPr>` +
      `<p:cNvPr id="${cNvPrId}" name="${name}"/>` +
      `<p:cNvPicPr/>` +
      `<p:nvPr>` +
      `<a:videoFile r:link="rId1"/>` +
      `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media r:embed="rId2"/></p:ext></p:extLst>` +
      `</p:nvPr>` +
      `</p:nvPicPr>` +
      `<p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="500000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      `</p:pic>`
    );
  }

  it('parses a video nested inside a group without throwing, at the correct group-relative bounds', async () => {
    const ctx = await makeCtx([VIDEO_REL, MEDIA_REL, IMAGE_REL], {
      'ppt/media/media1.mp4': new Uint8Array([0, 0, 0, 24]),
      'ppt/media/poster1.png': new Uint8Array([137, 80, 78, 71]),
    });
    const xml =
      `<p:grpSp>` +
      `<p:nvGrpSpPr><p:cNvPr id="10" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm>` +
      `<a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/>` +
      `<a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/>` +
      `</a:xfrm></p:grpSpPr>` +
      videoPicXml('11', 'Video 1', 'rId3') +
      `</p:grpSp>`;

    // Parsing itself must not throw; any rejection here fails the test.
    const elements = await parseShapeChildren(host(xml), ctx);

    expect(elements).toHaveLength(1);
    const group = elements[0] as GroupElement;
    expect(group.kind).toBe('group');
    expect(group.children).toHaveLength(1);
    const video = group.children[0] as VideoElement;
    expect(video.kind).toBe('video');
    expect(video.mediaKey).toBe('ppt/media/media1.mp4');
    expect(video.posterKey).toBe('ppt/media/poster1.png');
    expect(ctx.media['ppt/media/media1.mp4']).toBeDefined();
    expect(ctx.media['ppt/media/poster1.png']).toBeDefined();
  });

  it('parses a video whose poster image cannot be resolved (no blip embed) without throwing', async () => {
    const ctx = await makeCtx([VIDEO_REL, MEDIA_REL], {
      'ppt/media/media1.mp4': new Uint8Array([0, 0, 0, 24]),
    });
    const xml = videoPicXml('12', 'Video 2', null); // <a:blip/> with no r:embed at all

    // Parsing itself must not throw; any rejection here fails the test.
    const elements = await parseShapeChildren(host(xml), ctx);

    expect(elements).toHaveLength(1);
    const video = elements[0] as VideoElement;
    expect(video.kind).toBe('video');
    expect(video.mediaKey).toBe('ppt/media/media1.mp4');
    expect(video.posterKey).toBe(''); // no poster resolvable; renderer's <video poster=""> just has nothing to show
    expect(ctx.issues.some((i) => i.code === 'unsupported_element' && /image could not be resolved/.test(i.message))).toBe(true);
  });
});
