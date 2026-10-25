const mongoose = require('mongoose');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const Appointment = require('../models/Appointment');
const PhysioPackage = require('../models/PhysioPackage');
const PhysioTreatmentCourse = require('../models/PhysioTreatmentCourse');
const PhysioAssessment = require('../models/PhysioAssessment');
const { canTreatPatient } = require('./physioExercise.controller');
const { applyTreatmentCourseSession } = require('../services/appointmentCompletion.service');
const { createNotification } = require('../services/notification.service');

const isObjectId = value => mongoose.Types.ObjectId.isValid(String(value || ''));
const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const COURSE_STATUSES = ['active', 'completed', 'cancelled', 'expired'];
const PAYMENT_METHODS = ['cash', 'upi', 'online'];
const UNLINKABLE_APPOINTMENT_STATUSES = ['cancelled', 'rejected', 'no_show'];
const NO_RELATIONSHIP = { success: false, error: 'No treatment relationship with this patient' };
const NO_PHYSIO = { success: false, error: 'Physiotherapist profile not found' };
const NO_PATIENT = { success: false, error: 'Patient profile not found' };

function stringArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function validDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function currentPhysio(req) {
  return PhysiotherapistProfile.findOne({ userId: req.user.id });
}

async function currentPatient(req) {
  return PatientProfile.findOne({ userId: req.user.id });
}

async function notifyPatient(patientId, payload) {
  try {
    const patient = await PatientProfile.findById(patientId).select('userId');
    if (!patient?.userId) return;
    await createNotification({
      userId: patient.userId,
      userRole: 'patient',
      type: 'appointment',
      channels: ['in_app', 'push'],
      ...payload,
    });
  } catch (error) {
    console.error('Physio care notification failed:', error.message);
  }
}

// Courses past expiresAt are flipped to expired lazily whenever they are listed.
async function expireStaleCourses(filter) {
  try {
    await PhysioTreatmentCourse.updateMany(
      { ...filter, status: 'active', expiresAt: { $lt: new Date() } },
      { $set: { status: 'expired' } }
    );
  } catch (error) {
    console.error('Expire treatment courses failed:', error.message);
  }
}

function badRequest(res, error) {
  return res.status(400).json({ success: false, error });
}

/* ----------------------------- Packages ----------------------------- */

function applyPackageFields(target, body, isCreate) {
  const fields = ['name', 'description', 'visitType'];
  for (const key of fields) {
    if (body[key] !== undefined) target[key] = typeof body[key] === 'string' ? body[key].trim() : body[key];
  }
  const numbers = ['sessionCount', 'sessionDurationMin', 'price', 'validityDays'];
  for (const key of numbers) {
    if (body[key] !== undefined) {
      const n = optionalNumber(body[key]);
      if (n === undefined) return `${key} must be a number`;
      target[key] = n;
    }
  }
  if (body.isActive !== undefined && !isCreate) target.isActive = Boolean(body.isActive);
  return null;
}

exports.listMyPackages = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const filter = { physioId: physio._id };
    if (String(req.query.includeInactive) !== 'true') filter.isActive = true;
    const packages = await PhysioPackage.find(filter).sort({ createdAt: -1 });
    return res.json({ success: true, packages });
  } catch (error) {
    console.error('List physio packages error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch packages' });
  }
};

exports.createPackage = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const body = req.body || {};
    if (!String(body.name || '').trim()) return badRequest(res, 'name is required');
    if (body.sessionCount === undefined) return badRequest(res, 'sessionCount is required');
    if (body.price === undefined) return badRequest(res, 'price is required');
    const data = { physioId: physio._id };
    const error = applyPackageFields(data, body, true);
    if (error) return badRequest(res, error);
    const pkg = await PhysioPackage.create(data);
    return res.status(201).json({ success: true, package: pkg });
  } catch (error) {
    console.error('Create physio package error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create package' });
  }
};

exports.updatePackage = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    if (!isObjectId(req.params.id)) return badRequest(res, 'Invalid package id');
    const pkg = await PhysioPackage.findOne({ _id: req.params.id, physioId: physio._id });
    if (!pkg) return res.status(404).json({ success: false, error: 'Package not found' });
    const error = applyPackageFields(pkg, req.body || {}, false);
    if (error) return badRequest(res, error);
    await pkg.save();
    return res.json({ success: true, package: pkg });
  } catch (error) {
    console.error('Update physio package error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to update package' });
  }
};

