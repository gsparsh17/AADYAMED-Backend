/**
 * Day-to-day lab operations beyond booking: result entry, report release,
 * earnings, the weekly collection timetable and the starter test library.
 * Mounted under /api/diagnostics/merchant (see routes/diagnostics.routes.js).
 */
const fs = require('fs');
const PathologyProfile = require('../models/PathologyProfile');
const LabTest = require('../models/LabTest');
const Appointment = require('../models/Appointment');
const PatientProfile = require('../models/PatientProfile');
const LIBRARY = require('../data/labTestLibrary');
const { createNotification } = require('../services/notification.service');
const { buildResults, resultSummary } = require('../services/labResults.service');
const { generateLabReportPdf } = require('../services/labReportPdf.service');
const { normaliseTemplate, applyTemplate, upcomingSummary } = require('../services/labSchedule.service');
const { dateKey, startOfDay } = require('../services/diagnostics.service');

const clean = (v) => String(v ?? '').trim();
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

async function labForUser(user) {
  if (user.role !== 'pathology') return null;
  if (user.profileId) {
    const byId = await PathologyProfile.findById(user.profileId);
    if (byId && String(byId.userId) === String(user.id)) return byId;
  }
  return PathologyProfile.findOne({ userId: user.id });
}

const notFound = (res, what = 'Pathology profile') => res.status(404).json({ success: false, message: `${what} not found` });

function pushHistory(order, status, note, userId) {
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({ status, note, actorId: userId, at: new Date() });
}

/** Tells the patient (and the ordering doctor) a report is ready. */
async function notifyReportReady(order) {
  try {
    const patient = await PatientProfile.findById(order.patientId?._id || order.patientId).select('userId name');
    const tests = (order.tests || []).filter((t) => t.status !== 'cancelled').map((t) => t.testName).filter(Boolean);
    const what = tests.length > 2 ? `${tests.slice(0, 2).join(', ')} +${tests.length - 2} more` : tests.join(', ') || 'lab tests';
    if (patient?.userId) {
      await createNotification({
        userId: patient.userId, userRole: 'patient', title: 'Your lab report is ready',
        message: `Report for ${what} (${order.labTestNumber}) is ready to view and download.`,
        type: 'lab_report', priority: 'high', channels: ['in_app', 'push'],
        relatedEntity: 'labtest', relatedEntityId: order._id,
        data: { entityType: 'labtest', labTestId: String(order._id) },
      });
    }
    if (order.doctorId) {
      const DoctorProfile = require('../models/DoctorProfile');
      const doctor = await DoctorProfile.findById(order.doctorId).select('userId');
      if (doctor?.userId) {
        await createNotification({
          userId: doctor.userId, userRole: 'doctor', title: 'Lab report ready',
          message: `${patient?.name || 'Your patient'}'s report for ${what} is ready.`,
          type: 'lab_report', channels: ['in_app', 'push'],
          relatedEntity: 'labtest', relatedEntityId: order._id,
        });
      }
    }
  } catch (error) {
    console.error('Report-ready notification failed:', error.message);
  }
}
exports.notifyReportReady = notifyReportReady;

// ── Results ────────────────────────────────────────────────────────────────

/**
 * POST /merchant/orders/:id/results
 * { results: [{ testCode, values: [{ parameter, value, unit?, normalRange?, low?, high? }] }],
 *   notes?, final? }
 * Saves results with flags. `final: true` marks the order ready for review
 * (release); otherwise it stays/goes to processing.
 */
