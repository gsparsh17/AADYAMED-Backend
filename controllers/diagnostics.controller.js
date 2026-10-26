const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const PathologyProfile = require('../models/PathologyProfile');
const PathologyStaff = require('../models/PathologyStaff');
const PatientProfile = require('../models/PatientProfile');
const Prescription = require('../models/Prescription');
const LabTest = require('../models/LabTest');
const Appointment = require('../models/Appointment');
const { voidPendingCommissionsForAppointment } = require('../services/appointmentCommission.service');
const {
  startOfDay,
  mapAvailableSlots,
  buildCatalogSelection,
  reserveSlot,
  releaseSlot,
} = require('../services/diagnostics.service');
const { createNotification } = require('../services/notification.service');
const { resultSummary } = require('../services/labResults.service');
const { notifyReportReady } = require('./labOps.controller');

const escapeRx = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** When the report is due: sample collection + the slowest test's TAT. */
function reportDueAt(order) {
  const hours = Math.max(0, ...(order.tests || []).filter((t) => t.status !== 'cancelled').map((t) => Number(t.reportTime || 0)));
  if (!hours) return null;
  const from = order.collectedAt || order.sample?.collectionTime;
  if (!from) return null;
  return new Date(new Date(from).getTime() + hours * 3600000);
}

const OPEN_STATUSES = ['requested', 'scheduled', 'sample_collected', 'processing', 'ready_for_review'];
const BUCKETS = {
  collect: { status: { $in: ['requested', 'scheduled'] } },
  processing: { status: { $in: ['sample_collected', 'processing'] } },
  reports: { status: 'ready_for_review' },
  completed: { status: 'completed' },
  cancelled: { status: 'cancelled' },
  home: { type: 'home_collection', status: { $in: ['requested', 'scheduled'] } },
};

/** Adds the fields the app shows on every card: due time, overdue, result counts. */
function decorate(order) {
  const o = order.toObject ? order.toObject() : order;
  const due = reportDueAt(o);
  return {
    ...o,
    reportDueAt: due,
    overdue: !!due && OPEN_STATUSES.includes(o.status) && due.getTime() < Date.now(),
    resultSummary: resultSummary(o),
  };
}

const clean = value => String(value || '').trim();
const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const publicLabFields = 'labName profileImage phone email website address services packages homeCollectionAvailable homeCollectionCharges homeCollectionPincodes bookingSettings operatingHours accreditation averageRating totalReviews verificationStatus';

async function patientForUser(user) {
  if (user.role !== 'patient') return null;
  if (user.profileId) {
    const byId = await PatientProfile.findById(user.profileId);
    if (byId) return byId;
  }
  return PatientProfile.findOne({ userId: user.id });
}

async function labForUser(user) {
  if (user.role !== 'pathology') return null;
  if (user.profileId) {
    const byId = await PathologyProfile.findById(user.profileId);
    if (byId && String(byId.userId) === String(user.id)) return byId;
  }
  return PathologyProfile.findOne({ userId: user.id });
}

function collectionAddressText(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  return [address.line1, address.line2, address.landmark, address.city, address.state, address.pincode]
    .filter(Boolean).join(', ');
}

function addressPayload(address, patient) {
  if (!address || typeof address === 'string') return undefined;
  return {
    contactName: clean(address.contactName || patient?.name),
    phone: clean(address.phone || patient?.phone),
    line1: clean(address.line1), line2: clean(address.line2), landmark: clean(address.landmark),
    city: clean(address.city), state: clean(address.state), pincode: clean(address.pincode),
    location: Array.isArray(address.location?.coordinates) && address.location.coordinates.length === 2
      ? { type: 'Point', coordinates: address.location.coordinates.map(Number) }
      : undefined,
  };
}

function canDownloadReport(user, order) {
  if (user.role === 'admin') return true;
  if (user.role === 'patient') return user.profileId && String(order.patientId?._id || order.patientId) === String(user.profileId);
  if (user.role === 'pathology') return user.profileId && String(order.pathologyId?._id || order.pathologyId) === String(user.profileId);
  if (user.role === 'doctor') return user.profileId && String(order.doctorId?._id || order.doctorId) === String(user.profileId);
  return false;
}

async function attemptRefund(order) {
  if (order.paymentStatus !== 'paid' || !order.razorpayPaymentId) return { skipped: true };
  const key_id = process.env.RAZORPAY_KEY_ID?.trim();
  const key_secret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!key_id || !key_secret) {
    order.refundPending = true;
    order.refundRequestedAt = new Date();
    order.refundFailureReason = 'Razorpay is not configured';
    return { pending: true };
  }
  try {
    const razorpay = new Razorpay({ key_id, key_secret });
    const refund = await razorpay.payments.refund(order.razorpayPaymentId, {
      amount: Math.round(Number(order.totalAmount || 0) * 100),
      notes: { entityType: 'labtest', labTestId: String(order._id) },
    });
    order.paymentStatus = 'refunded';
    order.refundPending = false;
    order.refundId = refund.id;
    order.refundedAt = new Date();
    order.refundFailureReason = undefined;
    return { refunded: true, refundId: refund.id };
  } catch (error) {
    order.refundPending = true;
    order.refundRequestedAt = new Date();
    order.refundFailureReason = error.error?.description || error.message;
    return { pending: true, error: order.refundFailureReason };
  }
}