exports.archivePackage = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    if (!isObjectId(req.params.id)) return badRequest(res, 'Invalid package id');
    const pkg = await PhysioPackage.findOne({ _id: req.params.id, physioId: physio._id, isActive: true });
    if (!pkg) return res.status(404).json({ success: false, error: 'Package not found' });
    pkg.isActive = false;
    await pkg.save();
    return res.json({ success: true, message: 'Package archived' });
  } catch (error) {
    console.error('Archive physio package error:', error);
    return res.status(500).json({ success: false, error: 'Failed to archive package' });
  }
};

exports.listPublicPackages = async (req, res) => {
  try {
    if (!isObjectId(req.params.physioId)) return badRequest(res, 'Invalid physioId');
    const packages = await PhysioPackage.find({ physioId: req.params.physioId, isActive: true })
      .select('-__v')
      .sort({ price: 1 });
    return res.json({ success: true, packages });
  } catch (error) {
    console.error('Public physio packages error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch packages' });
  }
};

/* -------------------------- Treatment courses -------------------------- */

exports.listMyCourses = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const filter = { physioId: physio._id };
    if (req.query.status) {
      if (!COURSE_STATUSES.includes(String(req.query.status))) return badRequest(res, 'Invalid status');
      filter.status = String(req.query.status);
    }
    if (req.query.patientId) {
      if (!isObjectId(req.query.patientId)) return badRequest(res, 'Invalid patientId');
      filter.patientId = req.query.patientId;
    }
    await expireStaleCourses({ physioId: physio._id });
    const courses = await PhysioTreatmentCourse.find(filter)
      .populate('patientId', 'name phone email')
      .sort({ createdAt: -1 });
    return res.json({ success: true, courses });
  } catch (error) {
    console.error('List treatment courses error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch treatment courses' });
  }
};

exports.createCourse = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const patientId = req.params.patientId;
    if (!isObjectId(patientId)) return badRequest(res, 'Invalid patientId');
    const patient = await PatientProfile.findById(patientId).select('userId name');
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    if (!await canTreatPatient(physio._id, patientId)) return res.status(403).json(NO_RELATIONSHIP);

    const body = req.body || {};
    const startDate = validDate(body.startDate) || new Date();
    if (validDate(body.startDate) === undefined) return badRequest(res, 'startDate is invalid');

    let pkg = null;
    let totalSessions;
    let price;
    let validityDays;
    if (body.packageId) {
      if (!isObjectId(body.packageId)) return badRequest(res, 'Invalid packageId');
      pkg = await PhysioPackage.findOne({ _id: body.packageId, physioId: physio._id, isActive: true });
      if (!pkg) return res.status(404).json({ success: false, error: 'Package not found' });
      totalSessions = pkg.sessionCount;
      price = pkg.price;
      validityDays = pkg.validityDays || 90;
    } else {
      totalSessions = optionalNumber(body.totalSessions);
      price = optionalNumber(body.price);
      validityDays = optionalNumber(body.validityDays) || 90;
      if (!Number.isInteger(totalSessions) || totalSessions < 1 || totalSessions > 100) {
        return badRequest(res, 'totalSessions must be an integer between 1 and 100');
      }
      if (price === undefined || price < 0) return badRequest(res, 'price must be a number >= 0');
    }

    let expiresAt = validDate(body.expiresAt);
    if (expiresAt === undefined) return badRequest(res, 'expiresAt is invalid');
    if (!expiresAt) expiresAt = new Date(startDate.getTime() + validityDays * DAY_MS);
    if (expiresAt <= startDate) return badRequest(res, 'expiresAt must be after startDate');

    const data = {
      physioId: physio._id,
      patientId,
      packageId: pkg ? pkg._id : undefined,
      packageSnapshot: pkg ? {
        name: pkg.name,
        sessionCount: pkg.sessionCount,
        sessionDurationMin: pkg.sessionDurationMin,
        visitType: pkg.visitType,
        price: pkg.price,
        validityDays: pkg.validityDays,
      } : undefined,
      title: String(body.title || pkg?.name || 'Physiotherapy treatment course').trim(),
      diagnosis: body.diagnosis,
      goals: stringArray(body.goals),
      totalSessions,
      sessionsUsed: 0,
      price,
      paymentStatus: 'pending',
      status: 'active',
      startDate,
      expiresAt,
      notes: body.notes,
      createdByUserId: req.user.id,
    };
    if (body.paymentStatus === 'paid') {
      if (!PAYMENT_METHODS.includes(body.paymentMethod)) return badRequest(res, 'paymentMethod must be cash, upi or online');
      data.paymentStatus = 'paid';
      data.paymentMethod = body.paymentMethod;
      data.paidAt = new Date();
    }

    const course = await PhysioTreatmentCourse.create(data);

    await notifyPatient(patientId, {
      title: 'Physiotherapy treatment course created',
      message: `${physio.name || 'Your physiotherapist'} started "${course.title}" (${course.totalSessions} sessions).`,
      relatedEntity: 'physio_course',
      relatedEntityId: course._id,
      data: { courseId: String(course._id), physioId: String(physio._id), screen: 'physio_course' },
    });

    return res.status(201).json({ success: true, course });
  } catch (error) {
    console.error('Create treatment course error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create treatment course' });
  }
};

