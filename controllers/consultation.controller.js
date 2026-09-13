const ConsultationSession = require('../models/ConsultationSession');
const Appointment = require('../models/Appointment');
const { finalizeAppointment } = require('../services/appointmentCompletion.service');
const {
  joinWindow,
  loadAuthorizedAppointment,
  ensureSession,
  serializeSession,
  upsertParticipant
} = require('../services/consultation.service');

function apiError(res, error) {
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.statusCode ? error.message : 'Consultation operation failed',
    code: error.code
  });
}

function assertActiveAppointment(appointment) {
  if (['cancelled', 'rejected', 'no_show'].includes(appointment.status)) {
    const error = new Error(`Cannot use a ${appointment.status} appointment for consultation`);
    error.statusCode = 400;
    throw error;
  }
}

function assertJoinWindow(appointment) {
  const { opensAt, closesAt } = joinWindow(appointment);
  const now = new Date();
  if (now < opensAt) {
    const error = new Error(`Consultation check-in opens at ${opensAt.toISOString()}`);
    error.statusCode = 409;
    error.code = 'CONSULTATION_NOT_OPEN';
    throw error;
  }
  if (now > closesAt && appointment.status !== 'in_progress') {
    const error = new Error('The consultation join window has closed');
    error.statusCode = 409;
    error.code = 'CONSULTATION_WINDOW_CLOSED';
    throw error;
  }
}

exports.getByAppointment = async (req, res) => {
  try {
    const { appointment, actor } = await loadAuthorizedAppointment(req.user, req.params.appointmentId);
    const session = await ensureSession(appointment);
    return res.json({
      success: true,
      appointment,
      session: serializeSession(session, appointment, actor)
    });
  } catch (error) {
    return apiError(res, error);
  }
};

exports.checkIn = async (req, res) => {
  try {
    const { appointment, actor } = await loadAuthorizedAppointment(req.user, req.params.appointmentId);
    assertActiveAppointment(appointment);
    if (!['confirmed', 'accepted', 'in_progress'].includes(appointment.status)) {
      return res.status(409).json({ success: false, error: 'Appointment must be confirmed before check-in' });
    }
    if (appointment.type === 'video' && Number(appointment.totalAmount || 0) > 0 && appointment.paymentStatus !== 'paid') {
      return res.status(402).json({ success: false, error: 'Payment is required before joining this video consultation', code: 'PAYMENT_REQUIRED' });
    }
    assertJoinWindow(appointment);

    const session = await ensureSession(appointment);
    const now = new Date();

    if (actor.actorRole === 'patient') {
      if (appointment.type === 'video' && req.body.teleconsultationAccepted !== true && !session.consent?.teleconsultationAccepted) {
        return res.status(400).json({ success: false, error: 'Teleconsultation consent is required before check-in', code: 'CONSENT_REQUIRED' });
      }
      if (appointment.type === 'video' && req.body.teleconsultationAccepted === true) {
        session.consent.teleconsultationAccepted = true;
        session.consent.acceptedAt = session.consent.acceptedAt || now;
        session.consent.privacyNoticeVersion = String(req.body.privacyNoticeVersion || 'v1');
      }
      session.patientCheckedInAt = session.patientCheckedInAt || now;
      if (!['in_progress', 'ended'].includes(session.status)) session.status = 'patient_waiting';
    } else {
      session.professionalCheckedInAt = session.professionalCheckedInAt || now;
      if (!['in_progress', 'ended'].includes(session.status)) session.status = 'professional_ready';
    }

    session.lastActivityAt = now;
    upsertParticipant(session, req.user, actor.actorRole);
    await session.save();

    return res.json({ success: true, session: serializeSession(session, appointment, actor) });
  } catch (error) {
    return apiError(res, error);
  }
};

exports.start = async (req, res) => {
  try {
    const { appointment, actor } = await loadAuthorizedAppointment(req.user, req.params.appointmentId);
    assertActiveAppointment(appointment);
    if (!['doctor', 'physio', 'admin'].includes(actor.actorRole)) {
      return res.status(403).json({ success: false, error: 'Only the assigned professional can start the consultation' });
    }
    if (!['confirmed', 'accepted', 'in_progress'].includes(appointment.status)) {
      return res.status(409).json({ success: false, error: 'Appointment must be confirmed before starting consultation' });
    }
    if (appointment.type === 'video' && Number(appointment.totalAmount || 0) > 0 && appointment.paymentStatus !== 'paid') {
      return res.status(402).json({ success: false, error: 'Payment is required before starting this video consultation', code: 'PAYMENT_REQUIRED' });
    }
    assertJoinWindow(appointment);

    const session = await ensureSession(appointment);
    const now = new Date();
    session.professionalCheckedInAt = session.professionalCheckedInAt || now;
    session.startedAt = session.startedAt || now;
    session.status = 'in_progress';
    session.lastActivityAt = now;
    upsertParticipant(session, req.user, actor.actorRole);
    await session.save();

    appointment.status = 'in_progress';
    appointment.actualStartTime = appointment.actualStartTime || now;
    await appointment.save();

    return res.json({ success: true, appointment, session: serializeSession(session, appointment, actor) });
  } catch (error) {
    return apiError(res, error);
  }
};

