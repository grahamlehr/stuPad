import { describe, it, expect } from 'vitest';
import { resolveColor, applyColorMods, defaultTheme, defaultClrMap } from '../../src/pptx/color';

function el(xml: string): Element {
  const doc = new DOMParser().parseFromString(
    `<root xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${xml}</root>`,
    'application/xml'
  );
  return doc.documentElement.firstElementChild as Element;
}

const ctx = { theme: defaultTheme(), clrMap: defaultClrMap() };

describe('colour resolution', () => {
  it('resolves srgbClr directly', () => {
    expect(resolveColor(el('<a:srgbClr val="FF0000"/>'), ctx)).toBe('#FF0000');
  });

  it('resolves schemeClr via the master clrMap (bg1 -> lt1 -> theme white)', () => {
    expect(resolveColor(el('<a:schemeClr val="bg1"/>'), ctx)).toBe('#FFFFFF');
  });

  it('resolves schemeClr tx1 -> dk1 -> theme black', () => {
    expect(resolveColor(el('<a:schemeClr val="tx1"/>'), ctx)).toBe('#000000');
  });

  it('resolves accent colours directly from the theme', () => {
    expect(resolveColor(el('<a:schemeClr val="accent1"/>'), ctx)).toBe('#4472C4');
  });

  it('resolves sysClr using lastClr', () => {
    expect(resolveColor(el('<a:sysClr val="windowText" lastClr="123456"/>'), ctx)).toBe('#123456');
  });

  it('resolves a known prstClr name', () => {
    expect(resolveColor(el('<a:prstClr val="red"/>'), ctx)).toBe('#FF0000');
  });

  it('falls back for an unresolvable colour', () => {
    expect(resolveColor(null, ctx, '#ABCDEF')).toBe('#ABCDEF');
  });
});

describe('colour modifiers (lumMod/lumOff/tint/shade/alpha)', () => {
  it('lumMod darkens toward black (halves lightness)', () => {
    // white (L=1.0) * lumMod 50% -> mid grey
    const out = applyColorMods('FFFFFF', el('<a:schemeClr val="bg1"><a:lumMod val="50000"/></a:schemeClr>'));
    expect(out.toUpperCase()).toBe('#808080');
  });

  it('lumOff lightens by adding to lightness', () => {
    // black (L=0) + lumOff 50% -> mid grey
    const out = applyColorMods('000000', el('<a:schemeClr val="tx1"><a:lumOff val="50000"/></a:schemeClr>'));
    expect(out.toUpperCase()).toBe('#808080');
  });

  it('tint lightens toward white proportionally', () => {
    // black tinted 50% -> mid grey (tint blends toward white)
    const out = applyColorMods('000000', el('<a:schemeClr val="tx1"><a:tint val="50000"/></a:schemeClr>'));
    expect(out.toUpperCase()).toBe('#808080');
  });

  it('shade darkens toward black proportionally', () => {
    // white shaded 50% -> mid grey
    const out = applyColorMods('FFFFFF', el('<a:schemeClr val="bg1"><a:shade val="50000"/></a:schemeClr>'));
    expect(out.toUpperCase()).toBe('#808080');
  });

  it('alpha produces an rgba() string', () => {
    const out = resolveColor(el('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>'), ctx);
    expect(out).toBe('rgba(255,0,0,0.5)');
  });

  it('resolveColor applies modifiers found as children of the colour element', () => {
    const out = resolveColor(el('<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>'), ctx);
    expect(out).toMatch(/^#[0-9A-F]{6}$/);
  });
});
