const AppointmentSlotLock = require('../models/AppointmentSlotLock');
const { localDateKey } = require('./doctorAvailability.service');

function professionalIdFromAppointment(appointment) {
  if (!appointment) return null;
  if (appointment.professionalType === 'doctor') return appointment.doctorId;
  if (appointment.professionalType === 'physio') return appointment.physioId;
  if (appointment.professionalType === 'pathology') return appointment.pathologyId;
  return null;
}

async function acquireSlotLock({ professionalType, professionalId, appointmentDate, startTime, userId }) {
  try {
    return await AppointmentSlotLock.create({
      professionalType,
      professionalId,
      dateKey: localDateKey(appointmentDate),
      startTime,
      createdBy: userId,
    });
  } catch (error) {
    if (error?.code === 11000) {
      const conflict = new Error('This appointment slot was just booked by another patient. Please choose another time.');
      conflict.statusCode = 409;
      conflict.code = 'SLOT_ALREADY_BOOKED';
      throw conflict;
    }
    throw error;
  }
}

async function attachAppointment(lock, appointmentId) {
  if (!lock) return null;
  lock.appointmentId = appointmentId;
  return lock.save();
}

async function releaseSlotLockForAppointment(appointment) {
  if (!appointment) return;
  const professionalId = professionalIdFromAppointment(appointment);
  const or = [{ appointmentId: appointment._id }];
  if (professionalId && appointment.appointmentDate && appointment.startTime) {
    or.push({
      professionalType: appointment.professionalType,
      professionalId,
      dateKey: localDateKey(appointment.appointmentDate),
      startTime: appointment.startTime,
    });
  }
  await AppointmentSlotLock.deleteMany({ $or: or });
}

async function ensureLegacyLock(appointment, userId) {
  const professionalId = professionalIdFromAppointment(appointment);
  if (!professionalId) return null;
  try {
    const lock = await acquireSlotLock({
      professionalType: appointment.professionalType,
      professionalId,
      appointmentDate: appointment.appointmentDate,
      startTime: appointment.startTime,
      userId,
    });
    await attachAppointment(lock, appointment._id);
    return lock;
  } catch (error) {
    if (error.code === 'SLOT_ALREADY_BOOKED') return null;
    throw error;
  }
}

module.exports = {
  professionalIdFromAppointment,
  acquireSlotLock,
  attachAppointment,
  releaseSlotLockForAppointment,
  ensureLegacyLock,
};
