/**
 * Regenerates build/icon.png — the "N." app mark.
 *
 * Rendered in Chromium so the real bundled Space Grotesk face is used, rather
 * than approximating the letterform. Colours are the same tokens the renderer
 * uses (--ink / --paper / --signal in src/renderer/index.html), so the icon and
 * the in-app brand lockup stay in sync.
 *
 * Geometry follows Apple's macOS icon grid: a 1024 canvas with an 824 rounded
 * square centred in it, leaving the transparent margin macOS expects. 1024 is
 * also the minimum electron-builder needs to emit a full .icns set.
 *
 * Not part of the build. Needs playwright available:
 *   npm i -D playwright && node tools/make-icon.mjs
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "build/icon.png");

// Inlined as a data: URI rather than referenced by file:// — a font served from
// a file:// origin is opaque to @font-face and Chromium silently falls back to
// a default serif, which is not a failure you notice until you look at the PNG.
const fontUrl =
  "data:font/woff2;base64," +
  fs.readFileSync(path.join(root, "src/renderer/fonts/space-grotesk.woff2")).toString("base64");

const SIZE = 1024;
const TILE = 824;
const RADIUS = 185;

const buildHtml = (dx, dy) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: "Space Grotesk";
    src: url("${fontUrl}") format("woff2");
    font-weight: 400 700;
  }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { width: ${SIZE}px; height: ${SIZE}px; display: flex; align-items: center; justify-content: center; }
  .tile {
    width: ${TILE}px; height: ${TILE}px;
    border-radius: ${RADIUS}px;
    background: oklch(0.161 0 0);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .mark {
    font-family: "Space Grotesk";
    font-weight: 700;
    font-size: 620px;
    line-height: 1;
    letter-spacing: -0.03em;
    color: oklch(0.964 0.008 84.6);
    transform: translate(__DX__px, __DY__px);
    white-space: nowrap;
  }
  .dot { color: oklch(0.577 0.219 27.6); }
</style></head><body>
  <div class="tile"><div class="mark">N<span class="dot">.</span></div></div>
</body></html>`
  .replace("__DX__", String(dx))
  .replace("__DY__", String(dy));

// CHROME_PATH lets this run against a preinstalled Chromium whose build number
// does not match the playwright package (as in CI sandboxes).
const executablePath = process.env.CHROME_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });

/** Minimal PNG reader — enough for the 8-bit RGBA images we produce here. */
function decodePng(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6) throw new Error("expected 8-bit RGBA");
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

/** Bounding box of everything that is not the tile fill and not transparent. */
function inkBox(png) {
  const { width, height, data } = png;
  const at = (x, y) => data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
  const tile = at(Math.floor(width / 2), Math.floor((SIZE - TILE) / 2) + 30); // tile, above the glyph
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = at(x, y);
      if (p[3] < 128) continue;
      const near = Math.abs(p[0] - tile[0]) < 24 && Math.abs(p[1] - tile[1]) < 24 && Math.abs(p[2] - tile[2]) < 24;
      if (near) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

// Render, measure where the glyph actually landed, correct, repeat. Converges
// in two passes; the loop just guarantees it rather than trusting a constant.
let dx = 0, dy = 0;
for (let pass = 0; pass < 4; pass++) {
  await page.setContent(buildHtml(dx, dy));
  await page.evaluate(() => document.fonts.ready);

  const loaded = await page.evaluate(() => document.fonts.check('700 620px "Space Grotesk"'));
  if (!loaded) {
    await browser.close();
    throw new Error("Space Grotesk did not load — refusing to render with a fallback face.");
  }

  const shot = await page.screenshot({ omitBackground: true });
  const box = inkBox(decodePng(shot));
  const errX = SIZE / 2 - (box.minX + box.maxX) / 2;
  const errY = SIZE / 2 - (box.minY + box.maxY) / 2;
  console.log(`pass ${pass}: ink ${box.maxX - box.minX}x${box.maxY - box.minY}, off-centre ${errX.toFixed(1)}, ${errY.toFixed(1)}`);
  if (Math.abs(errX) < 1 && Math.abs(errY) < 1) break;
  dx += errX;
  dy += errY;
}

await page.screenshot({ path: out, omitBackground: true });
await browser.close();
console.log("wrote", out, `(offset ${dx.toFixed(1)}, ${dy.toFixed(1)})`);
