// controllers/patient.controller.js  (UPDATED to match PatientProfile schema)
const PatientProfile = require('../models/PatientProfile');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const LabTest = require('../models/LabTest');
const Invoice = require('../models/Invoice');
const User = require('../models/User');

// ---------- helpers ----------
const safeDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const splitName = (fullName = '') => {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] }; // fallback
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
};

const normalizePhone = (v) => (v ? String(v).replace(/\D/g, '').slice(-10) : '');

const normalizeAddress = (address = {}) => ({
  street: address.street || address.address || '',
  city: address.city || '',
  state: address.state || '',
  pincode: address.pincode || '',
  country: address.country || 'India',
  location:
    address.location && Array.isArray(address.location.coordinates)
      ? address.location
      : { type: 'Point', coordinates: [0, 0] }
});

// ========== PATIENT-ONLY FUNCTIONS ==========

// GET /patient/profile
exports.getProfile = async (req, res) => {
  try {
    const profile = await PatientProfile.findOne({ userId: req.user.id })
      .populate('userId', 'email isVerified lastLogin');

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found. Please complete your profile.'
      });
    }

    return res.json({ success: true, profile });
  } catch (error) {
    console.error('Error fetching patient profile:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
};

// POST /patient/profile
exports.createProfile = async (req, res) => {
  try {
    const body = req.body || {};

    // Check user exists
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Prevent duplicate (schema unique userId)
    const existing = await PatientProfile.findOne({ userId: req.user.id });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Patient profile already exists',
        profile: existing
      });
    }

    // Name fields are REQUIRED by schema
    const firstName = (body.firstName || '').trim();
    const lastName = (body.lastName || '').trim();

    // If frontend sends "name" only, derive firstName/lastName
    let derived = { firstName, lastName };
    if ((!firstName || !lastName) && body.name) {
      derived = splitName(body.name);
    }

    const finalFirstName = (derived.firstName || '').trim();
    const finalLastName = (derived.lastName || '').trim();

    const phone = normalizePhone(body.phone || user.phone);
    const dateOfBirth = safeDate(body.dateOfBirth);

    // Required validations (align with schema)
    if (!finalFirstName) return res.status(400).json({ success: false, error: 'firstName is required' });
    // if (!finalLastName) return res.status(400).json({ success: false, error: 'lastName is required' });
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required (10 digits)' });
    if (!body.gender) return res.status(400).json({ success: false, error: 'gender is required' });
    if (!dateOfBirth) return res.status(400).json({ success: false, error: 'dateOfBirth is required' });

    const profile = await PatientProfile.create({
      userId: req.user.id,

      // Personal
      firstName: finalFirstName,
      middleName: body.middleName,
      lastName: finalLastName,
      name: body.name ? String(body.name).trim() : `${finalFirstName} ${finalLastName}`.trim(),
      salutation: body.salutation, // optional, schema default applies if not set

      email: (body.email || user.email || '').toLowerCase().trim(),
      phone,
      alternatePhone: normalizePhone(body.alternatePhone),

      // Demographics
      gender: body.gender,
      dateOfBirth,
      // age will be calculated by pre-save if not provided
      // age: body.age,

      // Address
      address: normalizeAddress(body.address),

      // Medical
      bloodGroup: body.bloodGroup ?? 'Unknown',
      height: body.height !== undefined && body.height !== '' ? Number(body.height) : undefined,
      weight: body.weight !== undefined && body.weight !== '' ? Number(body.weight) : undefined,
      // bmi auto-calculated by pre-save if height & weight provided

      // Emergency contact (schema expects object)
      emergencyContact: body.emergencyContact || undefined,

      // Optional IDs / insurance / prefs
      aadhaarNumber: body.aadhaarNumber,
      panNumber: body.panNumber,
      insuranceProvider: body.insuranceProvider,
      insurancePolicyNumber: body.insurancePolicyNumber,
      insuranceValidity: safeDate(body.insuranceValidity),
      preferences: body.preferences
    });

    // Update user role if needed
    if (user.role !== 'patient') {
      user.role = 'patient';
      await user.save();
    }

    user.profileId=profile._id;
    user.save();

    return res.status(201).json({
      success: true,
      message: 'Patient profile created successfully',
      profile
    });
  } catch (error) {
    console.error('Error creating patient profile:', error);

    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach((key) => {
        errors[key] = error.errors[key].message;
      });
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        errors
      });
    }

    return res.status(400).json({ success: false, error: error.message });
  }
};

