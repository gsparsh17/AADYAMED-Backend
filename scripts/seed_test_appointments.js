/**
 * Adds a realistic spread of test appointments for one doctor and/or one
 * physiotherapist, so every screen of those modules has something to show:
 * requests to answer, today's visits, upcoming, completed (with earnings),
 * cancelled and no-show — across clinic, video and home visits.
 *
 * Usage:
 *   node scripts/seed_test_appointments.js --doctor=doc@gmail.com --physio=physio@gmail.com
 *   ... --alert   also send the "New appointment request" push for each request
 *   ... --clear   remove everything this script added (for those accounts)
 *
 * Accounts are named on purpose — it never falls back to "any doctor".
 *
 * Test rows are tagged: appointments and commissions carry notes 'APPTTEST',
 * and the patients are *.appttest@example.com users. Requests are marked paid
 * (payment id TEST-…) so the auto-decline job leaves them alone until 30
 * minutes before their slot; nothing here ever calls Razorpay. Profile totals
 * (totalEarnings etc.) are not touched, so --clear leaves no trace.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const User = require('../models/User');
const PatientProfile = require('../models/PatientProfile');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const Appointment = require('../models/Appointment');
const Commission = require('../models/Commission');
const Notification = require('../models/Notification');
const { createNotification } = require('../services/notification.service');

const TAG = 'APPTTEST';
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim().toLowerCase() : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const PATIENTS = [
  { first: 'Priya', last: 'Kulkarni', gender: 'female', year: 1991, phone: '9000000101' },
  { first: 'Arjun', last: 'Mehta', gender: 'male', year: 1984, phone: '9000000102' },
  { first: 'Sameer', last: 'Khan', gender: 'male', year: 1976, phone: '9000000103' },
  { first: 'Neha', last: 'Sharma', gender: 'female', year: 1998, phone: '9000000104' },
  { first: 'Ramesh', last: 'Iyer', gender: 'male', year: 1959, phone: '9000000105' },
];
const HOME = {
  address: '12, Palasia Square, Indore, Madhya Pradesh 452001',
  location: { type: 'Point', coordinates: [75.8839, 22.7244] },
};

async function ensurePatients() {
  const out = [];
  for (const p of PATIENTS) {
    const name = `${p.first} ${p.last}`;
    const email = `${p.first.toLowerCase()}.${p.last.toLowerCase()}.appttest@example.com`;
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ name, email, password: 'Seed@12345', phone: p.phone, role: 'patient', isActive: true });
    }
    let profile = await PatientProfile.findOne({ userId: user._id });
    if (!profile) {
      profile = await PatientProfile.create({
        userId: user._id, name, firstName: p.first, lastName: p.last, email, phone: p.phone,
        gender: p.gender, dateOfBirth: new Date(p.year, 3, 12),
      });
    }
    out.push(profile);
  }
  return out;
}

// ── Time ─────────────────────────────────────────────────────────────────
// Clinic hours are Indian time. The day is stored as midnight UTC of the IST
// date, which the app reads correctly (it adds 14h before taking the date).
const IST_MS = 330 * 60000;
const istNow = () => new Date(Date.now() + IST_MS); // read with getUTC*
function dayAt(offsetDays) {
  const n = istNow();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offsetDays));
}
const hhmm = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
/** A slot today, [aheadMins] from now (negative = earlier), on the half hour. */
function todaySlot(aheadMins) {
  const n = istNow();
  const mins = n.getUTCHours() * 60 + n.getUTCMinutes() + aheadMins;
  const rounded = Math.min(Math.max(Math.round(mins / 30) * 30, 0), 23 * 60);
  return hhmm(rounded);
}

