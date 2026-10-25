const mongoose = require('mongoose');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const Appointment = require('../models/Appointment');
const PhysioExercise = require('../models/PhysioExercise');
const PhysioExercisePlan = require('../models/PhysioExercisePlan');
const PhysioExerciseProgress = require('../models/PhysioExerciseProgress');
const { createNotification } = require('../services/notification.service');

const isObjectId = value => mongoose.Types.ObjectId.isValid(String(value || ''));
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_PAIN_THRESHOLD = 8;

function stringArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function numeric(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function currentPhysio(req) {
  return PhysiotherapistProfile.findOne({ userId: req.user.id });
}

async function currentPatient(req) {
  return PatientProfile.findOne({ userId: req.user.id });
}

async function canTreatPatient(physioId, patientId) {
  return Appointment.exists({
    physioId,
    patientId,
    professionalType: 'physio',
    status: { $in: ['confirmed', 'accepted', 'in_progress', 'completed', 'rescheduled'] },
  });
}

async function validateExerciseIds(physioId, items) {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: 'At least one exercise is required' };
  }
  const ids = items.map(item => item.exerciseId);
  if (ids.some(id => !isObjectId(id))) {
    return { ok: false, error: 'One or more exerciseId values are invalid' };
  }
  if (new Set(ids.map(String)).size !== ids.length) {
    return { ok: false, error: 'The same exercise cannot be added twice to one plan' };
  }
  const allowedCount = await PhysioExercise.countDocuments({
    _id: { $in: ids },
    ownerPhysioId: physioId,
    isActive: true,
  });
  if (allowedCount !== ids.length) {
    return { ok: false, error: 'One or more exercises are unavailable to this physiotherapist' };
  }
  return { ok: true };
}

function mapPlanItems(items) {
  return items.map((item, index) => ({
    // Keep an existing item's id when the plan is edited: progress logs
    // reference planItemId, and a fresh id would orphan them from the
    // per-exercise adherence.
    ...(isObjectId(item._id) ? { _id: item._id } : {}),
    exerciseId: item.exerciseId,
    sets: numeric(item.sets),
    reps: numeric(item.reps),
    durationSec: numeric(item.durationSec),
    frequency: item.frequency ? String(item.frequency).trim() : undefined,
    holdSec: optionalNumber(item.holdSec),
    restSec: optionalNumber(item.restSec),
    side: item.side ? String(item.side).trim() : undefined,
    load: item.load ? String(item.load).trim() : undefined,
    timesPerDay: optionalNumber(item.timesPerDay),
    daysPerWeek: optionalNumber(item.daysPerWeek),
    notes: item.notes ? String(item.notes).trim() : undefined,
    sortOrder: numeric(item.sortOrder, index),
  }));
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Accepts slight client clock skew (<= 5 min) by clamping to now; anything
// further in the future is rejected.
function parsePerformedAt(value) {
  if (value === undefined || value === null || value === '') return { date: new Date() };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: 'performedAt is invalid' };
  const now = Date.now();
  if (date.getTime() > now + FUTURE_SKEW_MS) return { error: 'performedAt cannot be in the future' };
  return { date: date.getTime() > now ? new Date(now) : date };
}

async function createProgressLog(req, plan, loggedBy) {
  const planItemId = req.body?.planItemId;
  if (!isObjectId(planItemId)) return { status: 400, body: { success: false, error: 'planItemId is required' } };
  const item = plan.exercises.id(planItemId);
  if (!item) return { status: 400, body: { success: false, error: 'Exercise is not part of this plan' } };

  const parsed = parsePerformedAt(req.body.performedAt);
  if (parsed.error) return { status: 400, body: { success: false, error: parsed.error } };

  const progress = await PhysioExerciseProgress.create({
    planId: plan._id,
    planItemId: item._id,
    exerciseId: item.exerciseId?._id || item.exerciseId,
    patientId: plan.patientId?._id || plan.patientId,
    physioId: plan.physioId?._id || plan.physioId,
    performedAt: parsed.date,
    setsCompleted: numeric(req.body.setsCompleted),
    repsCompleted: numeric(req.body.repsCompleted),
    durationSec: numeric(req.body.durationSec),
    painBefore: req.body.painBefore === undefined ? undefined : numeric(req.body.painBefore),
    painAfter: req.body.painAfter === undefined ? undefined : numeric(req.body.painAfter),
    perceivedDifficulty: req.body.perceivedDifficulty,
    completed: req.body.completed !== false,
    notes: req.body.notes,
    loggedBy,
    loggedByUserId: req.user.id,
  });

  if (loggedBy === 'patient' && typeof progress.painAfter === 'number' && progress.painAfter >= HIGH_PAIN_THRESHOLD) {
    await notifyPhysioHighPain(plan, progress).catch(error => console.error('High pain notification failed:', error.message));
  }

  await progress.populate('exerciseId', 'name bodyPart category');
  return { status: 201, body: { success: true, progress } };
}