// PUT /patient/profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = { ...(req.body || {}) };

    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found. Please create your profile first.'
      });
    }

    // Do not allow changes to these
    delete updates.patientId;
    delete updates.totalAppointments;
    delete updates.totalPrescriptions;
    delete updates.totalLabTests;
    delete updates.userId;
    delete updates.registeredAt;
    delete updates.updatedAt;
    delete updates.createdAt;

    // If name parts changed, keep full name in sync
    if (updates.firstName || updates.lastName) {
      const firstName = (updates.firstName || profile.firstName || '').trim();
      const lastName = (updates.lastName || profile.lastName || '').trim();
      if (firstName && lastName) updates.name = `${firstName} ${lastName}`.trim();
    }

    // Normalize dateOfBirth (schema requires a valid Date)
    if (updates.dateOfBirth) {
      const dob = safeDate(updates.dateOfBirth);
      if (!dob) {
        return res.status(400).json({ success: false, error: 'Invalid dateOfBirth' });
      }
      updates.dateOfBirth = dob;
      // age will be recalculated in pre-save if missing; if you want force update:
      updates.age = profile.calculateAge ? profile.calculateAge.call({ dateOfBirth: dob }) : undefined;
    }

    // Normalize phone fields
    if (updates.phone) updates.phone = normalizePhone(updates.phone);
    if (updates.alternatePhone) updates.alternatePhone = normalizePhone(updates.alternatePhone);

    // Normalize address
    if (updates.address) updates.address = normalizeAddress(updates.address);

    // Normalize height/weight numeric
    if (updates.height !== undefined && updates.height !== '') updates.height = Number(updates.height);
    if (updates.weight !== undefined && updates.weight !== '') updates.weight = Number(updates.weight);

    // Apply updates
    Object.keys(updates).forEach((k) => {
      profile[k] = updates[k];
    });

    await profile.save(); // triggers pre-save: age/bmi/updatedAt/patientId/name

    // Update user email if changed
    if (updates.email) {
      await User.findByIdAndUpdate(profile.userId, { email: updates.email });
    }

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      profile
    });
  } catch (error) {
    console.error('Error updating patient profile:', error);

    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach((key) => {
        errors[key] = error.errors[key].message;
      });
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        errors
      });
    }

    return res.status(400).json({ success: false, error: error.message });
  }
};

// GET /patient/medical-history
exports.getMedicalHistory = async (req, res) => {
  try {
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    return res.json({
      success: true,
      medicalHistory: {
        // schema arrays
        medicalHistory: profile.medicalHistory || [],
        allergies: profile.allergies || [],
        currentMedications: profile.currentMedications || [],
        chronicConditions: profile.chronicConditions || []
      },
      summary: {
        totalMedicalHistory: profile.medicalHistory?.length || 0,
        totalAllergies: profile.allergies?.length || 0,
        totalMedications: profile.currentMedications?.length || 0,
        totalChronicConditions: profile.chronicConditions?.length || 0
      }
    });
  } catch (error) {
    console.error('Error fetching medical history:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch medical history' });
  }
};

