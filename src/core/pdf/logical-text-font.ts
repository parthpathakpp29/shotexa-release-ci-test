import type { Font, GlyphRun } from "@pdf-lib/fontkit";

type Fontkit = { create(bytes: Uint8Array, postscriptName?: string): Font };

/**
 * For the INVISIBLE OCR layer only. The screenshot supplies the visible shaped text.
 * Indic shaping reorders pre-base vowels into visual glyph order; pdf-lib's ToUnicode
 * then exposes that order when copying/searching. Use fontkit's documented one-to-one
 * Unicode mapping instead, retaining the same embedded/subset font and original text.
 * Never use this adapter for visible typography.
 */
export function logicalTextFontkit(base: Fontkit): Fontkit {
  return { create(bytes, postscriptName) {
    const font = base.create(bytes, postscriptName);
    font.layout = (text): GlyphRun => {
      const glyphs = font.glyphsForString(text);
      return {
        glyphs,
        positions: glyphs.map((glyph) => ({ xAdvance: glyph.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 })),
        script: "DFLT", language: null, direction: "ltr", features: {},
        advanceWidth: glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0), advanceHeight: 0, bbox: font.bbox,
      };
    };
    return font;
  } };
}
