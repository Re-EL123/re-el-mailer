#!/usr/bin/env node
/**
 * Generate the PWA icon set into `apps/web/assets/`.
 *
 * The mark is drawn as SVG (crisp at every size, and the only format that can be
 * produced identically on any machine without an image toolchain), and the
 * rasterised PNGs the manifest references are derived from the same source by
 * the lightweight encoder below. Running this twice produces byte-identical
 * files, so the icons can be committed and this script is only needed when the
 * brand changes.
 *
 * Usage:
 *   npm run build
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO_ROOT } from '../packages/shared/dotenv.js';

const ASSETS = path.join(REPO_ROOT, 'apps', 'web', 'assets');
const BRAND = '#21396A';
const ACCENT = '#F6F8FC';

/** The app mark: a rounded envelope-ish glyph on the brand navy. */
function iconSvg(size, maskable) {
  // A maskable icon must keep its content inside the safe circle, so the glyph
  // is scaled down and the background bleeds to the edges.
  const pad = maskable ? size * 0.18 : size * 0.16;
  const inner = size - pad * 2;
  const r = maskable ? 0 : size * 0.22; // non-maskable gets rounded corners
  const x = pad;
  const y = pad;
  const stroke = inner * 0.09;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${BRAND}"/>
  <g transform="translate(${x} ${y})">
    <rect x="0" y="0" width="${inner}" height="${inner}" rx="${inner * 0.16}" fill="none" stroke="${ACCENT}" stroke-width="${stroke}"/>
    <path d="M ${stroke} ${stroke + inner * 0.06} L ${inner / 2} ${inner * 0.55} L ${inner - stroke} ${stroke + inner * 0.06}"
          fill="none" stroke="${ACCENT}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

// ── Minimal PNG encoder (RGBA, no external deps) ────────────────────────────

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode raw RGBA pixels as a PNG. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10..12 = compression, filter, interlace = 0

  // Prefix each scanline with filter type 0.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** Rasterise the mark (rounded navy square + white glyph) into RGBA. */
function renderIcon(size, maskable) {
  const [br, bg, bb] = hexToRgb(BRAND);
  const [ar, ag, ab] = hexToRgb(ACCENT);
  const rgba = Buffer.alloc(size * size * 4);

  const pad = maskable ? size * 0.18 : size * 0.16;
  const inner = size - pad * 2;
  const radius = maskable ? 0 : size * 0.22;
  const stroke = inner * 0.09;
  const glyphR = inner * 0.16;

  const inRounded = (x, y) => {
    if (radius === 0) return true;
    // Point inside a rounded rect of `size` with corner radius `radius`.
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius + 1e-6 ||
      (x >= radius && x <= size - radius) || (y >= radius && y <= size - radius);
  };
  const inGlyphBox = (x, y) => {
    const lx = x - pad;
    const ly = y - pad;
    if (lx < stroke / 2 || ly < stroke / 2 || lx > inner - stroke / 2 || ly > inner - stroke / 2) return false;
    // Inside the rounded outline (border), not the hollow middle.
    const cx = Math.min(Math.max(lx, glyphR), inner - glyphR);
    const cy = Math.min(Math.max(ly, glyphR), inner - glyphR);
    const outer = (lx - cx) ** 2 + (ly - cy) ** 2 <= glyphR * glyphR + 1e-6;
    if (!outer) return false;
    const ix = Math.min(Math.max(lx, glyphR + stroke), inner - glyphR - stroke);
    const iy = Math.min(Math.max(ly, glyphR + stroke), inner - glyphR - stroke);
    const innerHit = (lx - ix) ** 2 + (ly - iy) ** 2 <= (glyphR - stroke) ** 2 + 1e-6;
    return !innerHit;
  };
  // The diagonal "flap" line across the envelope.
  const onFlap = (x, y) => {
    const lx = x - pad;
    const ly = y - pad;
    const x1 = stroke;
    const y1 = stroke + inner * 0.06;
    const xm = inner / 2;
    const ym = inner * 0.55;
    const x2 = inner - stroke;
    const y2 = stroke + inner * 0.06;
    const d = (px, py, ax, ay, bx, by) => {
      const num = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay));
      const den = Math.hypot(bx - ax, by - ay);
      return num / (den || 1);
    };
    return Math.min(d(lx, ly, x1, y1, xm, ym), d(lx, ly, xm, ym, x2, y2)) <= stroke / 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let [r, g, b, a] = [br, bg, bb, inRounded(x, y) ? 255 : 0];
      if (a && (inGlyphBox(x, y) || onFlap(x, y))) [r, g, b] = [ar, ag, ab];
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return encodePng(size, size, rgba);
}

/**
 * A PNG-encoded text label, in a 5x7 bitmap font.
 *
 * Only used for the Open Graph image, which needs a wordmark at a size where the
 * icon alone says nothing. Shipping a bitmap font rather than an image toolchain
 * keeps this script dependency-free and deterministic, like everything else here.
 */
const GLYPHS = {
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** Draw text into an RGBA buffer, one pixel per bitmap cell. */
function drawText(rgba, width, text, { x, y, scale, colour }) {
  const [r, g, b] = colour;
  let cursor = x;

  for (const char of text.toUpperCase()) {
    const rows = GLYPHS[char] || GLYPHS[' '];
    rows.forEach((row, rowIndex) => {
      [...row].forEach((bit, colIndex) => {
        if (bit !== '1') return;
        // Bounds-checked: an out-of-range write here would silently corrupt the
        // neighbouring pixel rather than fail.
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = cursor + colIndex * scale + dx;
            const py = y + rowIndex * scale + dy;
            if (px < 0 || py < 0 || px >= width) continue;
            const i = (py * width + px) * 4;
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
            rgba[i + 3] = 255;
          }
        }
      });
    });
    cursor += 5 * scale + scale;
  }
}