// ── Plan ─────────────────────────────────────────────────────────────────
// [dayOffset | 'today', time or today-offset, type, status, patient index]
function plan(kind) {
  const home = kind === 'physio' ? 'home' : 'video';
  return [
    // Requests waiting for an answer.
    { day: 2, time: '10:30', type: 'clinic', status: 'pending', p: 0, reason: kind === 'physio' ? 'Lower back pain after lifting' : 'Fever and sore throat for 3 days' },
    { day: 2, time: '17:00', type: 'video', status: 'pending', p: 1, reason: kind === 'physio' ? 'Post-surgery knee rehab review' : 'Follow-up on blood pressure readings' },
    { day: 3, time: '11:00', type: 'home', status: 'pending', p: 4, reason: kind === 'physio' ? 'Stroke rehab — needs help walking' : 'Elderly parent, unable to travel' },
    // Today.
    { day: 0, time: todaySlot(-120), type: 'clinic', status: 'completed', p: 2, reason: kind === 'physio' ? 'Frozen shoulder session' : 'Diabetes check-up' },
    { day: 0, time: todaySlot(60), type: home, status: 'confirmed', p: 3, reason: kind === 'physio' ? 'Ankle sprain — session 2' : 'Skin rash consultation' },
    { day: 0, time: todaySlot(180), type: 'clinic', status: 'confirmed', p: 1, reason: kind === 'physio' ? 'Neck stiffness' : 'Migraine' },
    // Upcoming.
    { day: 1, time: '09:30', type: 'clinic', status: 'confirmed', p: 4, reason: kind === 'physio' ? 'Balance training' : 'Knee pain' },
    { day: 4, time: '16:30', type: home, status: 'confirmed', p: 0, reason: kind === 'physio' ? 'Back pain — session 3' : 'Review lab reports' },
    // Past.
    { day: -1, time: '12:00', type: 'clinic', status: 'completed', p: 3, reason: kind === 'physio' ? 'Ankle sprain — assessment' : 'Acidity and bloating' },
    { day: -3, time: '18:00', type: 'video', status: 'completed', p: 1, reason: kind === 'physio' ? 'Home exercise review' : 'Cold and cough' },
    { day: -6, time: '10:00', type: 'home', status: 'completed', p: 4, reason: kind === 'physio' ? 'Stroke rehab — session 4' : 'Home visit — fever' },
    { day: -9, time: '15:30', type: 'clinic', status: 'completed', p: 0, reason: kind === 'physio' ? 'Back pain — assessment' : 'General check-up' },
    { day: -2, time: '11:30', type: 'clinic', status: 'cancelled', p: 2, reason: 'Routine visit' },
    { day: -4, time: '17:30', type: 'video', status: 'no_show', p: 3, reason: 'Follow-up' },
  ];
}

function money(profile, type) {
  const base = Number(profile.consultationFee) || 500;
  const fee = type === 'video' ? Number(profile.videoCallFee) || base : base;
  const homeCharge = type === 'home' ? Number(profile.homeVisitFee) || 300 : 0;
  const commission = Math.round(fee * 0.1);
  return { fee, homeCharge, commission };
}