async function notifyPhysioHighPain(plan, progress) {
  const physio = await PhysiotherapistProfile.findById(plan.physioId?._id || plan.physioId).select('userId name');
  if (!physio?.userId) return;
  const patient = await PatientProfile.findById(plan.patientId?._id || plan.patientId).select('name');
  await createNotification({
    userId: physio.userId,
    userRole: 'physio',
    title: 'High pain reported after exercise',
    message: (patient?.name || 'A patient') + ' reported pain ' + progress.painAfter + '/10 after an exercise in "' + (plan.title || 'exercise plan') + '".',
    type: 'appointment',
    priority: 'high',
    relatedEntity: 'physio_exercise_plan',
    relatedEntityId: plan._id,
    data: { exercisePlanId: String(plan._id), progressId: String(progress._id), screen: 'physio_exercise_plan' },
    channels: ['in_app', 'push'],
  });
}

function computeAdherence(plan, logs, from, to) {
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
  const weeks = days / 7;
  const inRange = logs.filter(log => {
    const t = new Date(log.performedAt).getTime();
    return t >= from.getTime() && t <= to.getTime();
  });

  let totalPrescribed = 0;
  let totalCompleted = 0;
  const items = (plan.exercises || []).map(item => {
    const timesPerDay = item.timesPerDay || 1;
    const daysPerWeek = item.daysPerWeek || 7;
    const prescribedSessions = Math.max(1, Math.round(timesPerDay * daysPerWeek * weeks));
    const itemLogs = inRange.filter(log => String(log.planItemId) === String(item._id));
    const completedSessions = itemLogs.filter(log => log.completed !== false).length;
    totalPrescribed += prescribedSessions;
    totalCompleted += Math.min(completedSessions, prescribedSessions);
    const exercise = item.exerciseId && item.exerciseId._id ? item.exerciseId : null;
    return {
      planItemId: item._id,
      exerciseId: exercise ? exercise._id : item.exerciseId,
      exerciseName: exercise?.name || null,
      timesPerDay,
      daysPerWeek,
      prescribedSessions,
      completedSessions,
      compliancePercent: Math.min(100, Math.round((completedSessions / prescribedSessions) * 100)),
      averagePainBefore: average(itemLogs.map(x => x.painBefore)),
      averagePainAfter: average(itemLogs.map(x => x.painAfter)),
      lastLoggedAt: latestDate(itemLogs),
    };
  });

  return {
    from,
    to,
    days,
    weeks: Math.round(weeks * 100) / 100,
    overall: {
      prescribedSessions: totalPrescribed,
      completedSessions: totalCompleted,
      compliancePercent: totalPrescribed ? Math.min(100, Math.round((totalCompleted / totalPrescribed) * 100)) : 0,
      averagePainBefore: average(inRange.map(x => x.painBefore)),
      averagePainAfter: average(inRange.map(x => x.painAfter)),
      lastLoggedAt: latestDate(inRange),
      totalLogs: inRange.length,
    },
    items,
  };
}

function latestDate(logs) {
  let latest = null;
  for (const log of logs) {
    const d = new Date(log.performedAt);
    if (!latest || d > latest) latest = d;
  }
  return latest;
}

function progressSummary(logs) {
  const completed = logs.filter(log => log.completed).length;
  return {
    totalLogs: logs.length,
    completedLogs: completed,
    lastPerformedAt: logs[0]?.performedAt || null,
    averagePainBefore: average(logs.map(x => x.painBefore)),
    averagePainAfter: average(logs.map(x => x.painAfter)),
  };
}

