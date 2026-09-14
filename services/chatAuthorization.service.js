const Appointment = require('../models/Appointment');
const LabTest = require('../models/LabTest');
const EPharmacyOrder = require('../models/EPharmacyOrder');
const PharmacyProfile = require('../models/PharmacyProfile');

function sameId(a, b) {
  return Boolean(a && b && String(a) === String(b));
}

function canUserAccessSession(user, session) {
  if (!user?.profileId || !session) return false;
  if (user.role === 'patient') return sameId(user.profileId, session.patientId);
  if (['doctor', 'physio', 'pathology', 'pharmacy'].includes(user.role)) {
    return session.professionalType === user.role && sameId(user.profileId, session.professionalId);
  }
  return false;
}

function appointmentProfessionalFilter(professionalType, professionalId) {
  if (professionalType === 'doctor') return { doctorId: professionalId };
  if (professionalType === 'physio') return { physioId: professionalId };
  if (professionalType === 'pathology') return { pathologyId: professionalId };
  return null;
}

async function hasVerifiedRelationship({ patientId, professionalId, professionalType, appointmentId }) {
  const professionalFilter = appointmentProfessionalFilter(professionalType, professionalId);

  if (professionalFilter) {
    const appointmentFilter = { patientId, ...professionalFilter };
    if (appointmentId) appointmentFilter._id = appointmentId;
    const appointmentExists = await Appointment.exists(appointmentFilter);
    if (appointmentExists) return true;

    if (appointmentId) return false;
  }

  if (professionalType === 'pathology') {
    return Boolean(await LabTest.exists({ patientId, pathologyId: professionalId }));
  }

  if (professionalType === 'pharmacy') {
    const pharmacy = await PharmacyProfile.findById(professionalId)
      .select('organizationId defaultStoreId')
      .lean();
    if (!pharmacy) return false;

    const orderFilter = { patientId };
    if (pharmacy.organizationId) orderFilter.organizationId = pharmacy.organizationId;
    else if (pharmacy.defaultStoreId) orderFilter.storeId = pharmacy.defaultStoreId;
    else return false;

    return Boolean(await EPharmacyOrder.exists(orderFilter));
  }

  return false;
}

function deriveParticipants(user, body) {
  if (!user?.profileId) {
    return { error: 'Profile ID not found in authenticated user context', status: 403 };
  }

  if (user.role === 'patient') {
    if (!body.professionalId || !body.professionalType) {
      return { error: 'professionalId and professionalType are required', status: 400 };
    }
    if (!['doctor', 'physio', 'pathology', 'pharmacy'].includes(body.professionalType)) {
      return { error: 'Unsupported professionalType', status: 400 };
    }
    return {
      patientId: user.profileId,
      professionalId: body.professionalId,
      professionalType: body.professionalType,
      appointmentId: body.appointmentId,
    };
  }

  if (['doctor', 'physio', 'pathology', 'pharmacy'].includes(user.role)) {
    if (!body.patientId) return { error: 'patientId is required', status: 400 };
    if (body.professionalType && body.professionalType !== user.role) {
      return { error: 'professionalType does not match authenticated role', status: 403 };
    }
    if (body.professionalId && !sameId(body.professionalId, user.profileId)) {
      return { error: 'professionalId does not match authenticated profile', status: 403 };
    }
    return {
      patientId: body.patientId,
      professionalId: user.profileId,
      professionalType: user.role,
      appointmentId: body.appointmentId,
    };
  }

  return { error: 'This role cannot create chat sessions', status: 403 };
}

module.exports = {
  canUserAccessSession,
  hasVerifiedRelationship,
  deriveParticipants,
};
