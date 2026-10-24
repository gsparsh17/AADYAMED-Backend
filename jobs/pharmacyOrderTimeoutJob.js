/**
 * Rejects pharmacy orders nobody accepted in time.
 *
 * Without this an unanswered order waits forever: the customer sees
 * "placed" indefinitely and a prepaid order keeps their money. The window is
 * PHARMACY_ACCEPT_MINUTES (default 15) and PHARMACY_RX_REVIEW_MINUTES for
 * prescription orders (default 30). Set PHARMACY_AUTO_REJECT=false to turn it
 * off.
 */
const { autoRejectStaleOrders } = require('../controllers/ePharmacy.controller');

let timer = null;
let running = false;

async function tick() {
  if (running) return; // never overlap a slow pass
  running = true;
  try {
    const count = await autoRejectStaleOrders();
    if (count > 0) console.log(`Pharmacy order timeout: auto-rejected ${count} order(s)`);
  } catch (error) {
    console.error('Pharmacy order timeout job failed:', error.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer || process.env.PHARMACY_AUTO_REJECT === 'false') return;
  timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