exports.saveResults = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    const order = await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id });
    if (!order) return notFound(res, 'Diagnostic order');
    if (['cancelled', 'completed'].includes(order.status)) {
      return res.status(409).json({ success: false, message: `Results can't be changed on a ${order.status} order` });
    }
    if (['requested', 'scheduled'].includes(order.status)) {
      return res.status(409).json({ success: false, message: 'Collect the sample before entering results' });
    }
    const catalog = new Map((lab.services || []).map((s) => [String(s.testCode).toUpperCase(), s]));
    const incoming = Array.isArray(req.body?.results) ? req.body.results : [];
    for (const entry of incoming) {
      const code = clean(entry.testCode).toUpperCase();
      const test = order.tests.find((t) => String(t.testCode).toUpperCase() === code && t.status !== 'cancelled');
      if (!test) continue;
      test.results = buildResults(catalog.get(code), entry.values);
      if (test.results.some((r) => r.value) && test.status === 'pending') test.status = 'processing';
    }
    if (req.body?.notes !== undefined) order.resultNotes = clean(req.body.notes);
    order.resultsEnteredAt = new Date();
    order.resultsEnteredBy = req.user.id;

    const summary = resultSummary(order);
    if (req.body?.final === true) {
      if (summary.testsWithResults < summary.tests) {
        return res.status(400).json({ success: false, message: 'Enter results for every test before marking them ready' });
      }
      order.tests.forEach((t) => { if (t.status !== 'cancelled') t.status = 'ready_for_review'; });
      if (order.status !== 'ready_for_review') pushHistory(order, 'ready_for_review', 'Results entered — ready to release', req.user.id);
      order.status = 'ready_for_review';
    } else if (order.status === 'sample_collected') {
      order.status = 'processing';
      pushHistory(order, 'processing', 'Result entry started', req.user.id);
    }
    await order.save();
    res.json({ success: true, order, summary });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

/**
 * POST /merchant/orders/:id/release
 * Builds the PDF from entered results (unless one was uploaded), completes
 * the order and tells the patient.
 */
exports.releaseReport = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    const order = await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id })
      .select('+reportFile.path').populate('patientId', 'name age gender dateOfBirth userId');
    if (!order) return notFound(res, 'Diagnostic order');
    if (order.status === 'cancelled') return res.status(409).json({ success: false, message: 'This order was cancelled' });
    if (order.status === 'completed' && order.reportFile?.path) return res.json({ success: true, order, message: 'Report already released' });

    const summary = resultSummary(order);
    if (!summary.entered) return res.status(400).json({ success: false, message: 'Enter results first, or upload a report file' });

    const releasedBy = clean(req.body?.signedBy) || lab.contactPerson || lab.labName;
    const pdf = await generateLabReportPdf({ order, lab, patient: order.patientId, releasedBy });
    if (order.reportFile?.path) fs.unlink(order.reportFile.path, () => {});
    order.reportFile = { path: pdf.path, originalName: pdf.originalName, mimeType: 'application/pdf', size: pdf.size, uploadedAt: new Date(), uploadedBy: req.user.id, verifiedAt: new Date() };
    order.reportGeneratedAt = new Date();
    const wasCompleted = order.status === 'completed';
    order.status = 'completed';
    order.tests.forEach((t) => { if (t.status !== 'cancelled') { t.status = 'completed'; t.completedAt = t.completedAt || new Date(); } });
    pushHistory(order, 'completed', `Report released${releasedBy ? ` by ${releasedBy}` : ''}`, req.user.id);
    await order.save();
    if (!wasCompleted) await PathologyProfile.findByIdAndUpdate(lab._id, { $inc: { totalTestsConducted: 1 } });
    if (order.appointmentId) await Appointment.findByIdAndUpdate(order.appointmentId, { $set: { status: 'completed', actualEndTime: new Date() } });
    await notifyReportReady(order);
    res.json({ success: true, order, message: 'Report released to the patient' });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

// ── Earnings ───────────────────────────────────────────────────────────────

function rangeStart(range) {
  const today = startOfDay(new Date());
  const d = new Date(today);
  switch (range) {
    case '7d': d.setDate(d.getDate() - 6); return { start: d, by: 'day' };
    case 'month': return { start: new Date(today.getFullYear(), today.getMonth(), 1), by: 'day' };
    case 'year': return { start: new Date(today.getFullYear(), today.getMonth() - 11, 1), by: 'month' };
    case '30d':
    default: d.setDate(d.getDate() - 29); return { start: d, by: 'day' };
  }
}

