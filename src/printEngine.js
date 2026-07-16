'use strict';

/**
 * Server-side print-file renderer (100% Custom POD).
 *
 * generatePrintImage() composites a user-cropped circular avatar + an authentic
 * Instagram-style comment (bold handle flowing inline into the comment text, a
 * grey meta row with a likes count, and a red "liked" heart) into a transparent
 * 300 DPI PNG at Printify's print dimensions. validatePrintFile() decodes and
 * sanity-checks the incoming avatar so corrupt uploads can be quarantined.
 *
 * node-canvas is lazy-required so the web server still boots without it.
 */

const fs = require('fs');
const path = require('path');
const { PRINT, AVATAR } = require('./config');

let canvasLib = null;
let canvasLoadError = null;
try {
  canvasLib = require('canvas');
} catch (err) {
  canvasLoadError = err;
  console.warn(
    `[printEngine] node-canvas unavailable (${err.message}). ` +
      'Storefront still runs; POD print rendering will fail until canvas is installed.'
  );
}

// Optional bundled fonts so print output matches the on-site Instagram look.
let FONT_FAMILY = 'sans-serif';
if (canvasLib) {
  const fonts = [
    ['Inter-Regular.ttf', { family: 'Inter', weight: 'normal' }],
    ['Inter-Bold.ttf', { family: 'Inter', weight: 'bold' }],
  ];
  let registered = false;
  for (const [file, spec] of fonts) {
    const fp = path.join(__dirname, '..', 'assets', 'fonts', file);
    try {
      if (fs.existsSync(fp)) { canvasLib.registerFont(fp, spec); registered = true; }
    } catch (err) {
      console.warn(`[printEngine] Could not register ${file}: ${err.message}`);
    }
  }
  if (registered) FONT_FAMILY = 'Inter';
}

const unavailable = () =>
  new Error(`Print engine unavailable: ${canvasLoadError ? canvasLoadError.message : 'canvas not installed'}`);

/** Legacy simple word-wrap (kept for compatibility / tests). */
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Instagram-style like count shown under the heart. Full comma number up to
 * 9,999; above that, "k" rounded to the nearest hundred (e.g. 53,565 -> 53.6k);
 * millions as "M".
 */
function formatLikeCount(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 10000) return v.toLocaleString('en-US');
  if (v < 1000000) {
    const k = Math.round(v / 100) / 10;
    return (Number.isInteger(k) ? k : k.toFixed(1)) + 'k';
  }
  const m = Math.round(v / 100000) / 10;
  return (Number.isInteger(m) ? m : m.toFixed(1)) + 'M';
}

/**
 * Clean, symmetric Instagram-style filled heart centered at (cx, cy).
 * Two mirrored bezier lobes meeting at a top dip and a bottom point.
 */
// Instagram's exact heart glyph (48x48 viewBox), filled. Vector, so it stays
// crisp at 300 DPI — sharper than any raster PNG at print size. The same path
// is used in the on-site preview (public/index.html) so they're identical.
const IG_HEART_PATH =
  'M34.6 3.1c-4.5 0-7.9 1.8-10.6 5.6-2.7-3.7-6.1-5.5-10.6-5.5C6 3.2 0 9.5 0 17.6c0 7.3 5.4 12 10.6 16.7.6.5 1.3 1.2 2 1.9l7.8 7c.9.8 2.1 1.2 3.6 1.2s2.7-.4 3.6-1.2l7.8-7c.7-.7 1.4-1.3 2-1.9C42.6 29.6 48 25 48 17.6c0-8.1-6-14.4-13.4-14.4Z';

