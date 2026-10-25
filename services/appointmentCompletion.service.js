const Appointment = require('../models/Appointment');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const Invoice = require('../models/Invoice');
const PhysioTreatmentCourse = require('../models/PhysioTreatmentCourse');
const { createNotification } = require('./notification.service');

async function updateProfessionalStatsOnce(appointment) {
  const update = {
    $inc: {
      totalConsultations: 1,
      totalEarnings: Number(appointment.professionalEarning || 0),
      pendingCommission: Number(appointment.platformCommission || 0)
    }
  };
  if (appointment.professionalType === 'doctor') {
    await DoctorProfile.findByIdAndUpdate(appointment.doctorId, update);
  } else if (appointment.professionalType === 'physio') {
    await PhysiotherapistProfile.findByIdAndUpdate(appointment.physioId, update);
  }
}

async function ensureAppointmentInvoice(appointment) {
  const existing = await Invoice.findOne({ appointmentId: appointment._id });
  if (existing) return existing;

  const patient = await PatientProfile.findById(appointment.patientId).select('name phone email address');
  if (!patient) return null;

  const amount = Number(appointment.totalAmount ?? appointment.consultationFee ?? 0);
  const paid = appointment.paymentStatus === 'paid';
  const professionalId = appointment.professionalType === 'doctor' ? appointment.doctorId : appointment.physioId;
  const label = appointment.professionalType === 'doctor' ? 'Doctor Consultation' : 'Physiotherapy Consultation';

  return Invoice.create({
    invoiceType: 'appointment',
    appointmentId: appointment._id,
    patientId: appointment.patientId,
    customerName: patient.name || 'Patient',
    customerPhone: patient.phone,
    customerEmail: patient.email,
    customerAddress: typeof patient.address === 'string' ? patient.address : undefined,
    items: [{
      description: label,
      quantity: 1,
      unitPrice: amount,
      amount
    }],
    subtotal: amount,
    tax: 0,
    totalAmount: amount,
    amountPaid: paid ? amount : 0,
    balanceDue: paid ? 0 : amount,
    status: paid ? 'paid' : 'sent',
    paymentMethod: paid ? 'online' : undefined,
    paymentDate: paid ? (appointment.paymentDate || new Date()) : undefined,
    commissionIncluded: true,
    commissionAmount: Number(appointment.platformCommission || 0),
    professionalId,
    professionalType: appointment.professionalType
  });
}

async function sendCompletionNotification(appointment) {
  try {
    const patient = await PatientProfile.findById(appointment.patientId).select('userId');
    if (!patient?.userId) return;
    await createNotification({
      userId: patient.userId,
      userRole: 'patient',
      title: 'Consultation completed',
      message: appointment.followupRequired
        ? 'Your consultation is complete. A follow-up has been recommended.'
        : 'Your consultation is complete. You can review your consultation summary and prescription in AADYAMED.',
      type: 'appointment',
      channels: ['in_app', 'push'],
      relatedEntity: 'Appointment',
      relatedEntityId: appointment._id,
      actionUrl: `/dashboard/patient/consultations/${appointment._id}`,
      actionText: 'View consultation'
    });
  } catch (error) {
    console.error('Completion notification failed:', error.message);
  }
}

// Counts a completed appointment against its physiotherapy treatment course.
// Idempotent: the appointment id is recorded in countedAppointmentIds in the
// same atomic update that increments sessionsUsed, so retries/double
// completion never double count.
async function applyTreatmentCourseSession(appointment) {
  if (!appointment?.treatmentCourseId || appointment.status !== 'completed') return null;
  const course = await PhysioTreatmentCourse.findOneAndUpdate(
    {
      _id: appointment.treatmentCourseId,
      status: 'active',
      countedAppointmentIds: { $ne: appointment._id },
    },
    {
      $inc: { sessionsUsed: 1 },
      $addToSet: { countedAppointmentIds: appointment._id, appointmentIds: appointment._id },
    },
    { new: true }
  );
  if (!course) return null;
  if (course.status === 'active' && Number(course.sessionsUsed) >= Number(course.totalSessions)) {
    course.status = 'completed';
    course.completedAt = new Date();
    await course.save();
  }
  return course;
}

async function finalizeAppointment(appointmentOrId, options = {}) {
  const appointment = typeof appointmentOrId === 'string' || appointmentOrId?._bsontype
    ? await Appointment.findById(appointmentOrId)
    : appointmentOrId;
  if (!appointment) {
    const error = new Error('Appointment not found');
    error.statusCode = 404;
    throw error;
  }

  const wasCompleted = appointment.status === 'completed';

  // Guard for every caller: only live appointments can be completed, so a
  // pending/rejected/cancelled/no_show booking never generates earnings.
  // Already-completed stays idempotent.
  if (!wasCompleted && !['confirmed', 'accepted', 'in_progress'].includes(appointment.status)) {
    const error = new Error(`Cannot complete ${appointment.status} appointment`);
    error.statusCode = 400;
    throw error;
  }

  const now = new Date();

  appointment.status = 'completed';
  appointment.actualStartTime = appointment.actualStartTime || options.startedAt || now;
  appointment.actualEndTime = options.endedAt || now;

  if (options.notes !== undefined) appointment.professionalNotes = options.notes;
  if (options.consultationNotes !== undefined) appointment.consultationNotes = options.consultationNotes;
  if (options.followupRequired !== undefined) appointment.followupRequired = Boolean(options.followupRequired);
  if (options.followUpDate) appointment.followUpDate = new Date(options.followUpDate);
  if (options.followUpNotes !== undefined) appointment.followUpNotes = options.followUpNotes;

  await appointment.save();

  let invoice = await Invoice.findOne({ appointmentId: appointment._id });
  if (!wasCompleted) {
    await updateProfessionalStatsOnce(appointment).catch((error) => console.error('Professional stats update failed:', error.message));
    invoice = await ensureAppointmentInvoice(appointment).catch((error) => {
      console.error('Appointment invoice creation failed:', error.message);
      return null;
    });
    await sendCompletionNotification(appointment);
  } else if (!invoice) {
    invoice = await ensureAppointmentInvoice(appointment).catch(() => null);
  }

  if (appointment.treatmentCourseId) {
    await applyTreatmentCourseSession(appointment).catch((error) => console.error('Treatment course session count failed:', error.message));
  }

  return { appointment, invoice, newlyCompleted: !wasCompleted };
}

module.exports = { finalizeAppointment, ensureAppointmentInvoice, applyTreatmentCourseSession };
