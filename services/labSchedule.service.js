/**
 * Collection slots from a weekly timetable. Patients can only book dates that
 * have dated `testSlots`, which labs used to create one day at a time; now a
 * lab sets its week once and this keeps the next N days filled in.
 *
 * Applying never loses a booking: a slot with bookings stays even if the
 * template drops it, and its capacity never goes below what's booked.
 */
const PathologyProfile = require('../models/PathologyProfile');
const { dateKey, startOfDay } = require('./diagnostics.service');

const MAX_DAYS = 60;
const KEEP_PAST_DAYS = 7;

const toMinutes = (t) => {
  const m = String(t || '').match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Validates and normalises a template payload; throws a readable error. */
function normaliseTemplate(days) {
  if (!Array.isArray(days)) throw new Error('days must be a list');
  const byWeekday = new Map();
  for (const d of days) {
    const weekday = Number(d?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('weekday must be 0–6');
    const slots = (d.slots || []).map((s) => {
      const start = toMinutes(s.startTime);
      const end = toMinutes(s.endTime);
      if (start === null || end === null || end <= start) throw new Error(`Invalid slot ${s.startTime}–${s.endTime}`);
      const cap = parseInt(s.maxCapacity, 10);
      return { startTime: s.startTime, endTime: s.endTime, maxCapacity: Number.isFinite(cap) && cap > 0 ? cap : 10 };
    }).sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    for (let i = 1; i < slots.length; i += 1) {
      if (toMinutes(slots[i].startTime) < toMinutes(slots[i - 1].endTime)) {
        throw new Error(`Overlapping slots on day ${weekday}: ${slots[i - 1].startTime} and ${slots[i].startTime}`);
      }
    }
    byWeekday.set(weekday, { weekday, enabled: d.enabled !== false && slots.length > 0, slots });
  }
  return [...byWeekday.values()].sort((a, b) => a.weekday - b.weekday);
}

/** Merges one day's template slots into its existing dated slots. */
function mergeDay(existing = [], templateSlots = []) {
  const key = (s) => `${s.startTime}-${s.endTime}`;
  const old = new Map(existing.map((s) => [key(s), s]));
  const merged = [];
  const seen = new Set();
  for (const t of templateSlots) {
    const prev = old.get(key(t));
    const booked = Number(prev?.bookedCount || 0);
    const cap = Math.max(Number(t.maxCapacity || 10), booked);
    merged.push({
      startTime: t.startTime,
      endTime: t.endTime,
      maxCapacity: cap,
      bookedCount: booked,
      isAvailable: booked < cap && prev?.isAvailable !== false,
    });
    seen.add(key(t));
  }
  // Slots the template no longer has stay only while someone is booked in.
  for (const s of existing) {
    if (!seen.has(key(s)) && Number(s.bookedCount || 0) > 0) {
      merged.push({ ...(s.toObject?.() || s), isAvailable: false });
    }
  }
  return merged.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
}

/**
 * Fills [profile].testSlots from its template for the next [days] days
 * (default: the lab's advance booking window). Mutates and saves.
 */
async function applyTemplate(profile, { days } = {}) {
  const template = profile.slotTemplate?.days || [];
  const window = Math.min(MAX_DAYS, Math.max(1, Number(days || profile.bookingSettings?.advanceBookingDays || 30)));
  const holidays = new Set((profile.operatingHours?.holidays || []).map(dateKey));
  const byKey = new Map((profile.testSlots || []).map((s) => [dateKey(s.date), s]));
  const today = startOfDay(new Date());

  let touched = 0;
  for (let i = 0; i < window; i += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() + i);
    const k = dateKey(day);
    if (holidays.has(k)) continue;
    const t = template.find((d) => d.weekday === day.getDay());
    const slots = t && t.enabled !== false ? t.slots : [];
    const existing = byKey.get(k);
    const merged = mergeDay(existing?.timeSlots || [], slots);
    if (existing) existing.timeSlots = merged;
    else if (merged.length) profile.testSlots.push({ date: day, timeSlots: merged });
    touched += 1;
  }

  // Old days only bloat the document.
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() - KEEP_PAST_DAYS);
  profile.testSlots = (profile.testSlots || [])
    .filter((s) => new Date(s.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  profile.markModified('testSlots');
  await profile.save();
  return touched;
}

/** The next [days] days as { date, slots, capacity, booked, holiday }. */
function upcomingSummary(profile, days = 14) {
  const holidays = new Set((profile.operatingHours?.holidays || []).map(dateKey));
  const byKey = new Map((profile.testSlots || []).map((s) => [dateKey(s.date), s]));
  const today = startOfDay(new Date());
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() + i);
    const k = dateKey(day);
    const slots = byKey.get(k)?.timeSlots || [];
    out.push({
      date: k,
      weekday: day.getDay(),
      holiday: holidays.has(k),
      slots: slots.length,
      capacity: slots.reduce((n, s) => n + Number(s.maxCapacity || 0), 0),
      booked: slots.reduce((n, s) => n + Number(s.bookedCount || 0), 0),
    });
  }
  return out;
}

/** Daily: keep every lab with a template filled in for its booking window. */
async function rollAllTemplates() {
  const labs = await PathologyProfile.find({ 'slotTemplate.days.0': { $exists: true } });
  let count = 0;
  for (const lab of labs) {
    try {
      await applyTemplate(lab);
      count += 1;
    } catch (error) {
      console.error(`Slot roll failed for lab ${lab._id}:`, error.message);
    }
  }
  return count;
}

module.exports = { normaliseTemplate, mergeDay, applyTemplate, upcomingSummary, rollAllTemplates };