function drawHeart(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  let ok = false;
  try {
    const scale = size / 48;
    ctx.translate(cx - 24 * scale, cy - 23 * scale);
    ctx.scale(scale, scale);
    ctx.fill(new canvasLib.Path2D(IG_HEART_PATH));
    ok = true;
  } catch (e) { /* Path2D/SVG unsupported — fall back below */ }
  ctx.restore();
  if (ok) return;

  // Fallback bezier heart (used only if Path2D SVG parsing is unavailable).
  const s = size;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.30);
  ctx.bezierCurveTo(cx - s * 0.30, cy + s * 0.10, cx - s * 0.50, cy - s * 0.08, cx - s * 0.50, cy - s * 0.22);
  ctx.bezierCurveTo(cx - s * 0.50, cy - s * 0.40, cx - s * 0.24, cy - s * 0.48, cx, cy - s * 0.22);
  ctx.bezierCurveTo(cx + s * 0.24, cy - s * 0.48, cx + s * 0.50, cy - s * 0.40, cx + s * 0.50, cy - s * 0.22);
  ctx.bezierCurveTo(cx + s * 0.50, cy - s * 0.08, cx + s * 0.30, cy + s * 0.10, cx, cy + s * 0.30);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Decode + validate a user-uploaded avatar. Never throws for bad input —
 * returns { ok:false, reason } so the caller can quarantine.
 */
async function validatePrintFile(avatar) {
  if (!canvasLib) throw unavailable();

  let buffer;
  let mime = 'image/png';
  try {
    if (Buffer.isBuffer(avatar)) {
      buffer = avatar;
    } else if (typeof avatar === 'string' && avatar.startsWith('data:')) {
      const m = avatar.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!m) return { ok: false, reason: 'avatar is not a valid base64 image data URL' };
      mime = m[1].toLowerCase();
      if (!AVATAR.ALLOWED_MIME.includes(mime)) return { ok: false, reason: `unsupported avatar type ${mime}` };
      buffer = Buffer.from(m[2], 'base64');
    } else if (typeof avatar === 'string') {
      buffer = fs.readFileSync(avatar);
    } else {
      return { ok: false, reason: 'no avatar provided' };
    }
  } catch (err) {
    return { ok: false, reason: `could not read avatar: ${err.message}` };
  }

  if (!buffer || buffer.length < 100) return { ok: false, reason: 'avatar payload too small / empty' };

  let image;
  try {
    image = await canvasLib.loadImage(buffer);
  } catch (err) {
    return { ok: false, reason: `avatar failed to decode (corrupt): ${err.message}` };
  }
  if (!image.width || !image.height || image.width < AVATAR.MIN_DIMENSION || image.height < AVATAR.MIN_DIMENSION) {
    return { ok: false, reason: `avatar dimensions too small (${image.width}x${image.height})` };
  }
  return { ok: true, image, mime, bytes: buffer.length };
}

/**
 * Render the Instagram-style comment (with circular avatar) to a transparent
 * PNG buffer. White text on transparent — the blank is black, DTG lays white ink.
 *
 * @param {object} opts
 * @param {string} opts.handle   sanitized "@handle"
 * @param {string} opts.comment  sanitized comment body
 * @param {number} [opts.likes]  like count shown in the meta row
 * @param {string|Buffer} opts.avatar  data URL / path / buffer of the cropped avatar
 */
