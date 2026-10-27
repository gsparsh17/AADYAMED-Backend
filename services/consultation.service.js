const crypto = require('crypto');
const Appointment = require('../models/Appointment');
const ConsultationSession = require('../models/ConsultationSession');
const PatientProfile = require('../models/PatientProfile');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const { clinicInstant } = require('../utils/clinicTime');

const DEFAULT_JOIN_BEFORE_MINUTES = Number(process.env.CONSULTATION_JOIN_BEFORE_MINUTES || 15);
const DEFAULT_JOIN_AFTER_MINUTES = Number(process.env.CONSULTATION_JOIN_AFTER_MINUTES || 120);
const { JITSI_BASE_URL } = require('./jitsi.service');

function scheduledDateTime(appointment) {
  return clinicInstant(appointment.appointmentDate, appointment.startTime);
}

function joinWindow(appointment) {
  const scheduledAt = scheduledDateTime(appointment);
  const opensAt = new Date(scheduledAt.getTime() - DEFAULT_JOIN_BEFORE_MINUTES * 60 * 1000);
  const closesAt = new Date(scheduledAt.getTime() + Math.max(DEFAULT_JOIN_AFTER_MINUTES, Number(appointment.duration || 30) + 60) * 60 * 1000);
  return { scheduledAt, opensAt, closesAt };
}

async function getActorContext(user, appointment) {
  if (!user || !appointment) return { authorized: false };
  if (user.role === 'admin') return { authorized: true, actorRole: 'admin', profileId: null };

  if (user.role === 'patient') {
    const profile = user.profileId
      ? await PatientProfile.findById(user.profileId).select('_id userId name')
      : await PatientProfile.findOne({ userId: user._id || user.id }).select('_id userId name');
    const appointmentPatientId = appointment.patientId?._id || appointment.patientId;
    return {
      authorized: Boolean(profile && String(appointmentPatientId) === String(profile._id)),
      actorRole: 'patient',
      profileId: profile?._id,
      profile
    };
  }

  if (user.role === 'doctor' && appointment.professionalType === 'doctor') {
    const profile = user.profileId
      ? await DoctorProfile.findById(user.profileId).select('_id userId name')
      : await DoctorProfile.findOne({ userId: user._id || user.id }).select('_id userId name');
    const professionalId = appointment.doctorId?._id || appointment.doctorId;
    return {
      authorized: Boolean(profile && String(professionalId) === String(profile._id)),
      actorRole: 'doctor',
      profileId: profile?._id,
      profile
    };
  }

  if (user.role === 'physio' && appointment.professionalType === 'physio') {
    const profile = user.profileId
      ? await PhysiotherapistProfile.findById(user.profileId).select('_id userId name')
      : await PhysiotherapistProfile.findOne({ userId: user._id || user.id }).select('_id userId name');
    const professionalId = appointment.physioId?._id || appointment.physioId;
    return {
      authorized: Boolean(profile && String(professionalId) === String(profile._id)),
      actorRole: 'physio',
      profileId: profile?._id,
      profile
    };
  }

  return { authorized: false };
}

async function loadAuthorizedAppointment(user, appointmentId) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('patientId', 'name phone age gender userId')
    .populate('doctorId', 'name specialization profileImage userId')
    .populate('physioId', 'name specialization profileImage userId')
    .populate('prescriptionId', 'prescriptionNumber status issuedAt expiresAt');

  if (!appointment) {
    const error = new Error('Appointment not found');
    error.statusCode = 404;
    throw error;
  }
  if (!['doctor', 'physio'].includes(appointment.professionalType)) {
    const error = new Error('Clinical consultation sessions are supported for doctor and physiotherapy appointments only');
    error.statusCode = 400;
    throw error;
  }

  const actor = await getActorContext(user, appointment);
  if (!actor.authorized) {
    const error = new Error('Not authorized to access this consultation');
    error.statusCode = 403;
    throw error;
  }

  return { appointment, actor };
}

function roomForAppointment(appointment) {
  const roomId = `aadyamed-${crypto.randomUUID().replace(/-/g, '')}`;
  return { roomId, roomUrl: `${JITSI_BASE_URL}/${roomId}` };
}

