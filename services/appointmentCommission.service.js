const Commission = require('../models/Commission');

// Appointment statuses after which the booking will never generate earnings.
const VOIDING_STATUSES = ['cancelled', 'rejected', 'no_show'];

// Commission rows are created at booking time with payoutStatus 'pending'.
// When the appointment is cancelled / rejected / marked no-show, those rows
// must stop counting towards the professional's earnings. Only rows that are
// still 'pending' are voided — anything already processing/paid is left for
// admins to reconcile manually (refund/adjustment flows).
async function voidPendingCommissionsForAppointment(appointment, reason) {
  const appointmentId = appointment?._id || appointment;
  if (!appointmentId) return { modifiedCount: 0 };

  const status = appointment?.status;
  const note = reason || `Commission voided: appointment ${status || 'cancelled'}`;

  const result = await Commission.updateMany(
    { appointmentId, payoutStatus: 'pending' },
    { $set: { payoutStatus: 'cancelled', notes: note } }
  );
  return { modifiedCount: result?.modifiedCount ?? result?.nModified ?? 0 };
}

// Fire-and-log wrapper so a commission bookkeeping failure never fails the
// user-facing status change (same pattern as slot-lock release).
async function voidCommissionsIfTerminal(appointment, reason) {
  if (!appointment || !VOIDING_STATUSES.includes(appointment.status)) return null;
  try {
    return await voidPendingCommissionsForAppointment(appointment, reason);
  } catch (error) {
    console.error('Commission void failed:', error.message);
    return null;
  }
}

module.exports = {
  VOIDING_STATUSES,
  voidPendingCommissionsForAppointment,
  voidCommissionsIfTerminal,
};