/**
 * The Open Graph card: 1200x630, the size every social scraper asks for.
 *
 * Drawn rather than photographed because a link preview that renders on every
 * platform is worth more than a prettier one, and because this stays in the same
 * deterministic, dependency-free pipeline as the icons.
 */
function renderOgImage() {
  const width = 1200;
  const height = 630;
  const rgba = Buffer.alloc(width * height * 4);
  const [br, bg, bb] = hexToRgb(BRAND);
  const [ar, ag, ab] = hexToRgb(ACCENT);
  const [fr, fg, fb] = hexToRgb('#8FB0FF');

  // Brand navy field.
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = br;
    rgba[i * 4 + 1] = bg;
    rgba[i * 4 + 2] = bb;
    rgba[i * 4 + 3] = 255;
  }

  // The mark, top left, at 4x the 180px the SVG is authored at.
  const markSize = 180;
  const markX = 96;
  const markY = 96;
  const markPad = markSize * 0.16;
  const markInner = markSize - markPad * 2;
  const markStroke = markInner * 0.09;
  const markR = markInner * 0.16;

  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, markR), markInner - markR);
    const cy = Math.min(Math.max(y, markR), markInner - markR);
    return (x - cx) ** 2 + (y - cy) ** 2 <= markR * markR + 1e-6 ||
      (x >= markR && x <= markInner - markR) || (y >= markR && y <= markInner - markR);
  };
  const distToSegment = (px, py, ax, ay, bx, by) => {
    const num = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay));
    return num / (Math.hypot(bx - ax, by - ay) || 1);
  };

  for (let y = 0; y < markSize; y += 1) {
    for (let x = 0; x < markSize; x += 1) {
      const lx = x - markPad;
      const ly = y - markPad;
      let hit = false;

      if (lx >= markStroke / 2 && ly >= markStroke / 2 && lx <= markInner - markStroke / 2 && ly <= markInner - markStroke / 2) {
        const cx = Math.min(Math.max(lx, markR), markInner - markR);
        const cy = Math.min(Math.max(ly, markR), markInner - markR);
        const outer = (lx - cx) ** 2 + (ly - cy) ** 2 <= markR * markR + 1e-6;
        if (outer) {
          const ix = Math.min(Math.max(lx, markR + markStroke), markInner - markR - markStroke);
          const iy = Math.min(Math.max(ly, markR + markStroke), markInner - markR - markStroke);
          const innerHit = (lx - ix) ** 2 + (ly - iy) ** 2 <= (markR - markStroke) ** 2 + 1e-6;
          hit = !innerHit;
        }
      }

      if (!hit) {
        hit =
          distToSegment(lx, ly, markStroke, markStroke + markInner * 0.06, markInner / 2, markInner * 0.55) <= markStroke / 2 ||
          distToSegment(lx, ly, markInner / 2, markInner * 0.55, markInner - markStroke, markStroke + markInner * 0.06) <= markStroke / 2;
      }

      if (hit && inRounded(lx, ly)) {
        const i = ((markY + y) * width + (markX + x)) * 4;
        rgba[i] = ar;
        rgba[i + 1] = ag;
        rgba[i + 2] = ab;
      }
    }
  }

  // Wordmark.
  drawText(rgba, width, 'RE-EL MAILER', { x: 96, y: 340, scale: 13, colour: [255, 255, 255] });
  // Tagline in the lighter brand tint, deliberately smaller.
  drawText(rgba, width, 'BUSINESS EMAIL BUILT FOR', { x: 96, y: 470, scale: 5, colour: [fr, fg, fb] });
  drawText(rgba, width, 'BUSINESS', { x: 96 + 25 * 6 * 5, y: 470, scale: 5, colour: [255, 255, 255] });

  return encodePng(width, height, rgba);
}

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const written = [];

  for (const size of [192, 512]) {
    const svgName = `icon-${size}.svg`;
    fs.writeFileSync(path.join(ASSETS, svgName), iconSvg(size, false));
    written.push(svgName);

    const pngName = `icon-${size}.png`;
    fs.writeFileSync(path.join(ASSETS, pngName), renderIcon(size, false));
    written.push(pngName);
  }

  // Maskable variant (background bleeds, glyph inside the safe zone).
  const maskSvg = 'icon-512-maskable.svg';
  fs.writeFileSync(path.join(ASSETS, maskSvg), iconSvg(512, true));
  written.push(maskSvg);
  const maskPng = 'icon-512-maskable.png';
  fs.writeFileSync(path.join(ASSETS, maskPng), renderIcon(512, true));
  written.push(maskPng);

  // Favicon.
  const favicon = 'favicon.svg';
  fs.writeFileSync(path.join(ASSETS, favicon), iconSvg(64, false));
  written.push(favicon);

  // Apple touch icon. iOS does not apply the manifest, and it will not render an
  // SVG favicon either, so without a dedicated PNG a home-screen shortcut gets a
  // blank page or a screenshot of the launch screen.
  //
  // Opaque, not maskable: iOS rounds this itself, and a maskable icon's edge-to-
  // edge background is what you want here precisely because it gets clipped.
  const appleTouch = 'apple-touch-icon.png';
  fs.writeFileSync(path.join(ASSETS, appleTouch), renderIcon(180, true));
  written.push(appleTouch);

  // Open Graph card for link previews.
  const ogImage = 'og-image.png';
  fs.writeFileSync(path.join(ASSETS, ogImage), renderOgImage());
  written.push(ogImage);

  console.log(`Wrote ${written.length} icon file(s) to apps/web/assets:`);
  for (const name of written) console.log(`  ${name}`);
}

main();