async function loadOwnedCourse(req, res, physio) {
  if (!isObjectId(req.params.id)) {
    badRequest(res, 'Invalid course id');
    return null;
  }
  const course = await PhysioTreatmentCourse.findOne({ _id: req.params.id, physioId: physio._id });
  if (!course) {
    res.status(404).json({ success: false, error: 'Treatment course not found' });
    return null;
  }
  if (!await canTreatPatient(physio._id, course.patientId)) {
    res.status(403).json(NO_RELATIONSHIP);
    return null;
  }
  return course;
}

exports.getCourse = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const course = await loadOwnedCourse(req, res, physio);
    if (!course) return undefined;
    await course.populate([
      { path: 'patientId', select: 'name phone email' },
      { path: 'packageId', select: 'name isActive' },
      { path: 'appointmentIds', select: 'appointmentDate startTime endTime status type' },
    ]);
    return res.json({ success: true, course });
  } catch (error) {
    console.error('Get treatment course error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch treatment course' });
  }
};

exports.updateCourse = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const course = await loadOwnedCourse(req, res, physio);
    if (!course) return undefined;
    const body = req.body || {};

    for (const key of ['title', 'diagnosis', 'notes']) {
      if (body[key] !== undefined) course[key] = body[key];
    }
    if (body.goals !== undefined) course.goals = stringArray(body.goals);
    if (body.price !== undefined) {
      const price = optionalNumber(body.price);
      if (price === undefined || price < 0) return badRequest(res, 'price must be a number >= 0');
      course.price = price;
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = validDate(body.expiresAt);
      if (!expiresAt) return badRequest(res, 'expiresAt is invalid');
      course.expiresAt = expiresAt;
    }
    if (body.totalSessions !== undefined) {
      const total = optionalNumber(body.totalSessions);
      if (!Number.isInteger(total) || total < 1 || total > 100) return badRequest(res, 'totalSessions must be an integer between 1 and 100');
      if (total < course.sessionsUsed) return badRequest(res, 'totalSessions cannot be less than sessionsUsed');
      course.totalSessions = total;
    }

    if (body.paymentStatus !== undefined) {
      const status = String(body.paymentStatus);
      if (status === 'paid') {
        const method = body.paymentMethod || course.paymentMethod;
        if (!PAYMENT_METHODS.includes(method)) return badRequest(res, 'paymentMethod must be cash, upi or online');
        if (course.paymentStatus !== 'paid') course.paidAt = new Date();
        course.paymentStatus = 'paid';
        course.paymentMethod = method;
      } else if (status === 'refunded') {
        if (course.paymentStatus !== 'paid') return badRequest(res, 'Only a paid course can be refunded');
        course.paymentStatus = 'refunded';
      } else if (status === 'pending') {
        course.paymentStatus = 'pending';
        course.paymentMethod = undefined;
        course.paidAt = undefined;
      } else {
        return badRequest(res, 'Invalid paymentStatus');
      }
    } else if (body.paymentMethod !== undefined) {
      if (!PAYMENT_METHODS.includes(body.paymentMethod)) return badRequest(res, 'paymentMethod must be cash, upi or online');
      course.paymentMethod = body.paymentMethod;
    }

    if (body.status !== undefined) {
      const status = String(body.status);
      if (!COURSE_STATUSES.includes(status)) return badRequest(res, 'Invalid status');
      if (course.status === 'cancelled' && status !== 'cancelled') return badRequest(res, 'A cancelled course cannot be reopened');
      if (status === 'active') {
        if (course.sessionsUsed >= course.totalSessions) return badRequest(res, 'No sessions left; increase totalSessions to reactivate');
        if (course.expiresAt && course.expiresAt < new Date()) return badRequest(res, 'Course has expired; extend expiresAt to reactivate');
      }
      if (status === 'completed' && course.status !== 'completed') course.completedAt = new Date();
      course.status = status;
    } else if (course.status === 'active' && course.sessionsUsed >= course.totalSessions) {
      course.status = 'completed';
      course.completedAt = new Date();
    }

    await course.save();
    return res.json({ success: true, course });
  } catch (error) {
    console.error('Update treatment course error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to update treatment course' });
  }
};