async function seedFor(kind, email, patients, { alert }) {
  const user = await User.findOne({ email });
  if (!user) throw new Error(`No user with email ${email}`);
  const Profile = kind === 'physio' ? PhysiotherapistProfile : DoctorProfile;
  const profile = await Profile.findOne({ userId: user._id });
  if (!profile) throw new Error(`${email} has no ${kind} profile`);
  const idField = kind === 'physio' ? 'physioId' : 'doctorId';

  const now = new Date();
  let made = 0;
  for (const row of plan(kind)) {
    const patient = patients[row.p];
    const { fee, homeCharge, commission } = money(profile, row.type);
    const [h, m] = row.time.split(':').map(Number);
    const endTime = hhmm(h * 60 + m + 30);
    const paid = row.status !== 'cancelled' && (row.status !== 'confirmed' || row.type !== 'clinic');
    const appt = await Appointment.create({
      patientId: patient._id,
      [idField]: profile._id,
      professionalType: kind,
      appointmentDate: dayAt(row.day),
      startTime: row.time,
      endTime,
      duration: 30,
      type: row.type,
      ...(row.type === 'home' ? HOME : {}),
      reason: row.reason,
      symptoms: [row.reason.split(/[—,]/)[0].trim()],
      notes: TAG,
      status: row.status,
      consultationFee: fee,
      homeVisitCharges: homeCharge,
      platformCommission: commission,
      professionalEarning: fee - commission,
      totalAmount: fee + homeCharge,
      paymentStatus: row.status === 'cancelled' ? 'refunded' : paid ? 'paid' : 'pending',
      ...(paid ? { paymentId: `TEST-${Date.now()}-${made}`, paymentDate: now } : {}),
      ...(row.status !== 'pending' ? { respondedAt: now, respondedBy: String(user._id) } : {}),
      ...(row.status === 'completed' ? { actualStartTime: now, actualEndTime: now, consultationNotes: 'Seeded test visit.' } : {}),
      ...(row.status === 'cancelled' ? { cancelledAt: now, cancelledBy: 'patient', cancellationReason: 'Patient had a conflict' } : {}),
      ...(row.status === 'no_show' ? { noShowAt: now, noShowReason: 'Patient did not join' } : {}),
      bookedBy: 'patient',
      createdBy: patient.userId,
    });
    made += 1;

    if (row.status === 'completed') {
      await Commission.create({
        appointmentId: appt._id,
        professionalId: profile._id,
        professionalModel: kind === 'physio' ? 'PhysiotherapistProfile' : 'DoctorProfile',
        professionalType: kind,
        patientId: patient._id,
        consultationFee: fee,
        platformCommission: commission,
        professionalEarning: fee - commission,
        commissionRate: 10,
        finalAmount: fee - commission,
        calculatedAt: now,
        payoutStatus: row.day <= -6 ? 'paid' : 'pending',
        ...(row.day <= -6 ? { paidAt: now } : {}),
        notes: TAG,
      }).catch((e) => console.warn(`  commission skipped: ${e.message}`));
    }

    if (alert && row.status === 'pending') {
      const visit = row.type === 'video' ? 'video' : row.type === 'home' ? 'home visit' : 'clinic';
      await createNotification({
        userId: user._id, userRole: kind, title: 'New appointment request',
        message: `${patient.name} · ${appt.appointmentDate.toLocaleDateString()} at ${row.time} · ${visit}. Tap to accept or decline.`,
        type: 'appointment', priority: 'high', channels: ['in_app', 'push'],
        relatedEntity: 'appointment', relatedEntityId: appt._id,
        androidChannel: 'appointment_requests', ttlSeconds: 3600,
        data: { entityType: 'appointment', kind: 'request', appointmentId: String(appt._id), professionalType: kind },
      }).catch((e) => console.warn(`  alert failed: ${e.message}`));
    }
  }
  console.log(`${kind} ${email}: added ${made} appointments`);
}

async function clearFor(kind, email) {
  const user = await User.findOne({ email });
  if (!user) return console.log(`${kind} ${email}: no such user`);
  const Profile = kind === 'physio' ? PhysiotherapistProfile : DoctorProfile;
  const profile = await Profile.findOne({ userId: user._id });
  if (!profile) return console.log(`${kind} ${email}: no profile`);
  const idField = kind === 'physio' ? 'physioId' : 'doctorId';
  const appts = await Appointment.find({ [idField]: profile._id, notes: TAG }).select('_id');
  const ids = appts.map((a) => a._id);
  const c = await Commission.deleteMany({ appointmentId: { $in: ids } });
  const n = await Notification.deleteMany({ relatedEntityId: { $in: ids } }).catch(() => ({ deletedCount: 0 }));
  const a = await Appointment.deleteMany({ _id: { $in: ids } });
  console.log(`${kind} ${email}: removed ${a.deletedCount} appointments, ${c.deletedCount} commissions, ${n.deletedCount} notifications`);
}

(async () => {
  const doctor = arg('doctor');
  const physio = arg('physio');
  if (!doctor && !physio) {
    console.error('Name at least one account: --doctor=<email> and/or --physio=<email>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    if (flag('clear')) {
      if (doctor) await clearFor('doctor', doctor);
      if (physio) await clearFor('physio', physio);
    } else {
      const patients = await ensurePatients();
      if (doctor) await seedFor('doctor', doctor, patients, { alert: flag('alert') });
      if (physio) await seedFor('physio', physio, patients, { alert: flag('alert') });
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
