'use strict';

/**
 * Retention sweeper for the generated files in data/uploads (customer avatars)
 * and data/prints (composited print previews).
 *
 * These are only needed transiently: once fulfillment uploads the print to
 * Printify, Printify hosts the asset. We keep the local copies for a retention
 * window (default 7 days) so the admin verification queue can still show them
 * side-by-side, then prune. Set CLEANUP_TTL_HOURS to tune the window.
 *
 * The interval timer is unref()'d so it never keeps the process alive on its own.
 */

const fs = require('fs');
const path = require('path');

const TTL_HOURS = Number(process.env.CLEANUP_TTL_HOURS) || 168; // 7 days
const INTERVAL_HOURS = Number(process.env.CLEANUP_INTERVAL_HOURS) || 6;

/** Delete files older than the TTL in the given dirs. Returns count removed. */
function sweepOnce(dirs) {
  const cutoff = Date.now() - TTL_HOURS * 3600 * 1000;
  let removed = 0;
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of entries) {
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
      } catch (e) { /* ignore individual file races */ }
    }
  }
  if (removed) console.log(`[cleanup] pruned ${removed} generated file(s) older than ${TTL_HOURS}h`);
  return removed;
}

/** Sweep once on boot, then on an interval. Returns the timer. */
function start(dirs) {
  const run = () => {
    try { sweepOnce(dirs); } catch (e) { console.error('[cleanup]', e.message); }
  };
  run();
  const timer = setInterval(run, INTERVAL_HOURS * 3600 * 1000);
  if (timer.unref) timer.unref();
  console.log(`[cleanup] retention sweeper active (TTL ${TTL_HOURS}h, every ${INTERVAL_HOURS}h)`);
  return timer;
}

module.exports = { start, sweepOnce };