function average(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

exports.listExercises = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    const filter = { ownerPhysioId: physio._id, isActive: true };
    if (req.query.category) filter.category = String(req.query.category).trim();
    if (req.query.bodyPart) filter.bodyPart = String(req.query.bodyPart).trim();
    if (req.query.search) {
      const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ name: regex }, { description: regex }, { category: regex }, { bodyPart: regex }];
    }

    const exercises = await PhysioExercise.find(filter).sort({ name: 1 });
    return res.json({ success: true, exercises });
  } catch (error) {
    console.error('List physio exercises error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch exercise catalogue' });
  }
};

exports.createExercise = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });

    const exercise = await PhysioExercise.create({
      ownerPhysioId: physio._id,
      createdByUserId: req.user.id,
      name,
      description: req.body.description,
      category: req.body.category,
      bodyPart: req.body.bodyPart,
      difficulty: req.body.difficulty || 'moderate',
      equipment: stringArray(req.body.equipment),
      instructions: stringArray(req.body.instructions),
      precautions: stringArray(req.body.precautions),
      defaultSets: numeric(req.body.defaultSets),
      defaultReps: numeric(req.body.defaultReps),
      defaultDurationSec: numeric(req.body.defaultDurationSec),
      defaultFrequency: req.body.defaultFrequency,
      imageUrl: req.body.imageUrl,
      videoUrl: req.body.videoUrl,
    });
    return res.status(201).json({ success: true, exercise });
  } catch (error) {
    console.error('Create physio exercise error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create exercise' });
  }
};

exports.updateExercise = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const exercise = await PhysioExercise.findOne({
      _id: req.params.id,
      ownerPhysioId: physio._id,
      isActive: true,
    });
    if (!exercise) return res.status(404).json({ success: false, error: 'Exercise not found' });

    const scalarFields = [
      'name', 'description', 'category', 'bodyPart', 'difficulty',
      'defaultSets', 'defaultReps', 'defaultDurationSec', 'defaultFrequency',
      'imageUrl', 'videoUrl',
    ];
    for (const key of scalarFields) {
      if (req.body[key] !== undefined) exercise[key] = req.body[key];
    }
    if (req.body.equipment !== undefined) exercise.equipment = stringArray(req.body.equipment);
    if (req.body.instructions !== undefined) exercise.instructions = stringArray(req.body.instructions);
    if (req.body.precautions !== undefined) exercise.precautions = stringArray(req.body.precautions);
    await exercise.save();
    return res.json({ success: true, exercise });
  } catch (error) {
    console.error('Update physio exercise error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to update exercise' });
  }
};

exports.archiveExercise = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const exercise = await PhysioExercise.findOne({ _id: req.params.id, ownerPhysioId: physio._id, isActive: true });
    if (!exercise) return res.status(404).json({ success: false, error: 'Exercise not found' });
    exercise.isActive = false;
    await exercise.save();
    return res.json({ success: true, message: 'Exercise archived' });
  } catch (error) {
    console.error('Archive physio exercise error:', error);
    return res.status(500).json({ success: false, error: 'Failed to archive exercise' });
  }
};

exports.listPatientPlans = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    const patientId = req.params.patientId;
    if (!physio || !isObjectId(patientId)) return res.status(400).json({ success: false, error: 'Invalid physiotherapist or patient' });
    if (!await canTreatPatient(physio._id, patientId)) return res.status(403).json({ success: false, error: 'No treatment relationship with this patient' });

    const plans = await PhysioExercisePlan.find({ physioId: physio._id, patientId })
      .populate('exercises.exerciseId')
      .sort({ createdAt: -1 });
    return res.json({ success: true, plans });
  } catch (error) {
    console.error('List patient exercise plans error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch exercise plans' });
  }
};

exports.getPlan = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, physioId: physio._id })
      .populate('patientId', 'name phone email')
      .populate('exercises.exerciseId');
    if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });
    const logs = await PhysioExerciseProgress.find({ planId: plan._id })
      .populate('exerciseId', 'name')
      .sort({ performedAt: -1 })
      .limit(200);
    return res.json({ success: true, plan, progress: logs, summary: progressSummary(logs) });
  } catch (error) {
    console.error('Get exercise plan error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch exercise plan' });
  }
};

