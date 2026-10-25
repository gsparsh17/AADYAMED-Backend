/**
 * Keeps each lab's collection slots filled in from its weekly template, so a
 * lab that set its week once never runs out of bookable days. Runs at start
 * and every 6 hours. Set LAB_SLOT_ROLL=false to turn it off.
 */
const { rollAllTemplates } = require('../services/labSchedule.service');

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const count = await rollAllTemplates();
    if (count > 0) console.log(`Lab slots: rolled forward for ${count} lab(s)`);
  } catch (error) {
    console.error('Lab slot roll job failed:', error.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer || process.env.LAB_SLOT_ROLL === 'false') return;
  timer = setInterval(tick, 6 * 60 * 60 * 1000);
  timer.unref?.();
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
