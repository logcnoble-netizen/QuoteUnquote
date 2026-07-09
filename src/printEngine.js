'use strict';

/**
 * Server-side print-file renderer (100% Custom POD).
 *
 * generatePrintImage() composites a user-cropped circular avatar + the bold
 * handle + wrapped comment + grey meta row into a transparent, 300 DPI PNG at
 * Printify's print dimensions. validatePrintFile() decodes and sanity-checks the
 * incoming avatar so corrupt uploads can be quarantined instead of shipped.
 *
 * node-canvas is lazy-required so the web server still boots without it; the
 * failure only surfaces when an actual print is attempted (webhook fulfillment),
 * where it is caught and routed to quarantine + admin alert.
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

/**
 * Word-wrapping guardrail: breaks text into words, measures each candidate line
 * against maxWidth, and hard-breaks any single token longer than the box so
 * nothing can ever overflow the print area.
 */
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  const pushHardBroken = (token) => {
    let chunk = '';
    for (const ch of token) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    return chunk;
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) { lines.push(line); line = ''; }
    line = ctx.measureText(word).width > maxWidth ? pushHardBroken(word) : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Decode + validate a user-uploaded avatar. Accepts a data URL string, a Buffer,
 * or a file path. Never throws for bad input — returns { ok:false, reason } so
 * the caller can quarantine. Throws only if the engine itself is unavailable.
 *
 * @returns {Promise<{ok:boolean, reason?:string, image?:object, mime?:string, bytes?:number}>}
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

function drawHeart(ctx, cx, cy, size, color) {
  const s = size;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.28);
  ctx.bezierCurveTo(cx, cy + s * 0.1, cx - s * 0.5, cy - s * 0.25, cx - s * 0.5, cy - s * 0.05);
  ctx.bezierCurveTo(cx - s * 0.5, cy + s * 0.18, cx - s * 0.2, cy + s * 0.42, cx, cy + s * 0.62);
  ctx.bezierCurveTo(cx + s * 0.2, cy + s * 0.42, cx + s * 0.5, cy + s * 0.18, cx + s * 0.5, cy - s * 0.05);
  ctx.bezierCurveTo(cx + s * 0.5, cy - s * 0.25, cx, cy - s * 0.1, cx, cy + s * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Render the comment card (with circular avatar) to a transparent PNG buffer.
 * White text — the blank is black, DTG lays down white ink.
 *
 * @param {object} opts
 * @param {string} opts.handle   sanitized "@handle"
 * @param {string} opts.comment  sanitized comment body
 * @param {string|Buffer} opts.avatar  data URL / path / buffer of the cropped avatar
 * @returns {Promise<{buffer:Buffer, base64:string, width:number, height:number}>}
 */
async function generatePrintImage({ handle, comment, avatar }) {
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

  // Layout metrics (scaled to the print width).
  const margin = round(W * 0.08);
  const avatarR = round(W * 0.058);
  const gutter = round(W * 0.03);
  const textX = margin + avatarR * 2 + gutter;
  const textW = W - textX - margin;
  const handleSize = round(W * 0.052);
  const commentSize = round(W * 0.049);
  const metaSize = round(W * 0.036);
  const lineGap = round(commentSize * 0.34);

  ctx.font = `${commentSize}px ${FONT_FAMILY}`;
  const commentLines = wrapText(ctx, comment, textW);
  const blockH = handleSize + lineGap + commentLines.length * (commentSize + lineGap) + lineGap + metaSize;
  let y = round(H * 0.3 - blockH / 2);

  const avatarCX = margin + avatarR;
  const avatarCY = y + round(handleSize / 2);

  // ---- Circular avatar (clip mask over the user image) ----------------------
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const d = avatarR * 2;
  const scale = Math.max(d / avatarImg.width, d / avatarImg.height); // cover-fit
  const dw = avatarImg.width * scale;
  const dh = avatarImg.height * scale;
  ctx.drawImage(avatarImg, avatarCX - dw / 2, avatarCY - dh / 2, dw, dh);
  ctx.restore();
  // subtle ring
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, round(W * 0.0016));
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.stroke();

  // ---- Handle (bold, white) + red "liked" heart -----------------------------
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${handleSize}px ${FONT_FAMILY}`;
  ctx.fillText(handle, textX, y);
  drawHeart(ctx, W - margin - round(handleSize * 0.4), y + round(handleSize * 0.1), handleSize * 0.9, '#ed4956');
  y += handleSize + lineGap;

  // ---- Comment body (wrapped) ----------------------------------------------
  ctx.fillStyle = '#f2f2f2';
  ctx.font = `${commentSize}px ${FONT_FAMILY}`;
  for (const ln of commentLines) {
    ctx.fillText(ln, textX, y);
    y += commentSize + lineGap;
  }

  // ---- Grey metadata sub-row -----------------------------------------------
  y += lineGap;
  ctx.fillStyle = '#b8b8bd';
  ctx.font = `${metaSize}px ${FONT_FAMILY}`;
  ctx.fillText('2h    Reply    Like', textX, y);

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