exports.createPatientPlan = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    const patientId = req.params.patientId;
    if (!physio || !isObjectId(patientId)) return res.status(400).json({ success: false, error: 'Invalid physiotherapist or patient' });
    const patient = await PatientProfile.findById(patientId).select('userId name');
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    if (!await canTreatPatient(physio._id, patientId)) return res.status(403).json({ success: false, error: 'No treatment relationship with this patient' });

    const rawItems = Array.isArray(req.body?.exercises) ? req.body.exercises : [];
    const validation = await validateExerciseIds(physio._id, rawItems);
    if (!validation.ok) return res.status(400).json({ success: false, error: validation.error });

    if (req.body.appointmentId) {
      const linked = await Appointment.exists({
        _id: req.body.appointmentId,
        physioId: physio._id,
        patientId,
        professionalType: 'physio',
      });
      if (!linked) return res.status(400).json({ success: false, error: 'appointmentId is not linked to this patient/physiotherapist' });
    }

    const plan = await PhysioExercisePlan.create({
      physioId: physio._id,
      patientId,
      appointmentId: req.body.appointmentId || undefined,
      title: req.body.title || undefined,
      goals: stringArray(req.body.goals),
      instructions: req.body.instructions,
      exercises: mapPlanItems(rawItems),
      startDate: req.body.startDate || undefined,
      endDate: req.body.endDate || undefined,
      status: 'active',
      createdByUserId: req.user.id,
    });

    if (patient.userId) {
      await createNotification({
        userId: patient.userId,
        title: 'New physiotherapy exercise plan',
        message: `${physio.name || 'Your physiotherapist'} assigned a new exercise plan.`,
        type: 'appointment',
        data: { exercisePlanId: String(plan._id), physioId: String(physio._id), screen: 'physio_exercise_plan' },
        channels: ['in_app', 'push'],
      }).catch(error => console.error('Exercise plan notification failed:', error.message));
    }

    await plan.populate('exercises.exerciseId');
    return res.status(201).json({ success: true, plan });
  } catch (error) {
    console.error('Create patient exercise plan error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create exercise plan' });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, physioId: physio._id });
    if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });

    if (req.body.exercises !== undefined) {
      const validation = await validateExerciseIds(physio._id, req.body.exercises);
      if (!validation.ok) return res.status(400).json({ success: false, error: validation.error });
      plan.exercises = mapPlanItems(req.body.exercises);
    }
    if (req.body.title !== undefined) plan.title = req.body.title;
    if (req.body.goals !== undefined) plan.goals = stringArray(req.body.goals);
    if (req.body.instructions !== undefined) plan.instructions = req.body.instructions;
    if (req.body.startDate !== undefined) plan.startDate = req.body.startDate;
    if (req.body.endDate !== undefined) plan.endDate = req.body.endDate || undefined;
    if (req.body.status !== undefined) plan.status = req.body.status;
    await plan.save();

    const patient = await PatientProfile.findById(plan.patientId).select('userId');
    if (patient?.userId) {
      await createNotification({
        userId: patient.userId,
        title: 'Physiotherapy plan updated',
        message: 'Your physiotherapist updated your exercise plan.',
        type: 'appointment',
        data: { exercisePlanId: String(plan._id), screen: 'physio_exercise_plan' },
        channels: ['in_app', 'push'],
      }).catch(() => {});
    }

    await plan.populate('exercises.exerciseId');
    return res.json({ success: true, plan });
  } catch (error) {
    console.error('Update exercise plan error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to update exercise plan' });
  }
};

exports.cancelPlan = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, physioId: physio._id });
    if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });
    plan.status = 'cancelled';
    await plan.save();
    return res.json({ success: true, plan });
  } catch (error) {
    console.error('Cancel exercise plan error:', error);
    return res.status(500).json({ success: false, error: 'Failed to cancel exercise plan' });
  }
};

exports.getPlanProgress = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, physioId: physio._id });
    if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });
    const logs = await PhysioExerciseProgress.find({ planId: plan._id })
      .populate('exerciseId', 'name bodyPart category')
      .sort({ performedAt: -1 })
      .limit(500);
    return res.json({ success: true, progress: logs, summary: progressSummary(logs) });
  } catch (error) {
    console.error('Exercise plan progress error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch exercise progress' });
  }
};

exports.listMyPlans = async (req, res) => {
  try {
    const patient = await currentPatient(req);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient profile not found' });
    const plans = await PhysioExercisePlan.find({ patientId: patient._id, status: { $in: ['active', 'completed'] } })
      .populate('physioId', 'name specialization profileImage')
      .populate('exercises.exerciseId')
      .sort({ createdAt: -1 });
    return res.json({ success: true, plans });
  } catch (error) {
    console.error('Patient exercise plans error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch physiotherapy plans' });
  }
};