// POST /patient/medical-history
exports.addMedicalRecord = async (req, res) => {
  try {
    const { recordType, data } = req.body || {};

    if (!recordType || !data) {
      return res.status(400).json({ success: false, error: 'recordType and data are required' });
    }

    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    // Map incoming generic "data" to schema-specific shapes:
    // medicalHistory[] requires: condition (required)
    // allergies[] requires: allergen (required)
    // currentMedications[] requires: medicineName (required)
    // chronicConditions[]: condition optional in schema, but we’ll accept either.

    let record;
    switch (recordType) {
      case 'medicalHistory': {
        if (!data.condition) {
          return res.status(400).json({ success: false, error: 'data.condition is required for medicalHistory' });
        }
        record = {
          condition: String(data.condition).trim(),
          diagnosedDate: safeDate(data.diagnosedDate),
          status: data.status,
          severity: data.severity,
          notes: data.notes,
          addedBy: req.user.id,
          addedAt: new Date()
        };
        profile.medicalHistory = profile.medicalHistory || [];
        profile.medicalHistory.push(record);
        break;
      }

      case 'allergy': {
        if (!data.allergen) {
          return res.status(400).json({ success: false, error: 'data.allergen is required for allergy' });
        }
        record = {
          allergen: String(data.allergen).trim(),
          reaction: data.reaction,
          severity: data.severity,
          firstObserved: safeDate(data.firstObserved),
          notes: data.notes,
          addedAt: new Date()
        };
        profile.allergies = profile.allergies || [];
        profile.allergies.push(record);
        break;
      }

      case 'medication': {
        if (!data.medicineName) {
          return res.status(400).json({ success: false, error: 'data.medicineName is required for medication' });
        }
        record = {
          medicineName: String(data.medicineName).trim(),
          dosage: data.dosage,
          frequency: data.frequency,
          prescribedBy: data.prescribedBy,
          startDate: safeDate(data.startDate),
          endDate: safeDate(data.endDate),
          purpose: data.purpose,
          notes: data.notes,
          addedAt: new Date()
        };
        profile.currentMedications = profile.currentMedications || [];
        profile.currentMedications.push(record);
        break;
      }

      case 'condition': {
        record = {
          condition: data.condition ? String(data.condition).trim() : '',
          diagnosedDate: safeDate(data.diagnosedDate),
          currentStatus: data.currentStatus,
          managingDoctor: data.managingDoctor,
          lastCheckup: safeDate(data.lastCheckup),
          notes: data.notes,
          addedAt: new Date()
        };
        profile.chronicConditions = profile.chronicConditions || [];
        profile.chronicConditions.push(record);
        break;
      }

      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid recordType. Must be: medicalHistory, allergy, medication, condition'
        });
    }

    await profile.save();

    return res.json({
      success: true,
      message: 'Medical record added successfully',
      recordType,
      record
    });
  } catch (error) {
    console.error('Error adding medical record:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

// ✅ Everything below can mostly stay the same because it uses patientId = profile._id,
// but I cleaned a couple of inconsistent names.

// GET /patient/appointments
exports.getAppointments = async (req, res) => {
  try {
    const {
      status,
      type,
      professionalType,
      startDate,
      endDate,
      page = 1,
      limit = 20
    } = req.query;

    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const filter = { patientId: profile._id };
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (professionalType) filter.professionalType = professionalType;

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.appointmentDate = { $gte: start, $lte: end };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const appointments = await Appointment.find(filter)
      .populate('doctorId', 'name specialization consultationFee clinicAddress')
      .populate('physioId', 'name services consultationFee clinicAddress')
      .populate('referralId', 'requirement symptoms')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Appointment.countDocuments(filter);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcomingAppointments = await Appointment.find({
      patientId: profile._id,
      appointmentDate: { $gte: today },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    })
      .populate('doctorId', 'name specialization')
      .populate('physioId', 'name services')
      .sort({ appointmentDate: 1 })
      .limit(5);

    const stats = await Appointment.aggregate([
      { $match: { patientId: profile._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    return res.json({
      success: true,
      appointments,
      upcomingAppointments,
      stats: stats.reduce((acc, s) => {
        acc[s._id] = s.count;
        return acc;
      }, {}),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching appointments:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch appointments' });
  }
};

// GET /patient/prescriptions
exports.getPrescriptions = async (req, res) => {
  try {
    const { status, recent = false, page = 1, limit = 20 } = req.query;

    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const filter = { patientId: profile._id };
    if (status) filter.pharmacyStatus = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = Prescription.find(filter)
      .populate('doctorId', 'name specialization clinicAddress')
      .populate('physioId', 'name services clinicAddress')
      .populate('appointmentId', 'appointmentDate type')
      .sort({ issuedAt: -1 })
      .skip(skip);

    query = query.limit(recent ? 5 : parseInt(limit));

    const prescriptions = await query;
    const total = await Prescription.countDocuments(filter);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const activePrescriptions = await Prescription.countDocuments({
      patientId: profile._id,
      issuedAt: { $gte: thirtyDaysAgo },
      pharmacyStatus: { $in: ['not_dispensed', 'partially_dispensed'] }
    });

    return res.json({
      success: true,
      prescriptions,
      stats: {
        total,
        activePrescriptions,
        lastPrescriptionDate: prescriptions[0]?.issuedAt || null
      },
      pagination: recent
        ? null
        : { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('Error fetching prescriptions:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch prescriptions' });
  }
};

// GET /patient/lab-reports
exports.getLabReports = async (req, res) => {
  try {
    const { status, pathologyId, startDate, endDate, page = 1, limit = 20 } = req.query;

    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const filter = { patientId: profile._id };
    if (status) filter.status = status;
    if (pathologyId) filter.pathologyId = pathologyId;

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.scheduledDate = { $gte: start, $lte: end };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const labTests = await LabTest.find(filter)
      .populate('pathologyId', 'labName address phone')
      .populate('doctorId', 'name specialization')
      .populate('appointmentId', 'appointmentDate')
      .sort({ scheduledDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await LabTest.countDocuments(filter);

    const pendingTests = await LabTest.countDocuments({
      patientId: profile._id,
      status: { $in: ['requested', 'scheduled', 'sample_collected', 'processing'] }
    });

    return res.json({
      success: true,
      labTests,
      stats: { total, pendingTests, completedTests: total - pendingTests },
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('Error fetching lab reports:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch lab reports' });
  }
};

// GET /patient/invoices
exports.getInvoices = async (req, res) => {
  try {
    const { status, type, startDate, endDate, page = 1, limit = 20 } = req.query;

    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const filter = { patientId: profile._id };
    if (status) filter.status = status;
    if (type) filter.invoiceType = type;

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.invoiceDate = { $gte: start, $lte: end };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const invoices = await Invoice.find(filter)
      .populate('appointmentId', 'appointmentDate')
      .populate('pharmacySaleId', 'saleNumber')
      .populate('labTestId', 'testName')
      .sort({ invoiceDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Invoice.countDocuments(filter);

    const financialSummary = await Invoice.aggregate([
      { $match: { patientId: profile._id } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$totalAmount' },
          totalPaid: { $sum: '$amountPaid' },
          totalDue: { $sum: '$balanceDue' },
          totalInvoices: { $sum: 1 },
          paidInvoices: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
          pendingInvoices: {
            $sum: { $cond: [{ $in: ['$status', ['sent', 'partial', 'overdue']] }, 1, 0] }
          }
        }
      }
    ]);

    const recentPayments = await Invoice.find({
      patientId: profile._id,
      status: 'paid'
    })
      .sort({ paidAt: -1 })
      .limit(5)
      .select('invoiceNumber totalAmount paidAt paymentMethod');

    return res.json({
      success: true,
      invoices,
      financialSummary: financialSummary[0] || {
        totalAmount: 0,
        totalPaid: 0,
        totalDue: 0,
        totalInvoices: 0,
        paidInvoices: 0,
        pendingInvoices: 0
      },
      recentPayments,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('Error fetching invoices:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch invoices' });
  }
};

// GET /patient/dashboard
exports.getDashboardStats = async (req, res) => {
  try {
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    const appointmentStats = await Appointment.aggregate([
      { $match: { patientId: profile._id, createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: null,
          totalAppointments: { $sum: 1 },
          completedAppointments: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          upcomingAppointments: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'confirmed', 'accepted']] }, 1, 0] }
          }
        }
      }
    ]);

    const prescriptionStats = await Prescription.aggregate([
      { $match: { patientId: profile._id, issuedAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: null,
          totalPrescriptions: { $sum: 1 },
          activePrescriptions: {
            $sum: { $cond: [{ $in: ['$pharmacyStatus', ['not_dispensed', 'partially_dispensed']] }, 1, 0] }
          }
        }
      }
    ]);

    const labTestStats = await LabTest.aggregate([
      { $match: { patientId: profile._id, createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: null,
          totalLabTests: { $sum: 1 },
          pendingTests: {
            $sum: { $cond: [{ $in: ['$status', ['requested', 'scheduled', 'sample_collected', 'processing']] }, 1, 0] }
          }
        }
      }
    ]);

    const financialStats = await Invoice.aggregate([
      { $match: { patientId: profile._id, invoiceDate: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: null,
          totalSpent: { $sum: '$totalAmount' },
          pendingPayment: {
            $sum: { $cond: [{ $in: ['$status', ['sent', 'partial', 'overdue']] }, '$balanceDue', 0] }
          }
        }
      }
    ]);

    const upcomingAppointments = await Appointment.find({
      patientId: profile._id,
      appointmentDate: { $gte: today },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    })
      .populate('doctorId', 'name specialization')
      .populate('physioId', 'name services')
      .sort({ appointmentDate: 1 })
      .limit(5);

    const recentPrescriptions = await Prescription.find({ patientId: profile._id })
      .populate('doctorId', 'name specialization')
      .sort({ issuedAt: -1 })
      .limit(3);

    const healthSummary = {
      age: profile.age,
      bloodGroup: profile.bloodGroup,
      bmi: profile.bmi,
      chronicConditions: profile.chronicConditions?.length || 0,
      allergies: profile.allergies?.length || 0,
      lastConsultation: profile.lastConsultation
    };

    return res.json({
      success: true,
      stats: {
        appointments: appointmentStats[0] || { totalAppointments: 0, completedAppointments: 0, upcomingAppointments: 0 },
        prescriptions: prescriptionStats[0] || { totalPrescriptions: 0, activePrescriptions: 0 },
        labTests: labTestStats[0] || { totalLabTests: 0, pendingTests: 0 },
        financial: financialStats[0] || { totalSpent: 0, pendingPayment: 0 }
      },
      upcomingAppointments,
      recentPrescriptions,
      healthSummary,
      profile: {
        name: profile.name,
        patientId: profile.patientId,
        registeredAt: profile.registeredAt
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
  }
};

// NOTE: Your bookAppointment() uses Appointment schema fields like timeSlot.
// In your other code you were using startTime/endTime. I didn't change this,
// because I don't have your Appointment schema here. If you paste it, I’ll align it too.
exports.bookAppointment = async (req, res) => {
  try {
    const { doctorId, physioId, appointmentDate, timeSlot, type, symptoms, notes } = req.body;

    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    if (!appointmentDate || !timeSlot || !type) {
      return res.status(400).json({
        success: false,
        error: 'Appointment date, time slot, and type are required'
      });
    }

    if (!doctorId && !physioId) {
      return res.status(400).json({
        success: false,
        error: 'Either doctor or physiotherapist must be selected'
      });
    }

    // Generate appointmentId (kept same as your logic)
    const lastAppointment = await Appointment.findOne().sort({ appointmentId: -1 });
    let appointmentIdNumber = 1;
    if (lastAppointment?.appointmentId) {
      const lastId = parseInt(String(lastAppointment.appointmentId).replace('APT', ''), 10);
      appointmentIdNumber = Number.isNaN(lastId) ? 1 : lastId + 1;
    }
    const appointmentId = `APT${String(appointmentIdNumber).padStart(5, '0')}`;

    const appointment = await Appointment.create({
      appointmentId,
      patientId: profile._id,
      doctorId: doctorId || null,
      physioId: physioId || null,
      professionalType: doctorId ? 'doctor' : 'physio',
      appointmentDate: new Date(appointmentDate),
      timeSlot,
      type,
      symptoms,
      notes,
      status: 'pending',
      bookedBy: req.user.id
    });

    return res.status(201).json({
      success: true,
      message: 'Appointment booked successfully',
      appointment
    });
  } catch (error) {
    console.error('Error booking appointment:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};