async function ensureSession(appointment) {
  let session = await ConsultationSession.findOne({ appointmentId: appointment._id }).select('+roomId +roomUrl');
  if (session) {
    if (!appointment.consultationSessionId || String(appointment.consultationSessionId) !== String(session._id)) {
      appointment.consultationSessionId = session._id;
      await appointment.save();
    }
    return session;
  }

  const video = appointment.type === 'video';
  const room = video ? roomForAppointment(appointment) : {};
  try {
    session = await ConsultationSession.create({
      appointmentId: appointment._id,
      patientId: appointment.patientId?._id || appointment.patientId,
      professionalType: appointment.professionalType,
      doctorId: appointment.professionalType === 'doctor' ? (appointment.doctorId?._id || appointment.doctorId) : undefined,
      physioId: appointment.professionalType === 'physio' ? (appointment.physioId?._id || appointment.physioId) : undefined,
      consultationType: appointment.type,
      provider: video ? 'jitsi' : 'in_person',
      roomId: room.roomId,
      roomUrl: room.roomUrl,
      status: appointment.status === 'in_progress' ? 'in_progress' : appointment.status === 'completed' ? 'ended' : 'scheduled',
      startedAt: appointment.actualStartTime,
      endedAt: appointment.actualEndTime,
      lastActivityAt: new Date()
    });
    appointment.consultationSessionId = session._id;
    await appointment.save();
    return await ConsultationSession.findById(session._id).select('+roomId +roomUrl');
  } catch (error) {
    if (error?.code === 11000) {
      session = await ConsultationSession.findOne({ appointmentId: appointment._id }).select('+roomId +roomUrl');
      if (session && (!appointment.consultationSessionId || String(appointment.consultationSessionId) !== String(session._id))) {
        appointment.consultationSessionId = session._id;
        await appointment.save();
      }
      return session;
    }
    throw error;
  }
}

function serializeSession(session, appointment, actor) {
  const window = joinWindow(appointment);
  const now = new Date();
  const terminal = ['ended', 'cancelled', 'no_show'].includes(session.status) || ['completed', 'cancelled', 'rejected', 'no_show'].includes(appointment.status);
  const withinJoinWindow = now >= window.opensAt && now <= window.closesAt;
  const paymentRequired = appointment.type === 'video' && Number(appointment.totalAmount || 0) > 0 && appointment.paymentStatus !== 'paid';
  const actorReadyToJoin = actor.actorRole === 'patient'
    ? Boolean(session.patientCheckedInAt && session.consent?.teleconsultationAccepted)
    : Boolean(session.professionalCheckedInAt || session.status === 'in_progress');

  return {
    _id: session._id,
    appointmentId: session.appointmentId,
    status: session.status,
    provider: session.provider,
    consultationType: session.consultationType,
    patientCheckedInAt: session.patientCheckedInAt,
    professionalCheckedInAt: session.professionalCheckedInAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    clinicalSummary: actor.actorRole === 'patient' && session.status !== 'ended' ? undefined : session.clinicalSummary,
    consent: session.consent,
    participants: session.participants,
    actorRole: actor.actorRole,
    scheduledAt: window.scheduledAt,
    joinOpensAt: window.opensAt,
    joinClosesAt: window.closesAt,
    paymentRequired,
    canCheckIn: !terminal && !paymentRequired && withinJoinWindow && ['patient', 'doctor', 'physio', 'admin'].includes(actor.actorRole),
    canStart: !terminal && !paymentRequired && withinJoinWindow && ['doctor', 'physio', 'admin'].includes(actor.actorRole) && ['confirmed', 'accepted', 'in_progress'].includes(appointment.status),
    canJoin: appointment.type === 'video' && !terminal && !paymentRequired && withinJoinWindow && actorReadyToJoin && ['patient_waiting', 'professional_ready', 'in_progress'].includes(session.status),
    canEnd: !terminal && ['doctor', 'physio', 'admin'].includes(actor.actorRole) && ['in_progress', 'professional_ready', 'patient_waiting'].includes(session.status)
  };
}

function upsertParticipant(session, user, role, fields = {}) {
  const userId = user._id || user.id;
  const existing = session.participants.find((item) => String(item.userId) === String(userId));
  if (existing) {
    existing.role = role;
    existing.lastSeenAt = new Date();
    existing.leftAt = undefined;
    Object.assign(existing, fields);
    return;
  }
  session.participants.push({ userId, role, joinedAt: new Date(), lastSeenAt: new Date(), ...fields });
}

module.exports = {
  scheduledDateTime,
  joinWindow,
  loadAuthorizedAppointment,
  ensureSession,
  serializeSession,
  upsertParticipant
};
