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

function formatLikes(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v === 1 ? '1 like' : `${v.toLocaleString('en-US')} likes`;
}

/**
 * Clean, symmetric Instagram-style filled heart centered at (cx, cy).
 * Two mirrored bezier lobes meeting at a top dip and a bottom point.
 */
function drawHeart(ctx, cx, cy, size, color) {
  const s = size;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.34);
  ctx.bezierCurveTo(cx - s * 0.62, cy + s * 0.02, cx - s * 0.54, cy - s * 0.46, cx, cy - s * 0.12);
  ctx.bezierCurveTo(cx + s * 0.54, cy - s * 0.46, cx + s * 0.62, cy + s * 0.02, cx, cy + s * 0.34);
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

  // ---- IG-accurate metrics (handle & comment share the same size) ----------
  const margin = round(W * 0.085);
  const F = round(W * 0.05); // base text size
  const metaF = round(F * 0.82);
  const lineH = round(F * 1.36);
  const avatarD = round(F * 2.6); // profile pic diameter
  const avatarR = round(avatarD / 2);
  const gap = round(F * 0.72); // avatar -> text
  const textX = margin + avatarD + gap;
  const textW = W - textX - margin;
  const metaGap = round(F * 0.5);

  const boldFont = (px) => `bold ${px}px ${FONT_FAMILY}`;
  const regFont = (px) => `${px}px ${FONT_FAMILY}`;

  // ---- Lay out the inline "bold handle + regular comment" paragraph --------
  const segs = [];
  ctx.font = boldFont(F);
  const spaceBold = ctx.measureText(' ').width;
  segs.push({ text: handle, x: textX, line: 0, bold: true });
  let cursor = textX + ctx.measureText(handle).width + spaceBold;
  let line = 0;

  ctx.font = regFont(F);
  const spaceReg = ctx.measureText(' ').width;
  const words = String(comment).split(/\s+/).filter(Boolean);
  for (const word of words) {
    const wW = ctx.measureText(word).width;
    if (wW > textW) {
      // hard-break a token longer than the whole line
      let chunk = '';
      for (const ch of word) {
        if (cursor + ctx.measureText(chunk + ch).width > textX + textW && (chunk || cursor > textX)) {
          if (chunk) segs.push({ text: chunk, x: cursor, line, bold: false });
          line += 1;
          cursor = textX;
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      if (chunk) {
        segs.push({ text: chunk, x: cursor, line, bold: false });
        cursor += ctx.measureText(chunk).width + spaceReg;
      }
      continue;
    }
    if (cursor + wW > textX + textW && cursor > textX) { line += 1; cursor = textX; }
    segs.push({ text: word, x: cursor, line, bold: false });
    cursor += wW + spaceReg;
  }
  const numLines = line + 1;

  // ---- Vertically center the whole block on the upper chest ----------------
  const textBlockH = numLines * lineH + metaGap + metaF;
  const blockH = Math.max(avatarD, textBlockH);
  const topY = round(H * 0.32 - blockH / 2);
  const contentTop = textBlockH >= avatarD ? topY : topY + round((avatarD - textBlockH) / 2);

  // ---- Circular avatar (clip mask over the user image) ---------------------
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

  // ---- Draw the inline handle + comment ------------------------------------
  for (const s of segs) {
    ctx.font = s.bold ? boldFont(F) : regFont(F);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s.text, s.x, contentTop + s.line * lineH);
  }

  // ---- Grey meta row: "2h   1,234 likes   Reply" ---------------------------
  const metaY = contentTop + numLines * lineH + metaGap;
  ctx.font = regFont(metaF);
  ctx.fillStyle = '#a8a8a8';
  const parts = ['2h'];
  if (Number(likes) > 0) parts.push(formatLikes(likes));
  parts.push('Reply');
  ctx.fillText(parts.join('     '), textX, metaY);

  // ---- Red "liked" heart, top-right, aligned to the first line -------------
  const heartSize = round(F * 0.82);
  drawHeart(ctx, W - margin - round(heartSize / 2), contentTop + round(F * 0.55), heartSize, '#ed4956');

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