exports.getMyPlan = async (req, res) => {
  try {
    const patient = await currentPatient(req);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, patientId: patient._id })
      .populate('physioId', 'name specialization profileImage')
      .populate('exercises.exerciseId');
    if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });
    const logs = await PhysioExerciseProgress.find({ planId: plan._id, patientId: patient._id })
      .populate('exerciseId', 'name')
      .sort({ performedAt: -1 })
      .limit(200);
    return res.json({ success: true, plan, progress: logs, summary: progressSummary(logs) });
  } catch (error) {
    console.error('Patient exercise plan detail error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch exercise plan' });
  }
};

exports.logMyProgress = async (req, res) => {
  try {
    const patient = await currentPatient(req);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, patientId: patient._id, status: 'active' });
    if (!plan) return res.status(404).json({ success: false, error: 'Active exercise plan not found' });

    const result = await createProgressLog(req, plan, 'patient');
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Log physiotherapy progress error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to log exercise progress' });
  }
};

// Physio records a supervised/in-clinic session against the plan.
exports.logPhysioProgress = async (req, res) => {
  try {
    const physio = await currentPhysio(req);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, physioId: physio._id, status: 'active' });
    if (!plan) return res.status(404).json({ success: false, error: 'Active exercise plan not found' });
    if (!await canTreatPatient(physio._id, plan.patientId)) return res.status(403).json({ success: false, error: 'No treatment relationship with this patient' });

    const result = await createProgressLog(req, plan, 'physio');
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Physio log progress error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to log exercise progress' });
  }
};

// GET /plans/:id/adherence?from=&to= (owning physio or owning patient)
exports.getPlanAdherence = async (req, res) => {
  try {
    const planId = req.params.id;
    if (!isObjectId(planId)) return res.status(400).json({ success: false, error: 'Invalid plan id' });

    let plan;
    if (req.user.role === 'physio') {
      const physio = await currentPhysio(req);
      if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });
      plan = await PhysioExercisePlan.findOne({ _id: planId, physioId: physio._id }).populate('exercises.exerciseId', 'name');
      if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });
      if (!await canTreatPatient(physio._id, plan.patientId)) return res.status(403).json({ success: false, error: 'No treatment relationship with this patient' });
    } else {
      const patient = await currentPatient(req);
      if (!patient) return res.status(404).json({ success: false, error: 'Patient profile not found' });
      plan = await PhysioExercisePlan.findOne({ _id: planId, patientId: patient._id }).populate('exercises.exerciseId', 'name');
      if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });
    }

    const now = new Date();
    const planStart = plan.startDate ? new Date(plan.startDate) : new Date(plan.createdAt || now);
    let from = req.query.from ? new Date(req.query.from) : planStart;
    let to = req.query.to ? new Date(req.query.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ success: false, error: 'from/to must be valid dates' });
    }
    if (from < planStart) from = planStart;
    if (plan.endDate && to > new Date(plan.endDate)) to = new Date(plan.endDate);
    if (to > now) to = now;
    if (from > to) return res.status(400).json({ success: false, error: 'from must be before to' });

    const logs = await PhysioExerciseProgress.find({
      planId: plan._id,
      performedAt: { $gte: from, $lte: to },
    }).sort({ performedAt: -1 });

    return res.json({ success: true, planId: plan._id, adherence: computeAdherence(plan, logs, from, to) });
  } catch (error) {
    console.error('Exercise plan adherence error:', error);
    return res.status(500).json({ success: false, error: 'Failed to compute adherence' });
  }
};

exports.canTreatPatient = canTreatPatient;
exports.computeAdherence = computeAdherence;

exports.getMyPlanProgress = async (req, res) => {
  try {
    const patient = await currentPatient(req);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient profile not found' });
    const plan = await PhysioExercisePlan.findOne({ _id: req.params.id, patientId: patient._id });
    if (!plan) return res.status(404).json({ success: false, error: 'Exercise plan not found' });
    const logs = await PhysioExerciseProgress.find({ planId: plan._id, patientId: patient._id })
      .populate('exerciseId', 'name bodyPart category')
      .sort({ performedAt: -1 })
      .limit(500);
    return res.json({ success: true, progress: logs, summary: progressSummary(logs) });
  } catch (error) {
    console.error('Patient exercise progress error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch exercise progress' });
  }
};