exports.linkAppointment = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    if (!isObjectId(req.params.appointmentId)) return badRequest(res, 'Invalid appointmentId');
    const course = await loadOwnedCourse(req, res, physio);
    if (!course) return undefined;
    if (course.status !== 'active') return badRequest(res, `Cannot link appointments to a ${course.status} course`);

    const appointment = await Appointment.findOne({
      _id: req.params.appointmentId,
      physioId: physio._id,
      patientId: course.patientId,
      professionalType: 'physio',
    }).select('status treatmentCourseId patientId physioId');
    if (!appointment) return res.status(404).json({ success: false, error: 'Appointment not found for this patient' });
    if (UNLINKABLE_APPOINTMENT_STATUSES.includes(appointment.status)) {
      return badRequest(res, `Cannot link a ${appointment.status} appointment`);
    }
    if (appointment.treatmentCourseId && String(appointment.treatmentCourseId) !== String(course._id)) {
      return res.status(409).json({ success: false, error: 'Appointment is already linked to another treatment course' });
    }
    const alreadyLinked = String(appointment.treatmentCourseId || '') === String(course._id);
    if (!alreadyLinked && course.sessionsUsed >= course.totalSessions) {
      return badRequest(res, 'No sessions left in this course');
    }

    if (!alreadyLinked) {
      await Appointment.updateOne({ _id: appointment._id }, { $set: { treatmentCourseId: course._id } });
      await PhysioTreatmentCourse.updateOne({ _id: course._id }, { $addToSet: { appointmentIds: appointment._id } });
    }

    // Linking an already-completed session counts it straight away (idempotent).
    if (appointment.status === 'completed') {
      await applyTreatmentCourseSession({
        _id: appointment._id,
        status: appointment.status,
        treatmentCourseId: course._id,
      });
    }

    const updated = await PhysioTreatmentCourse.findById(course._id);
    return res.json({ success: true, alreadyLinked, course: updated });
  } catch (error) {
    console.error('Link course appointment error:', error);
    return res.status(500).json({ success: false, error: 'Failed to link appointment' });
  }
};

exports.listMyCoursesAsPatient = async (req, res) => {
  try {
    const patient = await currentPatient(req);
    if (!patient) return res.status(404).json(NO_PATIENT);
    await expireStaleCourses({ patientId: patient._id });
    const filter = { patientId: patient._id };
    if (req.query.status && COURSE_STATUSES.includes(String(req.query.status))) filter.status = String(req.query.status);
    const courses = await PhysioTreatmentCourse.find(filter)
      .select('-countedAppointmentIds')
      .populate('physioId', 'name specialization profileImage')
      .sort({ createdAt: -1 });
    return res.json({ success: true, courses });
  } catch (error) {
    console.error('Patient treatment courses error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch treatment courses' });
  }
};

/* ---------------------------- Assessments ---------------------------- */

function mapAssessmentBody(body) {
  const out = {};
  for (const key of ['type', 'chiefComplaint', 'functionalNotes', 'plan']) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (body.assessedAt !== undefined) out.assessedAt = body.assessedAt;
  if (body.painScore !== undefined) {
    out.painScore = {
      rest: optionalNumber(body.painScore?.rest),
      activity: optionalNumber(body.painScore?.activity),
    };
  }
  if (body.rom !== undefined) {
    out.rom = (Array.isArray(body.rom) ? body.rom : []).map(r => ({
      joint: r.joint,
      movement: r.movement,
      side: r.side || 'na',
      activeDeg: optionalNumber(r.activeDeg),
      passiveDeg: optionalNumber(r.passiveDeg),
      normalDeg: optionalNumber(r.normalDeg),
    }));
  }
  if (body.strength !== undefined) {
    out.strength = (Array.isArray(body.strength) ? body.strength : []).map(s => ({
      muscleGroup: s.muscleGroup,
      side: s.side || 'na',
      grade: optionalNumber(s.grade),
    }));
  }
  if (body.outcomeMeasures !== undefined) {
    out.outcomeMeasures = (Array.isArray(body.outcomeMeasures) ? body.outcomeMeasures : []).map(m => ({
      code: m.code ? String(m.code).toUpperCase() : m.code,
      score: optionalNumber(m.score),
      maxScore: optionalNumber(m.maxScore),
    }));
  }
  if (body.specialTests !== undefined) {
    out.specialTests = (Array.isArray(body.specialTests) ? body.specialTests : []).map(t => ({
      name: t.name,
      result: t.result,
      notes: t.notes,
    }));
  }
  return out;
}