function pushHistory(order, status, note, userId) {
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({ status, note, actorId: userId, at: new Date() });
}

exports.listLabs = async (req, res) => {
  try {
    const { search, city, pincode, homeCollection, testCode, packageCode, page = 1, limit = 20 } = req.query;
    const filter = { verificationStatus: 'approved' };
    if (city) filter['address.city'] = { $regex: clean(city), $options: 'i' };
    if (homeCollection === 'true') filter.homeCollectionAvailable = true;
    if (pincode) {
      filter.$or = [{ 'address.pincode': clean(pincode) }, { homeCollectionPincodes: clean(pincode) }];
    }
    if (testCode) filter.services = { $elemMatch: { testCode: clean(testCode), isActive: { $ne: false } } };
    if (packageCode) filter.packages = { $elemMatch: { packageCode: clean(packageCode), isActive: { $ne: false } } };
    if (search) {
      const regex = { $regex: clean(search), $options: 'i' };
      const clauses = [{ labName: regex }, { 'services.testName': regex }, { 'services.testCode': regex }, { 'packages.packageName': regex }];
      if (filter.$or) filter.$and = [{ $or: filter.$or }, { $or: clauses }], delete filter.$or;
      else filter.$or = clauses;
    }
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const [labs, total] = await Promise.all([
      PathologyProfile.find(filter).select(publicLabFields).sort({ averageRating: -1, createdAt: -1 })
        .skip((pageNumber - 1) * pageSize).limit(pageSize),
      PathologyProfile.countDocuments(filter),
    ]);
    res.json({ success: true, labs, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getLab = async (req, res) => {
  try {
    const lab = await PathologyProfile.findOne({ _id: req.params.id, verificationStatus: 'approved' }).select(publicLabFields);
    if (!lab) return res.status(404).json({ success: false, message: 'Lab not found' });
    res.json({ success: true, lab });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.searchCatalog = async (req, res) => {
  try {
    const { q, city, pincode, homeCollection } = req.query;
    const filter = { verificationStatus: 'approved' };
    if (city) filter['address.city'] = { $regex: clean(city), $options: 'i' };
    if (pincode) filter.$or = [{ 'address.pincode': clean(pincode) }, { homeCollectionPincodes: clean(pincode) }];
    if (homeCollection === 'true') filter.homeCollectionAvailable = true;
    const labs = await PathologyProfile.find(filter).select(publicLabFields).limit(100);
    const term = clean(q).toLowerCase();
    const items = [];
    for (const lab of labs) {
      for (const test of lab.services || []) {
        if (test.isActive === false) continue;
        if (homeCollection === 'true' && test.homeCollectionEligible === false) continue;
        if (term && !`${test.testName} ${test.testCode} ${test.category || ''}`.toLowerCase().includes(term)) continue;
        items.push({ kind: 'test', labId: lab._id, labName: lab.labName, labAddress: lab.address, homeCollectionAvailable: lab.homeCollectionAvailable, homeCollectionCharges: lab.homeCollectionCharges || 0, item: test });
      }
      for (const pkg of lab.packages || []) {
        if (pkg.isActive === false) continue;
        if (term && !`${pkg.packageName} ${pkg.packageCode || ''} ${pkg.description || ''}`.toLowerCase().includes(term)) continue;
        items.push({ kind: 'package', labId: lab._id, labName: lab.labName, labAddress: lab.address, homeCollectionAvailable: lab.homeCollectionAvailable, homeCollectionCharges: lab.homeCollectionCharges || 0, item: pkg });
      }
    }
    items.sort((a, b) => Number(a.item.price || 0) - Number(b.item.price || 0));
    res.json({ success: true, items: items.slice(0, 100) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getSlots = async (req, res) => {
  try {
    const lab = await PathologyProfile.findOne({ _id: req.params.id, verificationStatus: 'approved' })
      .select('labName testSlots bookingSettings operatingHours homeCollectionAvailable homeCollectionCharges');
    if (!lab) return res.status(404).json({ success: false, message: 'Lab not found' });
    const date = req.query.date || new Date();
    const day = startOfDay(date);
    if (Number.isNaN(day.getTime())) return res.status(400).json({ success: false, message: 'Invalid date' });
    const holidays = (lab.operatingHours?.holidays || []).map(d => startOfDay(d).getTime());
    const slots = holidays.includes(day.getTime()) ? [] : mapAvailableSlots(lab, day);
    res.json({ success: true, date: day, slots, homeCollectionAvailable: lab.homeCollectionAvailable, homeCollectionCharges: lab.homeCollectionCharges || 0 });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const patient = await patientForUser(req.user);
    if (!patient) return res.status(404).json({ success: false, message: 'Patient profile not found' });
    const { labId, testCodes = [], packageCodes = [], date, startTime, endTime, type = 'lab_visit', collectionAddress, patientInstructions, prescriptionId } = req.body || {};
    if (!labId || !date || !startTime || !endTime) return res.status(400).json({ success: false, message: 'labId, date, startTime and endTime are required' });
    const collectionType = ['home', 'home_collection'].includes(type) ? 'home_collection' : 'lab_visit';
    const lab = await PathologyProfile.findById(labId).select(`${publicLabFields} commissionRate`);
    if (!lab || lab.verificationStatus !== 'approved') return res.status(400).json({ success: false, message: 'Selected lab is unavailable' });
    if (collectionType === 'home_collection') {
      if (!lab.homeCollectionAvailable) return res.status(400).json({ success: false, message: 'Home collection is not available at this lab' });
      const addr = addressPayload(collectionAddress, patient);
      if (!addr?.line1 || !addr?.city || !addr?.state || !addr?.pincode) return res.status(400).json({ success: false, message: 'Complete home collection address is required' });
      if (lab.homeCollectionPincodes?.length && !lab.homeCollectionPincodes.includes(addr.pincode)) {
        return res.status(400).json({ success: false, message: 'Home collection is not available for this pincode' });
      }
    }
    let prescription;
    if (prescriptionId) {
      prescription = await Prescription.findOne({ _id: prescriptionId, patientId: patient._id, status: { $in: ['issued', 'superseded'] } });
      if (!prescription) return res.status(400).json({ success: false, message: 'Invalid prescription for this patient' });
    }
    const selection = buildCatalogSelection(lab, testCodes, packageCodes, collectionType);
    const collectionCharges = collectionType === 'home_collection' ? Number(lab.homeCollectionCharges || 0) : 0;
    const totalAmount = money(selection.subtotal + collectionCharges);
    const commissionRate = Number(lab.commissionRate || 0);
    const platformCommission = money(totalAmount * commissionRate / 100);
    const professionalEarning = money(totalAmount - platformCommission);
    let labTest;
    await session.withTransaction(async () => {
      await reserveSlot({ pathologyId: lab._id, date, startTime, endTime, session });
      const appointment = (await Appointment.create([{
        patientId: patient._id,
        pathologyId: lab._id,
        professionalType: 'pathology',
        appointmentDate: startOfDay(date),
        startTime, endTime,
        type: collectionType === 'home_collection' ? 'home' : 'clinic',
        address: collectionType === 'home_collection' ? collectionAddressText(collectionAddress) : undefined,
        status: 'confirmed',
        consultationFee: selection.subtotal,
        homeVisitCharges: collectionCharges,
        platformCommission,
        professionalEarning,
        totalAmount,
        paymentStatus: 'pending',
        notes: clean(patientInstructions),
        createdBy: req.user.id,
        bookedBy: 'patient',
      }], { session }))[0];
      labTest = (await LabTest.create([{
        appointmentId: appointment._id,
        prescriptionId: prescription?._id,
        patientId: patient._id,
        doctorId: prescription?.doctorId,
        pathologyId: lab._id,
        tests: selection.tests,
        packages: selection.packages,
        scheduledDate: startOfDay(date),
        scheduledTime: startTime,
        startTime, endTime,
        type: collectionType,
        collectionAddress: collectionType === 'home_collection' ? collectionAddressText(collectionAddress) : undefined,
        collectionAddressDetails: collectionType === 'home_collection' ? addressPayload(collectionAddress, patient) : undefined,
        patientInstructions: clean(patientInstructions),
        subtotal: selection.subtotal,
        collectionCharges,
        totalAmount,
        paymentStatus: 'pending',
        status: 'scheduled',
        collectionStatus: collectionType === 'home_collection' ? 'unassigned' : 'not_required',
        fastingRequired: selection.fastingRequired,
        fastingHours: selection.fastingHours,
        instructions: selection.fastingRequired ? `Fasting required for ${selection.fastingHours || 8} hours` : undefined,
        bookingSource: 'patient_web',
        statusHistory: [{ status: 'scheduled', note: 'Diagnostic order booked', actorId: req.user.id, at: new Date() }],
      }], { session }))[0];
    });
    await PatientProfile.findByIdAndUpdate(patient._id, { $inc: { totalLabTests: 1 } });
    notifyLabOfBooking(lab._id, labTest, patient).catch((e) => console.error('Lab booking alert failed:', e.message));
    res.status(201).json({ success: true, order: labTest, payable: { entityType: 'labtest', entityId: labTest._id, amount: totalAmount } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
};

/** Tells the lab about a booking (high priority — collections are time-bound). */
async function notifyLabOfBooking(labId, order, patient) {
  const lab = await PathologyProfile.findById(labId).select('userId');
  if (!lab?.userId) return;
  const tests = (order.tests || []).map((t) => t.testName).filter(Boolean);
  const what = tests.length > 2 ? `${tests.slice(0, 2).join(', ')} +${tests.length - 2}` : tests.join(', ');
  const when = `${new Date(order.scheduledDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${order.startTime || ''}`.trim();
  await createNotification({
    userId: lab.userId, userRole: 'pathology',
    title: order.type === 'home_collection' ? 'New home collection' : 'New lab booking',
    message: `${patient.name} · ${what} · ${when}`,
    type: 'lab_order', priority: 'high', channels: ['in_app', 'push'],
    relatedEntity: 'labtest', relatedEntityId: order._id,
    data: { entityType: 'labtest', labTestId: String(order._id) },
  });
}

/**
 * The patient's view of an order: results stay with the lab until it
 * releases the report (status 'completed'). They used to be visible while
 * still being entered or reviewed.
 */
function forPatient(order) {
  const o = order.toObject ? order.toObject() : order;
  if (o.status !== 'completed') {
    delete o.results;
    delete o.resultNotes;
    o.tests = (o.tests || []).map(({ results, ...t }) => t);
  }
  return o;
}

exports.listPatientOrders = async (req, res) => {
  try {
    const patient = await patientForUser(req.user);
    if (!patient) return res.status(404).json({ success: false, message: 'Patient profile not found' });
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { patientId: patient._id };
    if (status) filter.status = { $in: clean(status).split(',').filter(Boolean) };
    const pageNumber = Math.max(1, parseInt(page, 10) || 1), pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const [orders, total] = await Promise.all([
      LabTest.find(filter).populate('pathologyId', 'labName phone address').populate('assignedPhlebotomistId', 'name phone employeeCode')
        .sort({ createdAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize),
      LabTest.countDocuments(filter),
    ]);
    res.json({ success: true, orders: orders.map(forPatient), pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getPatientOrder = async (req, res) => {
  try {
    const patient = await patientForUser(req.user);
    const order = patient && await LabTest.findOne({ _id: req.params.id, patientId: patient._id })
      .populate('pathologyId', 'labName phone email address').populate('assignedPhlebotomistId', 'name phone employeeCode');
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    res.json({ success: true, order: forPatient(order) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.rescheduleOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const patient = await patientForUser(req.user);
    const order = patient && await LabTest.findOne({ _id: req.params.id, patientId: patient._id });
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    if (!['scheduled', 'requested'].includes(order.status)) return res.status(409).json({ success: false, message: 'This order can no longer be rescheduled' });
    const { date, startTime, endTime } = req.body || {};
    if (!date || !startTime || !endTime) return res.status(400).json({ success: false, message: 'date, startTime and endTime are required' });
    await session.withTransaction(async () => {
      await reserveSlot({ pathologyId: order.pathologyId, date, startTime, endTime, session });
      await releaseSlot({ pathologyId: order.pathologyId, date: order.scheduledDate, startTime: order.startTime || order.scheduledTime, endTime: order.endTime, session });
      order.scheduledDate = startOfDay(date); order.scheduledTime = startTime; order.startTime = startTime; order.endTime = endTime;
      pushHistory(order, 'scheduled', 'Patient rescheduled diagnostic order', req.user.id);
      await order.save({ session });
      if (order.appointmentId) await Appointment.findByIdAndUpdate(order.appointmentId, { $set: { appointmentDate: startOfDay(date), startTime, endTime, status: 'rescheduled', rescheduleReason: 'Diagnostic order rescheduled by patient' }, $inc: { rescheduleCount: 1 } }, { session });
    });
    res.json({ success: true, order });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
};

exports.cancelOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const patient = await patientForUser(req.user);
    const order = patient && await LabTest.findOne({ _id: req.params.id, patientId: patient._id });
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    if (order.status === 'cancelled') return res.json({ success: true, order, message: 'Order already cancelled' });
    if (!['requested', 'scheduled'].includes(order.status)) return res.status(409).json({ success: false, message: 'Sample processing has started; cancellation is no longer available' });
    const lab = await PathologyProfile.findById(order.pathologyId).select('bookingSettings');
    const scheduledAt = new Date(order.scheduledDate); const [h, m] = String(order.startTime || order.scheduledTime || '00:00').split(':').map(Number); scheduledAt.setHours(h || 0, m || 0, 0, 0);
    const windowHours = Number(lab?.bookingSettings?.cancellationWindowHours || 0);
    if (scheduledAt.getTime() - Date.now() < windowHours * 3600000) return res.status(409).json({ success: false, message: `Cancellation closes ${windowHours} hours before the appointment` });
    await session.withTransaction(async () => {
      await releaseSlot({ pathologyId: order.pathologyId, date: order.scheduledDate, startTime: order.startTime || order.scheduledTime, endTime: order.endTime, session });
      order.status = 'cancelled'; order.cancelledBy = 'patient'; order.cancellationReason = clean(req.body?.reason) || 'Cancelled by patient'; order.cancelledAt = new Date();
      pushHistory(order, 'cancelled', order.cancellationReason, req.user.id);
      await order.save({ session });
      if (order.appointmentId) await Appointment.findByIdAndUpdate(order.appointmentId, { $set: { status: 'cancelled', cancelledBy: 'patient', cancellationReason: order.cancellationReason, cancelledAt: new Date() } }, { session });
    });
    // Linked appointment is now cancelled: stop its pending commission counting as earnings.
    if (order.appointmentId) await voidPendingCommissionsForAppointment(order.appointmentId, 'Commission voided: appointment cancelled').catch((e) => console.error('Commission void failed:', e.message));
    const refund = await attemptRefund(order); await order.save();
    res.json({ success: true, order, refund });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
};

exports.downloadReport = async (req, res) => {
  try {
    const order = await LabTest.findById(req.params.id).select('+reportFile.path').populate('patientId', '_id').populate('pathologyId', '_id');
    if (!order || !canDownloadReport(req.user, order)) return res.status(404).json({ success: false, message: 'Report not found' });
    if (!order.reportFile?.path) return res.status(404).json({ success: false, message: 'Report file is not available' });
    const resolved = path.resolve(order.reportFile.path);
    const root = path.resolve(process.cwd(), 'uploads', 'lab-reports');
    if (!resolved.startsWith(root) || !fs.existsSync(resolved)) return res.status(404).json({ success: false, message: 'Report file is missing' });
    if (req.user.role === 'patient' && !order.reportViewedByPatient) {
      order.reportViewedByPatient = true; order.reportViewedAt = new Date(); await order.save();
    }
    res.download(resolved, order.reportFile.originalName || `${order.labTestNumber}.pdf`);
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.merchantDashboard = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return res.status(404).json({ success: false, message: 'Pathology profile not found' });
    const today = startOfDay(new Date());
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const month = new Date(today.getFullYear(), today.getMonth(), 1);
    const week = new Date(today); week.setDate(today.getDate() + 7);
    const base = { pathologyId: lab._id };
    const [counts, todayList, open, revenueToday, revenueMonth, completedToday, staffCount] = await Promise.all([
      LabTest.aggregate([{ $match: { ...base, status: { $in: OPEN_STATUSES } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      LabTest.find({ ...base, scheduledDate: { $gte: today, $lt: tomorrow }, status: { $ne: 'cancelled' } })
        .populate('patientId', 'name phone age gender').populate('assignedPhlebotomistId', 'name phone').sort({ startTime: 1 }).limit(60),
      LabTest.find({ ...base, status: { $in: OPEN_STATUSES } })
        .select('tests status collectedAt sample type collectionStatus scheduledDate startTime labTestNumber patientId assignedPhlebotomistId totalAmount paymentStatus')
        .populate('patientId', 'name phone').limit(300),
      LabTest.aggregate([{ $match: { ...base, paymentStatus: 'paid', paymentDate: { $gte: today } } }, { $group: { _id: null, amount: { $sum: '$totalAmount' } } }]),
      LabTest.aggregate([{ $match: { ...base, paymentStatus: 'paid', paymentDate: { $gte: month } } }, { $group: { _id: null, amount: { $sum: '$totalAmount' } } }]),
      LabTest.countDocuments({ ...base, status: 'completed', reportGeneratedAt: { $gte: today } }),
      PathologyStaff.countDocuments({ pathologyId: lab._id, isActive: true, role: 'phlebotomist' }),
    ]);
    const by = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    const decorated = open.map(decorate);
    const overdue = decorated.filter((o) => o.overdue);
    const unassigned = decorated.filter((o) => o.type === 'home_collection' && o.collectionStatus === 'unassigned' && new Date(o.scheduledDate) < week);
    const slotDays = (lab.testSlots || []).filter((d) => new Date(d.date) >= today && new Date(d.date) < week && (d.timeSlots || []).length).length;
    res.json({
      success: true,
      lab: {
        labName: lab.labName, averageRating: lab.averageRating, verificationStatus: lab.verificationStatus,
        homeCollectionAvailable: lab.homeCollectionAvailable, commissionRate: lab.commissionRate,
        catalogCount: (lab.services || []).filter((t) => t.isActive !== false).length,
        packageCount: (lab.packages || []).filter((t) => t.isActive !== false).length,
        staffCount, slotDaysThisWeek: slotDays, hasTemplate: !!lab.slotTemplate?.days?.length,
      },
      stats: {
        toCollect: (by.requested || 0) + (by.scheduled || 0),
        inProcess: (by.sample_collected || 0) + (by.processing || 0),
        reportsDue: by.ready_for_review || 0,
        overdue: overdue.length,
        unassignedCollections: unassigned.length,
        todayOrders: todayList.length,
        completedToday,
        revenueToday: revenueToday[0]?.amount || 0,
        monthlyPaidRevenue: revenueMonth[0]?.amount || 0,
        // Older app builds read these.
        pending: OPEN_STATUSES.reduce((n, k) => n + (by[k] || 0), 0),
        upcomingHomeCollections: decorated.filter((o) => o.type === 'home_collection' && ['requested', 'scheduled'].includes(o.status)).length,
      },
      today: todayList.map(decorate),
      attention: [...overdue, ...unassigned].slice(0, 10),
    });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.merchantOrders = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return res.status(404).json({ success: false, message: 'Pathology profile not found' });
    const { status, type, collectionStatus, date, bucket, q, page = 1, limit = 25 } = req.query;
    const filter = { pathologyId: lab._id };
    if (bucket && BUCKETS[bucket]) Object.assign(filter, BUCKETS[bucket]);
    if (status) filter.status = { $in: clean(status).split(',').filter(Boolean) };
    if (clean(q)) {
      const rx = new RegExp(escapeRx(clean(q)), 'i');
      const patients = await PatientProfile.find({ $or: [{ name: rx }, { phone: rx }] }).select('_id').limit(50);
      filter.$or = [{ labTestNumber: rx }, { 'sample.barcode': rx }, { patientId: { $in: patients.map((p) => p._id) } }];
    }
    if (type) filter.type = type;
    if (collectionStatus) filter.collectionStatus = collectionStatus;
    if (date) { const d = startOfDay(date); const e = new Date(d); e.setHours(23, 59, 59, 999); filter.scheduledDate = { $gte: d, $lte: e }; }
    const pageNumber = Math.max(1, parseInt(page, 10) || 1), pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const [orders, total] = await Promise.all([
      LabTest.find(filter).populate('patientId', 'name phone age gender address').populate('assignedPhlebotomistId', 'name phone employeeCode role').sort({ scheduledDate: -1, startTime: 1 }).skip((pageNumber - 1) * pageSize).limit(pageSize),
      LabTest.countDocuments(filter),
    ]);
    res.json({ success: true, orders: orders.map(decorate), pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.merchantOrder = async (req, res) => {
  try {
    const lab = await labForUser(req.user);
    const order = lab && await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id }).populate('patientId', 'name phone email age gender bloodGroup address').populate('prescriptionId').populate('assignedPhlebotomistId');
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    // Each test's parameters, so result entry knows what to ask for.
    const codes = new Set((order.tests || []).map((t) => String(t.testCode).toUpperCase()));
    const catalog = Object.fromEntries((lab.services || [])
      .filter((t) => codes.has(String(t.testCode).toUpperCase()))
      .map((t) => [String(t.testCode).toUpperCase(), { parameters: t.parameters || [], sampleType: t.sampleType, reportTime: t.reportTime }]));
    res.json({ success: true, order: decorate(order), catalog });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.assignCollector = async (req, res) => {
  try {
    const lab = await labForUser(req.user); if (!lab) return res.status(404).json({ success: false, message: 'Pathology profile not found' });
    const order = await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id });
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    if (order.type !== 'home_collection') return res.status(409).json({ success: false, message: 'Collector assignment applies only to home collection orders' });
    const staff = await PathologyStaff.findOne({ _id: req.body?.staffId, pathologyId: lab._id, role: 'phlebotomist', isActive: true });
    if (!staff) return res.status(400).json({ success: false, message: 'Active phlebotomist not found' });
    order.assignedPhlebotomistId = staff._id; order.collectionStatus = 'assigned'; order.assignedAt = new Date(); pushHistory(order, order.status, `Assigned to ${staff.name}`, req.user.id); await order.save();
    res.json({ success: true, order: await order.populate('assignedPhlebotomistId', 'name phone employeeCode') });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

exports.updateCollectionStatus = async (req, res) => {
  try {
    const lab = await labForUser(req.user); const order = lab && await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id });
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    const status = req.body?.status;
    const allowed = ['assigned', 'en_route', 'arrived', 'collected', 'delivered_to_lab', 'failed'];
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid collection status' });
    order.collectionStatus = status;
    const now = new Date();
    if (status === 'en_route') order.enRouteAt = now;
    if (status === 'arrived') order.arrivedAt = now;
    if (status === 'collected') { order.collectedAt = now; order.status = 'sample_collected'; order.sample = { ...(order.sample?.toObject?.() || order.sample || {}), collectionTime: now, collectedBy: req.body?.collectedBy || 'Phlebotomist', sampleType: req.body?.sampleType || order.tests?.[0]?.sampleType, barcode: clean(req.body?.barcode), notes: clean(req.body?.notes) }; }
    if (status === 'delivered_to_lab') order.deliveredToLabAt = now;
    if (status === 'failed') order.collectionFailureReason = clean(req.body?.reason) || 'Collection failed';
    pushHistory(order, order.status, `Collection status: ${status}`, req.user.id); await order.save();
    res.json({ success: true, order });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const lab = await labForUser(req.user); const order = lab && await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id });
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    const status = req.body?.status;
    const allowed = ['scheduled', 'sample_collected', 'processing', 'ready_for_review', 'completed', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid diagnostic status' });
    if (order.status === 'completed' && status !== 'completed') return res.status(409).json({ success: false, message: 'Completed order cannot be reopened' });
    if (order.status === 'cancelled' && status !== 'cancelled') return res.status(409).json({ success: false, message: 'Cancelled order cannot be reopened' });
    const previousStatus = order.status;
    const wasCompleted = previousStatus === 'completed';
    if (status === 'cancelled' && previousStatus !== 'cancelled') {
      if (!['requested', 'scheduled'].includes(previousStatus)) {
        return res.status(409).json({ success: false, message: 'Order can only be cancelled before sample collection starts' });
      }
      await releaseSlot({ pathologyId: order.pathologyId, date: order.scheduledDate, startTime: order.startTime || order.scheduledTime, endTime: order.endTime });
      order.cancelledBy = 'pathology';
      order.cancellationReason = clean(req.body?.note || req.body?.reason) || 'Cancelled by pathology';
      order.cancelledAt = new Date();
    }
    order.status = status;
    if (status === 'sample_collected') {
      if (!['requested', 'scheduled'].includes(previousStatus)) return res.status(409).json({ success: false, message: 'Sample is already collected' });
      order.collectedAt = order.collectedAt || new Date();
      order.sample = {
        ...(order.sample?.toObject?.() || order.sample || {}),
        collectionTime: order.collectedAt,
        collectedBy: clean(req.body?.collectedBy) || 'Lab',
        sampleType: clean(req.body?.sampleType) || order.tests?.[0]?.sampleType,
        barcode: clean(req.body?.barcode) || order.sample?.barcode,
        receivedAtLab: new Date(),
      };
      order.tests.forEach((t) => { if (t.status === 'pending') t.status = 'sample_collected'; });
    }
    if (status === 'completed') {
      order.tests.forEach(t => { if (t.status !== 'cancelled') { t.status = 'completed'; t.completedAt = t.completedAt || new Date(); } });
      if (!wasCompleted) await PathologyProfile.findByIdAndUpdate(lab._id, { $inc: { totalTestsConducted: 1 } });
      if (order.appointmentId) await Appointment.findByIdAndUpdate(order.appointmentId, { $set: { status: 'completed', actualEndTime: new Date() } });
    }
    pushHistory(order, status, clean(req.body?.note || req.body?.reason) || `Status changed to ${status}`, req.user.id); await order.save();
    if (status === 'cancelled' && previousStatus !== 'cancelled') {
      if (order.appointmentId) await Appointment.findByIdAndUpdate(order.appointmentId, { $set: { status: 'cancelled', cancelledBy: 'professional', cancellationReason: order.cancellationReason, cancelledAt: new Date() } });
      if (order.appointmentId) await voidPendingCommissionsForAppointment(order.appointmentId, 'Commission voided: appointment cancelled').catch((e) => console.error('Commission void failed:', e.message));
      await attemptRefund(order);
      await order.save();
    }
    res.json({ success: true, order });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

exports.uploadReport = async (req, res) => {
  try {
    const lab = await labForUser(req.user); const order = lab && await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id }).select('+reportFile.path');
    if (!order) { if (req.file?.path) fs.unlink(req.file.path, () => {}); return res.status(404).json({ success: false, message: 'Diagnostic order not found' }); }
    if (!req.file) return res.status(400).json({ success: false, message: 'Report file is required' });
    const wasCompleted = order.status === 'completed';
    if (order.reportFile?.path) fs.unlink(order.reportFile.path, () => {});
    order.reportFile = { path: req.file.path, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, uploadedAt: new Date(), uploadedBy: req.user.id, verifiedAt: new Date() };
    order.reportUrl = undefined; order.reportGeneratedAt = new Date(); order.status = 'completed';
    order.tests.forEach(t => { if (t.status !== 'cancelled') { t.status = 'completed'; t.completedAt = t.completedAt || new Date(); } });
    pushHistory(order, 'completed', 'Lab report uploaded and released', req.user.id); await order.save();
    if (!wasCompleted) await PathologyProfile.findByIdAndUpdate(lab._id, { $inc: { totalTestsConducted: 1 } });
    if (order.appointmentId) await Appointment.findByIdAndUpdate(order.appointmentId, { $set: { status: 'completed', actualEndTime: new Date() } });
    await notifyReportReady(order);
    res.json({ success: true, order, message: 'Report uploaded successfully' });
  } catch (error) { if (req.file?.path) fs.unlink(req.file.path, () => {}); res.status(400).json({ success: false, message: error.message }); }
};

exports.recordOfflinePayment = async (req, res) => {
  try {
    const lab = await labForUser(req.user);
    const order = lab && await LabTest.findOne({ _id: req.params.id, pathologyId: lab._id });
    if (!order) return res.status(404).json({ success: false, message: 'Diagnostic order not found' });
    if (order.status === 'cancelled') return res.status(409).json({ success: false, message: 'Cannot collect payment for a cancelled order' });
    if (order.paymentStatus === 'paid') return res.json({ success: true, order, message: 'Payment already recorded' });
    if (order.paymentStatus === 'refunded') return res.status(409).json({ success: false, message: 'Refunded order cannot be marked paid' });
    const method = ['cash', 'card', 'upi'].includes(req.body?.method) ? req.body.method : 'cash';
    order.paymentStatus = 'paid';
    order.paymentDate = new Date();
    order.paymentId = `${method.toUpperCase()}-${Date.now()}-${String(order._id).slice(-6)}`;
    pushHistory(order, order.status, `Offline payment received via ${method}`, req.user.id);
    await order.save();
    res.json({ success: true, order, message: 'Offline payment recorded' });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

exports.listStaff = async (req, res) => {
  try { const lab = await labForUser(req.user); if (!lab) return res.status(404).json({ success: false, message: 'Pathology profile not found' }); const staff = await PathologyStaff.find({ pathologyId: lab._id }).sort({ isActive: -1, name: 1 }).lean();
    // Today's collections per phlebotomist, for assigning fairly.
    const today = startOfDay(new Date()); const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const load = await LabTest.aggregate([
      { $match: { pathologyId: lab._id, assignedPhlebotomistId: { $ne: null }, scheduledDate: { $gte: today, $lt: tomorrow }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$assignedPhlebotomistId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $in: ['$collectionStatus', ['collected', 'delivered_to_lab']] }, 1, 0] } } } },
    ]);
    const byId = new Map(load.map((l) => [String(l._id), l]));
    res.json({ success: true, staff: staff.map((m) => ({ ...m, todayAssigned: byId.get(String(m._id))?.total || 0, todayCollected: byId.get(String(m._id))?.done || 0 })) }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};
exports.createStaff = async (req, res) => {
  try { const lab = await labForUser(req.user); if (!lab) return res.status(404).json({ success: false, message: 'Pathology profile not found' }); const staff = await PathologyStaff.create({ pathologyId: lab._id, employeeCode: clean(req.body?.employeeCode) || undefined, name: clean(req.body?.name), phone: clean(req.body?.phone), email: clean(req.body?.email) || undefined, role: req.body?.role || 'phlebotomist', servicePincodes: req.body?.servicePincodes || [], notes: clean(req.body?.notes) }); res.status(201).json({ success: true, staff }); }
  catch (error) { res.status(400).json({ success: false, message: error.code === 11000 ? 'Employee code already exists' : error.message }); }
};
exports.updateStaff = async (req, res) => {
  try { const lab = await labForUser(req.user); const allowed = ['employeeCode','name','phone','email','role','servicePincodes','isActive','notes']; const updates = {}; for (const key of allowed) if (req.body?.[key] !== undefined) updates[key] = req.body[key]; const staff = lab && await PathologyStaff.findOneAndUpdate({ _id: req.params.id, pathologyId: lab._id }, { $set: updates }, { new: true, runValidators: true }); if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' }); res.json({ success: true, staff }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
exports.deleteStaff = async (req, res) => {
  try { const lab = await labForUser(req.user); const staff = lab && await PathologyStaff.findOneAndUpdate({ _id: req.params.id, pathologyId: lab._id }, { $set: { isActive: false } }, { new: true }); if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' }); res.json({ success: true, staff }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

exports.getMerchantCatalog = async (req, res) => {
  try { const lab = await labForUser(req.user); if (!lab) return res.status(404).json({ success: false, message: 'Pathology profile not found' }); res.json({ success: true, tests: lab.services || [], packages: lab.packages || [] }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

function normalizeTestPayload(body) {
  const price = Number(body?.price); if (!clean(body?.testCode) || !clean(body?.testName) || !Number.isFinite(price) || price < 0) throw new Error('testCode, testName and a valid price are required');
  return { testCode: clean(body.testCode).toUpperCase(), testName: clean(body.testName), category: clean(body.category), description: clean(body.description), price, mrp: Number.isFinite(Number(body.mrp)) ? Number(body.mrp) : price, fastingRequired: body.fastingRequired === true, fastingHours: Number(body.fastingHours || 0), reportTime: Number(body.reportTime || 0), sampleType: clean(body.sampleType), preparation: clean(body.preparation), methodology: clean(body.methodology), homeCollectionEligible: body.homeCollectionEligible !== false, isActive: body.isActive !== false, parameters: normalizeParameters(body.parameters) };
}
function normalizeParameters(list) {
  if (!Array.isArray(list)) return [];
  const n = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));
  return list.filter((p) => clean(p?.name)).map((p) => ({ name: clean(p.name), unit: clean(p.unit), low: n(p.low), high: n(p.high), critLow: n(p.critLow), critHigh: n(p.critHigh), text: clean(p.text) || undefined }));
}
exports.createCatalogTest = async (req, res) => {
  try { const lab = await labForUser(req.user); const item = normalizeTestPayload(req.body); if ((lab.services || []).some(s => String(s.testCode).toLowerCase() === item.testCode.toLowerCase())) return res.status(409).json({ success: false, message: 'Test code already exists' }); lab.services.push(item); await lab.save(); res.status(201).json({ success: true, test: lab.services[lab.services.length - 1] }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
exports.updateCatalogTest = async (req, res) => {
  try { const lab = await labForUser(req.user); const item = lab?.services.id(req.params.id); if (!item) return res.status(404).json({ success: false, message: 'Test not found' }); Object.assign(item, normalizeTestPayload({ ...item.toObject(), ...req.body })); await lab.save(); res.json({ success: true, test: item }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
exports.deleteCatalogTest = async (req, res) => {
  try { const lab = await labForUser(req.user); const item = lab?.services.id(req.params.id); if (!item) return res.status(404).json({ success: false, message: 'Test not found' }); item.isActive = false; await lab.save(); res.json({ success: true, test: item }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
function normalizePackagePayload(body) {
  const price = Number(body?.price); if (!clean(body?.packageCode) || !clean(body?.packageName) || !Number.isFinite(price) || price < 0) throw new Error('packageCode, packageName and a valid price are required');
  const testCodes = [...new Set((body.testCodes || []).map(v => clean(v).toUpperCase()).filter(Boolean))]; if (!testCodes.length) throw new Error('Package must contain at least one test');
  return { packageCode: clean(body.packageCode).toUpperCase(), packageName: clean(body.packageName), description: clean(body.description), testCodes, price, mrp: Number.isFinite(Number(body.mrp)) ? Number(body.mrp) : price, fastingRequired: body.fastingRequired === true, fastingHours: Number(body.fastingHours || 0), reportTime: Number(body.reportTime || 0), isActive: body.isActive !== false };
}
exports.createPackage = async (req, res) => {
  try { const lab = await labForUser(req.user); const item = normalizePackagePayload(req.body); const serviceCodes = new Set((lab.services || []).map(s => String(s.testCode).toUpperCase())); const missing = item.testCodes.filter(c => !serviceCodes.has(c)); if (missing.length) return res.status(400).json({ success: false, message: `Unknown test codes: ${missing.join(', ')}` }); if ((lab.packages || []).some(p => String(p.packageCode).toUpperCase() === item.packageCode)) return res.status(409).json({ success: false, message: 'Package code already exists' }); lab.packages.push(item); await lab.save(); res.status(201).json({ success: true, package: lab.packages[lab.packages.length - 1] }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
exports.updatePackage = async (req, res) => {
  try { const lab = await labForUser(req.user); const item = lab?.packages.id(req.params.id); if (!item) return res.status(404).json({ success: false, message: 'Package not found' }); const normalized = normalizePackagePayload({ ...item.toObject(), ...req.body }); const serviceCodes = new Set((lab.services || []).map(s => String(s.testCode).toUpperCase())); const missing = normalized.testCodes.filter(c => !serviceCodes.has(c)); if (missing.length) return res.status(400).json({ success: false, message: `Unknown test codes: ${missing.join(', ')}` }); Object.assign(item, normalized); await lab.save(); res.json({ success: true, package: item }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
exports.deletePackage = async (req, res) => {
  try { const lab = await labForUser(req.user); const item = lab?.packages.id(req.params.id); if (!item) return res.status(404).json({ success: false, message: 'Package not found' }); item.isActive = false; await lab.save(); res.json({ success: true, package: item }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