exports.join = async (req, res) => {
  try {
    const { appointment, actor } = await loadAuthorizedAppointment(req.user, req.params.appointmentId);
    assertActiveAppointment(appointment);
    if (appointment.type !== 'video') {
      return res.status(400).json({ success: false, error: 'This appointment is not a video consultation' });
    }
    if (Number(appointment.totalAmount || 0) > 0 && appointment.paymentStatus !== 'paid') {
      return res.status(402).json({ success: false, error: 'Payment is required before joining this video consultation', code: 'PAYMENT_REQUIRED' });
    }
    assertJoinWindow(appointment);

    const session = await ensureSession(appointment);
    if (actor.actorRole === 'patient') {
      if (!session.patientCheckedInAt) {
        return res.status(409).json({ success: false, error: 'Please check in before joining the consultation', code: 'CHECK_IN_REQUIRED' });
      }
      if (!session.consent?.teleconsultationAccepted) {
        return res.status(409).json({ success: false, error: 'Teleconsultation consent is required', code: 'CONSENT_REQUIRED' });
      }
    } else if (!session.professionalCheckedInAt && session.status !== 'in_progress') {
      return res.status(409).json({ success: false, error: 'Please start the consultation before joining', code: 'START_REQUIRED' });
    }

    if (['ended', 'cancelled', 'no_show'].includes(session.status)) {
      return res.status(409).json({ success: false, error: 'This consultation has ended' });
    }

    const sessionWithRoom = await ConsultationSession.findById(session._id).select('+roomUrl +roomId');
    if (!sessionWithRoom?.roomUrl) {
      return res.status(500).json({ success: false, error: 'Video room is not configured' });
    }

    upsertParticipant(sessionWithRoom, req.user, actor.actorRole);
    sessionWithRoom.lastActivityAt = new Date();
    await sessionWithRoom.save();

    return res.json({
      success: true,
      joinUrl: sessionWithRoom.roomUrl,
      roomId: sessionWithRoom.roomId,
      provider: sessionWithRoom.provider,
      session: serializeSession(sessionWithRoom, appointment, actor)
    });
  } catch (error) {
    return apiError(res, error);
  }
};

exports.leave = async (req, res) => {
  try {
    const { appointment, actor } = await loadAuthorizedAppointment(req.user, req.params.appointmentId);
    const session = await ensureSession(appointment);
    const userId = req.user._id || req.user.id;
    const participant = session.participants.find((item) => String(item.userId) === String(userId));
    if (participant) {
      participant.leftAt = new Date();
      participant.lastSeenAt = new Date();
    }
    session.lastActivityAt = new Date();
    await session.save();
    return res.json({ success: true, session: serializeSession(session, appointment, actor) });
  } catch (error) {
    return apiError(res, error);
  }
};

exports.updateSummary = async (req, res) => {
  try {
    const { appointment, actor } = await loadAuthorizedAppointment(req.user, req.params.appointmentId);
    if (!['doctor', 'physio', 'admin'].includes(actor.actorRole)) {
      return res.status(403).json({ success: false, error: 'Only the assigned professional can update clinical notes' });
    }

    const session = await ensureSession(appointment);
    if (['ended', 'cancelled', 'no_show'].includes(session.status)) {
      return res.status(409).json({ success: false, error: 'Clinical notes are locked because this consultation is closed' });
    }

    const current = session.clinicalSummary?.toObject ? session.clinicalSummary.toObject() : (session.clinicalSummary || {});
    const parseList = (value, fallback) => {
      if (value === undefined) return fallback || [];
      return Array.isArray(value)
        ? value.map((item) => String(item).trim()).filter(Boolean)
        : String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
    };

    session.clinicalSummary = {
      ...current,
      chiefComplaint: parseList(req.body.chiefComplaint, current.chiefComplaint),
      diagnosis: parseList(req.body.diagnosis, current.diagnosis),
      notes: req.body.notes === undefined ? current.notes : String(req.body.notes || '').trim(),
      advice: req.body.advice === undefined ? current.advice : String(req.body.advice || '').trim(),
      outcome: req.body.outcome === undefined ? (current.outcome || 'unknown') : req.body.outcome,
      followUpRequired: req.body.followUpRequired === undefined ? Boolean(current.followUpRequired) : Boolean(req.body.followUpRequired),
      followUpDate: req.body.followUpDate === undefined
        ? current.followUpDate
        : (req.body.followUpDate ? new Date(req.body.followUpDate) : undefined),
      followUpNotes: req.body.followUpNotes === undefined ? current.followUpNotes : String(req.body.followUpNotes || '').trim()
    };
    session.lastActivityAt = new Date();
    await session.save();

    return res.json({ success: true, session: serializeSession(session, appointment, actor) });
  } catch (error) {
    return apiError(res, error);
  }
};