function checkAssessedAt(value) {
  if (value === undefined) return null;
  const d = validDate(value);
  if (!d) return 'assessedAt is invalid';
  if (d.getTime() > Date.now() + FUTURE_SKEW_MS) return 'assessedAt cannot be in the future';
  return null;
}

exports.listPatientAssessments = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const patientId = req.params.patientId;
    if (!isObjectId(patientId)) return badRequest(res, 'Invalid patientId');
    if (!await canTreatPatient(physio._id, patientId)) return res.status(403).json(NO_RELATIONSHIP);
    const filter = { physioId: physio._id, patientId };
    if (req.query.type) filter.type = String(req.query.type);
    const assessments = await PhysioAssessment.find(filter).sort({ assessedAt: -1 });
    return res.json({ success: true, assessments });
  } catch (error) {
    console.error('List assessments error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch assessments' });
  }
};

exports.createAssessment = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const patientId = req.params.patientId;
    if (!isObjectId(patientId)) return badRequest(res, 'Invalid patientId');
    const patient = await PatientProfile.findById(patientId).select('userId name');
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    if (!await canTreatPatient(physio._id, patientId)) return res.status(403).json(NO_RELATIONSHIP);

    const body = req.body || {};
    const dateError = checkAssessedAt(body.assessedAt);
    if (dateError) return badRequest(res, dateError);

    if (body.appointmentId) {
      if (!isObjectId(body.appointmentId)) return badRequest(res, 'Invalid appointmentId');
      const linked = await Appointment.exists({ _id: body.appointmentId, physioId: physio._id, patientId, professionalType: 'physio' });
      if (!linked) return badRequest(res, 'appointmentId is not linked to this patient/physiotherapist');
    }
    if (body.courseId) {
      if (!isObjectId(body.courseId)) return badRequest(res, 'Invalid courseId');
      const course = await PhysioTreatmentCourse.exists({ _id: body.courseId, physioId: physio._id, patientId });
      if (!course) return badRequest(res, 'courseId is not linked to this patient/physiotherapist');
    }

    const assessment = await PhysioAssessment.create({
      ...mapAssessmentBody(body),
      physioId: physio._id,
      patientId,
      appointmentId: body.appointmentId || undefined,
      courseId: body.courseId || undefined,
      createdByUserId: req.user.id,
    });

    await notifyPatient(patientId, {
      title: 'New physiotherapy assessment',
      message: `${physio.name || 'Your physiotherapist'} recorded a ${assessment.type} assessment.`,
      relatedEntity: 'physio_assessment',
      relatedEntityId: assessment._id,
      data: { assessmentId: String(assessment._id), physioId: String(physio._id), screen: 'physio_assessment' },
    });

    return res.status(201).json({ success: true, assessment });
  } catch (error) {
    console.error('Create assessment error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create assessment' });
  }
};

async function loadOwnedAssessment(req, res, physio) {
  if (!isObjectId(req.params.id)) {
    badRequest(res, 'Invalid assessment id');
    return null;
  }
  const assessment = await PhysioAssessment.findOne({ _id: req.params.id, physioId: physio._id });
  if (!assessment) {
    res.status(404).json({ success: false, error: 'Assessment not found' });
    return null;
  }
  if (!await canTreatPatient(physio._id, assessment.patientId)) {
    res.status(403).json(NO_RELATIONSHIP);
    return null;
  }
  return assessment;
}

exports.getAssessment = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const assessment = await loadOwnedAssessment(req, res, physio);
    if (!assessment) return undefined;
    return res.json({ success: true, assessment });
  } catch (error) {
    console.error('Get assessment error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch assessment' });
  }
};

exports.updateAssessment = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const assessment = await loadOwnedAssessment(req, res, physio);
    if (!assessment) return undefined;
    const body = req.body || {};
    const dateError = checkAssessedAt(body.assessedAt);
    if (dateError) return badRequest(res, dateError);
    const updates = mapAssessmentBody(body);
    for (const [key, value] of Object.entries(updates)) assessment[key] = value;
    await assessment.save();
    return res.json({ success: true, assessment });
  } catch (error) {
    console.error('Update assessment error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to update assessment' });
  }
};