async function generatePrintImage({ handle, comment, likes = 0, avatar }) {
  if (!canvasLib) throw unavailable();

  const v = await validatePrintFile(avatar);
  if (!v.ok) {
    const err = new Error(`validatePrintFile rejected the avatar: ${v.reason}`);
    err.quarantine = true;
    throw err;
  }
  const avatarImg = v.image;

  const W = PRINT.WIDTH_PX;
  const H = PRINT.HEIGHT_PX;
  const round = Math.round;
  const canvas = canvasLib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H); // transparent — DTG needs alpha
  ctx.textBaseline = 'top';
  ctx.antialias = 'subpixel';

  // ---- Metrics --------------------------------------------------------------
  const margin = round(W * 0.085);
  const F = round(W * 0.05); // base text size (handle + comment)
  const metaF = round(F * 0.8); // time, Reply, like count
  const lineH = round(F * 1.4);
  const avatarD = round(F * 2.6); // profile pic diameter
  const avatarR = round(avatarD / 2);
  const gap = round(F * 0.72); // avatar -> text
  const textX = margin + avatarD + gap;

  const boldFont = (px) => `bold ${px}px ${FONT_FAMILY}`;
  const regFont = (px) => `${px}px ${FONT_FAMILY}`;

  // Right-hand like column: heart with the count directly below it (IG style).
  const heartSize = round(F * 1.2);
  const countText = Number(likes) > 0 ? formatLikeCount(likes) : '';
  ctx.font = regFont(metaF);
  const countW = countText ? ctx.measureText(countText).width : 0;
  const likeColW = Math.max(heartSize, countW) + round(F * 0.5);
  const textW = W - margin - likeColW - textX;

  // ---- Wrap the handle (char-level) and the comment ------------------------
  ctx.font = boldFont(F);
  const handleLines = [];
  {
    let cur = '';
    for (const ch of String(handle)) {
      if (ctx.measureText(cur + ch).width > textW && cur) { handleLines.push(cur); cur = ch; }
      else cur += ch;
    }
    handleLines.push(cur);
  }
  const handleLineCount = handleLines.length;

  ctx.font = regFont(F);
  const commentLines = wrapText(ctx, comment, textW);
  const numComment = Math.max(1, commentLines.length);

  // Rows: handle line(s) + comment line(s) + "See translation" + "Reply".
  const metaLineH = round(metaF * 1.5);
  const totalTextH = lineH * (handleLineCount + numComment) + metaLineH * 2;
  const blockH = Math.max(avatarD, totalTextH);
  const topY = round(H * 0.32 - blockH / 2);

  // ---- Circular avatar ------------------------------------------------------
  const avatarCX = margin + avatarR;
  const avatarCY = topY + avatarR;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const scale = Math.max(avatarD / avatarImg.width, avatarD / avatarImg.height);
  const dw = avatarImg.width * scale;
  const dh = avatarImg.height * scale;
  ctx.drawImage(avatarImg, avatarCX - dw / 2, avatarCY - dh / 2, dw, dh);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, round(W * 0.0014));
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.stroke();

  // ---- Handle line(s), bold white; grey time after the last one ------------
  ctx.font = boldFont(F);
  ctx.fillStyle = '#ffffff';
  handleLines.forEach((ln, i) => ctx.fillText(ln, textX, topY + i * lineH));
  const lastHandleW = ctx.measureText(handleLines[handleLineCount - 1]).width;
  ctx.font = regFont(metaF);
  ctx.fillStyle = '#a8a8a8';
  ctx.fillText('2h', textX + lastHandleW + round(F * 0.36), topY + (handleLineCount - 1) * lineH + (F - metaF));
  let y = topY + handleLineCount * lineH;

  // ---- Comment (white) ------------------------------------------------------
  ctx.font = regFont(F);
  ctx.fillStyle = '#ffffff';
  for (const ln of commentLines) { ctx.fillText(ln, textX, y); y += lineH; }

  // ---- Meta: "See translation" then "Reply" (grey) -------------------------
  ctx.font = regFont(metaF);
  ctx.fillStyle = '#a8a8a8';
  ctx.fillText('See translation', textX, y);
  y += metaLineH;
  ctx.fillText('Reply', textX, y);

  // ---- Red filled heart + like count on the right --------------------------
  const heartCX = W - margin - round(likeColW / 2);
  const heartCY = topY + round(heartSize * 0.55);
  drawHeart(ctx, heartCX, heartCY, heartSize, '#ed4956');
  if (countText) {
    ctx.font = regFont(metaF);
    ctx.fillStyle = '#c8c8c8';
    ctx.textAlign = 'center';
    ctx.fillText(countText, heartCX, heartCY + round(heartSize * 0.55) + round(F * 0.12));
    ctx.textAlign = 'left';
  }

  const buffer = canvas.toBuffer('image/png');
  if (!buffer || buffer.length < 1000) {
    const err = new Error('generated print file is empty/too small');
    err.quarantine = true;
    throw err;
  }
  return { buffer, base64: buffer.toString('base64'), width: W, height: H };
}

module.exports = {
  generatePrintImage,
  validatePrintFile,
  wrapText,
  isAvailable: () => !!canvasLib,
};