exports.end = async (req, res) => {
  try {
    const { appointment, actor } = await loadAuthorizedAppointment(req.user, req.params.appointmentId);
    if (!['doctor', 'physio', 'admin'].includes(actor.actorRole)) {
      return res.status(403).json({ success: false, error: 'Only the assigned professional can end the consultation' });
    }

    const session = await ensureSession(appointment);
    if (session.status === 'ended' || appointment.status === 'completed') {
      return res.json({ success: true, appointment, session: serializeSession(session, appointment, actor), alreadyCompleted: true });
    }

    const diagnosis = Array.isArray(req.body.diagnosis)
      ? req.body.diagnosis.map((item) => String(item).trim()).filter(Boolean)
      : String(req.body.diagnosis || '').split(',').map((item) => item.trim()).filter(Boolean);
    const chiefComplaint = Array.isArray(req.body.chiefComplaint)
      ? req.body.chiefComplaint.map((item) => String(item).trim()).filter(Boolean)
      : String(req.body.chiefComplaint || '').split(',').map((item) => item.trim()).filter(Boolean);

    session.clinicalSummary = {
      chiefComplaint,
      diagnosis,
      notes: String(req.body.notes || '').trim(),
      advice: String(req.body.advice || '').trim(),
      outcome: req.body.outcome || 'unknown',
      followUpRequired: Boolean(req.body.followUpRequired),
      followUpDate: req.body.followUpDate ? new Date(req.body.followUpDate) : undefined,
      followUpNotes: String(req.body.followUpNotes || '').trim()
    };
    session.status = 'ended';
    session.endedAt = new Date();
    session.endedBy = req.user._id || req.user.id;
    session.lastActivityAt = session.endedAt;
    await session.save();

    const completion = await finalizeAppointment(appointment, {
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      notes: session.clinicalSummary.notes,
      consultationNotes: [session.clinicalSummary.diagnosis.join(', '), session.clinicalSummary.advice].filter(Boolean).join('\n'),
      followupRequired: session.clinicalSummary.followUpRequired,
      followUpDate: session.clinicalSummary.followUpDate,
      followUpNotes: session.clinicalSummary.followUpNotes
    });

    return res.json({
      success: true,
      appointment: completion.appointment,
      invoice: completion.invoice,
      session: serializeSession(session, completion.appointment, actor)
    });
  } catch (error) {
    return apiError(res, error);
  }
};

exports.history = async (req, res) => {
  try {
    const { page = 1, limit = 20, followUpOnly } = req.query;
    const filter = {};

    if (req.user.role === 'patient') {
      filter.patientId = req.user.profileId;
    } else if (req.user.role === 'doctor') {
      filter.doctorId = req.user.profileId;
    } else if (req.user.role === 'physio') {
      filter.physioId = req.user.profileId;
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Not authorized to view consultation history' });
    }
    if (String(followUpOnly) === 'true') filter['clinicalSummary.followUpRequired'] = true;

    const skip = (Math.max(1, Number(page)) - 1) * Math.min(100, Math.max(1, Number(limit)));
    const safeLimit = Math.min(100, Math.max(1, Number(limit)));
    const sessions = await ConsultationSession.find(filter)
      .populate('appointmentId', 'appointmentDate startTime type status prescriptionId followUpDate followupRequired')
      .populate('patientId', 'name phone')
      .populate('doctorId', 'name specialization')
      .populate('physioId', 'name specialization')
      .sort({ endedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(safeLimit);
    const total = await ConsultationSession.countDocuments(filter);

    return res.json({
      success: true,
      consultations: sessions,
      pagination: { page: Number(page), limit: safeLimit, total, pages: Math.ceil(total / safeLimit) }
    });
  } catch (error) {
    return apiError(res, error);
  }
};
