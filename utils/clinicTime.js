// Booked times are "HH:mm" on the clinic's wall clock (India by default),
// while the server may run in UTC. Building the instant with setHours() used
// the server's zone, so a 12:30 slot became 12:30 UTC (6:00 PM IST) and the
// join window, cancellation fees and "must be in the future" checks were
// 5h30 off.
const CLINIC_OFFSET_MINUTES = Number(process.env.CLINIC_TZ_OFFSET_MINUTES || 330);

// The booked calendar day of a stored date. Days are saved as midnight in
// the server's zone (00:00Z on a UTC server, 18:30Z the day before on an IST
// one); shifting to the clinic zone lands on the intended day either way.
function clinicDayParts(raw) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + CLINIC_OFFSET_MINUTES * 60000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

// The real instant of [hhmm] on the booked day, or an invalid Date.
function clinicInstant(rawDay, hhmm) {
  const day = clinicDayParts(rawDay);
  if (!day) return new Date(NaN);
  const [h, m] = String(hhmm || '00:00').split(':').map((v) => parseInt(v, 10));
  return new Date(Date.UTC(day.y, day.m, day.d, h || 0, m || 0) - CLINIC_OFFSET_MINUTES * 60000);
}

module.exports = { CLINIC_OFFSET_MINUTES, clinicDayParts, clinicInstant };