function percentOf(score, maxScore) {
  if (typeof score !== 'number' || typeof maxScore !== 'number' || maxScore <= 0) return null;
  return Math.round((score / maxScore) * 1000) / 10;
}

function changeOf(series, key) {
  const points = series.filter(p => typeof p[key] === 'number');
  if (!points.length) return null;
  const first = points[0][key];
  const latest = points[points.length - 1][key];
  return { first, latest, change: Math.round((latest - first) * 10) / 10 };
}

// Builds chronological trend series from assessments (any order in).
function computeProgressTrends(assessments) {
  const sorted = [...assessments].sort((a, b) => new Date(a.assessedAt) - new Date(b.assessedAt));
  const pain = [];
  const outcomeMeasures = {};
  const rom = {};

  for (const a of sorted) {
    const date = a.assessedAt;
    const rest = a.painScore?.rest;
    const activity = a.painScore?.activity;
    if (typeof rest === 'number' || typeof activity === 'number') {
      pain.push({ date, rest: typeof rest === 'number' ? rest : null, activity: typeof activity === 'number' ? activity : null });
    }
    for (const m of a.outcomeMeasures || []) {
      if (!m.code || typeof m.score !== 'number') continue;
      (outcomeMeasures[m.code] = outcomeMeasures[m.code] || []).push({
        date,
        score: m.score,
        maxScore: typeof m.maxScore === 'number' ? m.maxScore : null,
        percent: percentOf(m.score, m.maxScore),
      });
    }
    for (const r of a.rom || []) {
      if (!r.joint || !r.movement || typeof r.activeDeg !== 'number') continue;
      const key = `${String(r.joint).trim().toLowerCase()}|${String(r.movement).trim().toLowerCase()}|${r.side || 'na'}`;
      (rom[key] = rom[key] || []).push({ date, activeDeg: r.activeDeg });
    }
  }

  const firstToLatestChange = {
    pain: { rest: changeOf(pain, 'rest'), activity: changeOf(pain, 'activity') },
    outcomeMeasures: {},
    rom: {},
  };
  for (const [code, series] of Object.entries(outcomeMeasures)) {
    const score = changeOf(series, 'score');
    const percent = changeOf(series, 'percent');
    firstToLatestChange.outcomeMeasures[code] = {
      ...score,
      firstPercent: percent ? percent.first : null,
      latestPercent: percent ? percent.latest : null,
      percentChange: percent ? percent.change : null,
    };
  }
  for (const [key, series] of Object.entries(rom)) {
    firstToLatestChange.rom[key] = changeOf(series, 'activeDeg');
  }

  const last = sorted[sorted.length - 1] || null;
  return {
    assessmentCount: sorted.length,
    pain,
    outcomeMeasures,
    rom,
    latest: last ? {
      _id: last._id,
      type: last.type,
      assessedAt: last.assessedAt,
      painScore: last.painScore,
      outcomeMeasures: last.outcomeMeasures,
      rom: last.rom,
      strength: last.strength,
      plan: last.plan,
    } : null,
    firstToLatestChange,
  };
}

exports.getPatientProgress = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json(NO_PHYSIO);
    const patientId = req.params.patientId;
    if (!isObjectId(patientId)) return badRequest(res, 'Invalid patientId');
    if (!await canTreatPatient(physio._id, patientId)) return res.status(403).json(NO_RELATIONSHIP);
    const assessments = await PhysioAssessment.find({ physioId: physio._id, patientId }).sort({ assessedAt: 1 });
    return res.json({ success: true, patientId, progress: computeProgressTrends(assessments) });
  } catch (error) {
    console.error('Patient progress trends error:', error);
    return res.status(500).json({ success: false, error: 'Failed to compute progress' });
  }
};

exports.listMyAssessments = async (req, res) => {
  try {
    const patient = await currentPatient(req);
    if (!patient) return res.status(404).json(NO_PATIENT);
    const filter = { patientId: patient._id };
    if (req.query.physioId) {
      if (!isObjectId(req.query.physioId)) return badRequest(res, 'Invalid physioId');
      filter.physioId = req.query.physioId;
    }
    const assessments = await PhysioAssessment.find(filter)
      .select('-createdByUserId')
      .populate('physioId', 'name specialization profileImage')
      .sort({ assessedAt: -1 });
    return res.json({ success: true, assessments });
  } catch (error) {
    console.error('Patient assessments error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch assessments' });
  }
};

exports.computeProgressTrends = computeProgressTrends;