/**
 * GET /merchant/earnings?range=7d|30d|month|year
 * Paid orders in the range: gross, platform commission (the lab's rate),
 * net, a day/month series, top tests, and what's still unpaid.
 */
exports.earnings = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    const range = ['7d', '30d', 'month', 'year'].includes(req.query.range) ? req.query.range : '30d';
    const { start, by } = rangeStart(range);
    const rate = Number(lab.commissionRate || 0);

    const paid = await LabTest.find({
      pathologyId: lab._id, paymentStatus: 'paid', status: { $ne: 'cancelled' },
      $or: [{ paymentDate: { $gte: start } }, { paymentDate: null, updatedAt: { $gte: start } }],
    }).select('totalAmount collectionCharges paymentDate updatedAt tests labTestNumber patientId type paymentId').populate('patientId', 'name').sort({ paymentDate: -1 }).lean();

    const unpaid = await LabTest.aggregate([
      { $match: { pathologyId: lab._id, paymentStatus: 'pending', status: { $nin: ['cancelled'] } } },
      { $group: { _id: null, amount: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]);

    const buckets = new Map();
    const keyOf = (d) => (by === 'month' ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : dateKey(d));
    // Pre-fill so quiet days still show as zero bars.
    const cursor = new Date(start);
    const end = new Date();
    while (cursor <= end) {
      buckets.set(keyOf(cursor), { key: keyOf(cursor), gross: 0, net: 0, orders: 0 });
      if (by === 'month') cursor.setMonth(cursor.getMonth() + 1); else cursor.setDate(cursor.getDate() + 1);
    }

    const tests = new Map();
    let gross = 0; let collection = 0; let online = 0;
    for (const o of paid) {
      const amount = Number(o.totalAmount || 0);
      gross += amount;
      collection += Number(o.collectionCharges || 0);
      if (o.paymentId && !/^(CASH|CARD|UPI)-/.test(o.paymentId)) online += amount;
      const k = keyOf(new Date(o.paymentDate || o.updatedAt));
      const b = buckets.get(k);
      if (b) { b.gross += amount; b.net += amount * (1 - rate / 100); b.orders += 1; }
      for (const t of o.tests || []) {
        if (t.status === 'cancelled') continue;
        const name = t.testName || t.testCode;
        const row = tests.get(name) || { name, count: 0, revenue: 0 };
        row.count += 1;
        row.revenue += Number(t.price || 0);
        tests.set(name, row);
      }
    }
    const commission = money(gross * rate / 100);
    res.json({
      success: true,
      range, by, commissionRate: rate,
      totals: {
        gross: money(gross), commission, net: money(gross - commission),
        orders: paid.length, collectionCharges: money(collection),
        online: money(online), offline: money(gross - online),
        unpaidAmount: money(unpaid[0]?.amount || 0), unpaidOrders: unpaid[0]?.count || 0,
      },
      series: [...buckets.values()].map((b) => ({ ...b, gross: money(b.gross), net: money(b.net) })),
      topTests: [...tests.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      recent: paid.slice(0, 15).map((o) => ({
        _id: o._id, labTestNumber: o.labTestNumber, patientName: o.patientId?.name || 'Patient',
        amount: o.totalAmount, net: money(Number(o.totalAmount || 0) * (1 - rate / 100)),
        paidAt: o.paymentDate || o.updatedAt, type: o.type,
        method: o.paymentId && /^(CASH|CARD|UPI)-/.test(o.paymentId) ? o.paymentId.split('-')[0].toLowerCase() : 'online',
      })),
    });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

// ── Collection timetable ───────────────────────────────────────────────────

function schedulePayload(lab) {
  return {
    success: true,
    template: { days: lab.slotTemplate?.days || [], updatedAt: lab.slotTemplate?.updatedAt || null },
    holidays: (lab.operatingHours?.holidays || []).map(dateKey).sort(),
    advanceBookingDays: lab.bookingSettings?.advanceBookingDays || 30,
    upcoming: upcomingSummary(lab, 14),
  };
}

/** GET /merchant/schedule */
exports.getSchedule = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    res.json(schedulePayload(lab));
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

/** PUT /merchant/schedule { days: [{ weekday, enabled, slots: [{ startTime, endTime, maxCapacity }] }] } */
exports.putSchedule = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    const days = normaliseTemplate(req.body?.days);
    lab.slotTemplate = { days, updatedAt: new Date() };
    await applyTemplate(lab);
    res.json({ ...schedulePayload(lab), message: 'Timetable saved' });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

/** POST /merchant/schedule/holidays { date: 'YYYY-MM-DD', closed: true|false } */
exports.setHoliday = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    const day = startOfDay(req.body?.date);
    if (Number.isNaN(day.getTime())) return res.status(400).json({ success: false, message: 'Invalid date' });
    const k = dateKey(day);
    const holidays = (lab.operatingHours?.holidays || []).filter((d) => dateKey(d) !== k);
    if (req.body?.closed !== false) {
      const slotDay = (lab.testSlots || []).find((s) => dateKey(s.date) === k);
      const booked = (slotDay?.timeSlots || []).reduce((n, s) => n + Number(s.bookedCount || 0), 0);
      if (booked > 0) return res.status(409).json({ success: false, message: `${booked} booking${booked === 1 ? '' : 's'} on this day — reschedule them before closing` });
      holidays.push(day);
      lab.testSlots = (lab.testSlots || []).filter((s) => dateKey(s.date) !== k);
    }
    lab.operatingHours = { ...(lab.operatingHours?.toObject?.() || lab.operatingHours || {}), holidays };
    lab.markModified('operatingHours');
    await lab.save();
    if (req.body?.closed === false && lab.slotTemplate?.days?.length) await applyTemplate(lab);
    res.json(schedulePayload(lab));
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

// ── Starter library ────────────────────────────────────────────────────────

/** GET /merchant/catalog/library — common tests, marking ones already added. */
exports.getLibrary = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    const have = new Set((lab.services || []).filter((s) => s.isActive !== false).map((s) => String(s.testCode).toUpperCase()));
    res.json({ success: true, tests: LIBRARY.map((t) => ({ ...t, added: have.has(t.testCode) })) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

/** POST /merchant/catalog/import { items: [{ testCode, price? }] } */
exports.importLibrary = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return notFound(res);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ success: false, message: 'Choose at least one test' });
    const byCode = new Map(LIBRARY.map((t) => [t.testCode, t]));
    let added = 0; let restored = 0;
    for (const item of items) {
      const code = clean(item.testCode).toUpperCase();
      const src = byCode.get(code);
      if (!src) continue;
      const price = Number.isFinite(Number(item.price)) && Number(item.price) >= 0 ? Number(item.price) : src.price;
      const existing = (lab.services || []).find((s) => String(s.testCode).toUpperCase() === code);
      if (existing) {
        if (existing.isActive === false) { existing.isActive = true; restored += 1; }
        if (!existing.parameters?.length) existing.parameters = src.parameters;
        continue;
      }
      lab.services.push({
        testCode: src.testCode, testName: src.testName, category: src.category, sampleType: src.sampleType,
        price, mrp: price, reportTime: src.reportTime, fastingRequired: !!src.fastingRequired,
        fastingHours: src.fastingHours || 0, homeCollectionEligible: true, isActive: true,
        parameters: src.parameters,
      });
      added += 1;
    }
    await lab.save();
    res.json({ success: true, added, restored, tests: lab.services, message: `${added + restored} test${added + restored === 1 ? '' : 's'} added` });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
