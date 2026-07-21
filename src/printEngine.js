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

/** Word-wrap that also hard-breaks any single token wider than the box, so a
 *  long no-space string can never overflow the print area. */
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (ctx.measureText(word).width <= maxWidth) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) { line = candidate; }
      else { if (line) lines.push(line); line = word; }
      continue;
    }
    // token longer than the whole line — break it character by character
    if (line) { lines.push(line); line = ''; }
    let chunk = '';
    for (const ch of word) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk) { lines.push(chunk); chunk = ch; }
      else chunk += ch;
    }
    line = chunk;
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
// Instagram's exact heart glyph (its 48x48 SVG path converted to absolute
// bezier coordinates). Drawn with core canvas commands so it renders identically
// to the on-site preview without depending on node-canvas Path2D/SVG support.
function drawHeart(ctx, cx, cy, size, color) {
  const scale = size / 48;
  ctx.save();
  ctx.fillStyle = color;
  ctx.translate(cx - 24 * scale, cy - 23.5 * scale);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(34.6, 3.1);
  ctx.bezierCurveTo(30.1, 3.1, 26.7, 4.9, 24, 8.7);
  ctx.bezierCurveTo(21.3, 5, 17.9, 3.2, 13.4, 3.2);
  ctx.bezierCurveTo(6, 3.2, 0, 9.5, 0, 17.6);
  ctx.bezierCurveTo(0, 24.9, 5.4, 29.6, 10.6, 34.3);
  ctx.bezierCurveTo(11.2, 34.8, 11.9, 35.5, 12.6, 36.2);
  ctx.lineTo(20.4, 43.2);
  ctx.bezierCurveTo(21.3, 44, 22.5, 44.4, 24, 44.4);
  ctx.bezierCurveTo(25.5, 44.4, 26.7, 44, 27.6, 43.2);
  ctx.lineTo(35.4, 36.2);
  ctx.bezierCurveTo(36.1, 35.5, 36.8, 34.9, 37.4, 34.3);
  ctx.bezierCurveTo(42.6, 29.6, 48, 25, 48, 17.6);
  ctx.bezierCurveTo(48, 9.5, 42, 3.2, 34.6, 3.2);
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
 * PNG buffer. Ink color follows the blank: white ink on Black shirts (IG dark
 * mode), near-black ink on White shirts (IG light mode).
 *
 * @param {object} opts
 * @param {string} opts.handle   sanitized "@handle"
 * @param {string} opts.comment  sanitized comment body
 * @param {number} [opts.likes]  like count shown under the heart
 * @param {string} [opts.time]   "time since posted" string, e.g. "2h", "1 week"
 * @param {string} [opts.color]  shirt colorway: "Black" (default) or "White"
 * @param {string|Buffer} opts.avatar  data URL / path / buffer of the cropped avatar
 */
async function generatePrintImage({ handle, comment, likes = 0, time = '2h', color = 'Black', avatar }) {
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

  // ---- Ink theme per blank --------------------------------------------------
  // Black tee = IG dark mode; White tee = IG light mode.
  const light = String(color).toLowerCase() === 'white';
  const ink = light
    ? { text: '#262626', meta: '#737373', count: '#737373', ring: 'rgba(0,0,0,0.15)', heart: '#ed4956' }
    : { text: '#ffffff', meta: '#a8a8a8', count: '#c8c8c8', ring: 'rgba(255,255,255,0.22)', heart: '#ed4956' };

  // ---- Metrics (ratios calibrated to a real IG comment @ 14px base) --------
  const margin = round(W * 0.085);
  const F = round(W * 0.05);       // base text size (handle + comment) — IG 14px
  const timeF = round(F * 0.95);   // time next to the handle — IG renders ~username size
  const replyF = round(F * 0.85);  // "See translation" / "Reply" — IG 12px
  const countF = round(F * 0.8);   // like count under the heart — IG 11px
  const lineH = round(F * 1.35);
  const avatarD = round(F * 2.3);  // profile pic — IG 32px vs 14px font
  const avatarR = round(avatarD / 2);
  const gap = round(F * 0.85);     // avatar -> text — IG 12px
  const textX = margin + avatarD + gap;

  const boldFont = (px) => `bold ${px}px ${FONT_FAMILY}`;
  const regFont = (px) => `${px}px ${FONT_FAMILY}`;

  // Right-hand like column: heart with the count directly below it (IG style).
  // Instagram's heart is roughly the same size as the comment text, not bigger.
  const heartSize = round(F * 0.95);
  const countText = Number(likes) > 0 ? formatLikeCount(likes) : '';
  ctx.font = regFont(countF);
  const countW = countText ? ctx.measureText(countText).width : 0;
  const likeColW = Math.max(heartSize, countW) + round(F * 0.3);
  const textW = W - margin - likeColW - textX;

  // ---- Handle: always ONE line, time to its right --------------------------
  // The handle never wraps. If "@handle <time>" is wider than the text column,
  // shrink the handle's font just enough to fit (floor at half the base size).
  const timeText = String(time || '2h');
  const timeGap = round(F * 0.36);
  ctx.font = regFont(timeF);
  const timeW = ctx.measureText(timeText).width;
  ctx.font = boldFont(F);
  const handleText = String(handle);
  const fullHandleW = ctx.measureText(handleText).width;
  const availW = textW - timeGap - timeW;
  const handleF = fullHandleW > availW
    ? Math.max(round(F * 0.5), Math.floor((F * availW) / fullHandleW))
    : F;
  ctx.font = boldFont(handleF);
  const handleW = ctx.measureText(handleText).width;
  const rowsAboveComment = 1;

  ctx.font = regFont(F);
  const commentLines = wrapText(ctx, comment, textW);
  const numComment = Math.max(1, commentLines.length);

  // Fixed TOP anchor on the chest: extra comment lines grow downward, so the
  // avatar/handle row sits at the same height no matter how long the comment is.
  const topY = round(H * 0.195);

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
  ctx.strokeStyle = ink.ring;
  ctx.stroke();

  // ---- Handle (one line, bold); grey time to its right ---------------------
  ctx.font = boldFont(handleF);
  ctx.fillStyle = ink.text;
  ctx.fillText(handleText, textX, topY + (F - handleF)); // bottom-align with the row
  ctx.font = regFont(timeF);
  ctx.fillStyle = ink.meta;
  ctx.fillText(timeText, textX + handleW + timeGap, topY + (F - timeF));
  let y = topY + rowsAboveComment * lineH;

  // ---- Comment --------------------------------------------------------------
  ctx.font = regFont(F);
  ctx.fillStyle = ink.text;
  for (const ln of commentLines) { ctx.fillText(ln, textX, y); y += lineH; }

  // ---- Meta: "See translation   Reply" on one line (grey) ------------------
  ctx.font = regFont(replyF);
  ctx.fillStyle = ink.meta;
  ctx.fillText('See translation', textX, y);
  const seeW = ctx.measureText('See translation').width;
  ctx.fillText('Reply', textX + seeW + round(F * 0.7), y);

  // ---- Red filled heart + like count on the right --------------------------
  const heartCX = W - margin - round(likeColW / 2);
  // Aligned with the first COMMENT line (like Instagram), not the handle line.
  const heartCY = topY + rowsAboveComment * lineH + round(F * 0.4);
  drawHeart(ctx, heartCX, heartCY, heartSize, ink.heart);
  if (countText) {
    ctx.font = regFont(countF);
    ctx.fillStyle = ink.count;
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
