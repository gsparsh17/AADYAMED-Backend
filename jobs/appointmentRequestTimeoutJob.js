/**
 * Declines doctor/physio appointment requests nobody answered in time, so a
 * patient isn't left waiting on "pending" and the slot isn't blocked. See
 * autoDeclineStaleRequests in controllers/appointment.controller.js for the
 * rules (APPOINTMENT_RESPONSE_HOURS, default 2; APPOINTMENT_RESPONSE_CUTOFF_MINUTES,
 * default 30). Set APPOINTMENT_AUTO_DECLINE=false to turn it off.
 */
const { autoDeclineStaleRequests } = require('../controllers/appointment.controller');

let timer = null;
let running = false;

async function tick() {
  if (running) return; // never overlap a slow pass
  running = true;
  try {
    const count = await autoDeclineStaleRequests();
    if (count > 0) console.log(`Appointment requests: auto-declined ${count}`);
  } catch (error) {
    console.error('Appointment request timeout job failed:', error.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer || process.env.APPOINTMENT_AUTO_DECLINE === 'false') return;
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
