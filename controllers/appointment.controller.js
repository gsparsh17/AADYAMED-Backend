const Appointment = require('../models/Appointment');
const Referral = require('../models/Referral');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const Commission = require('../models/Commission');
const CommissionSettings = require('../models/CommissionSettings');
const Notification = require('../models/Notification');
const Calendar = require('../models/Calendar');
const Invoice = require('../models/Invoice');

// ========== APPOINTMENT FUNCTIONS ==========

// Create a new appointment
exports.createAppointment = async (req, res) => {
  try {
    const {
      referralId,
      professionalId,
      professionalType,
      appointmentDate,
      startTime,
      type = 'clinic',
      address,
      symptoms,
      reason
    } = req.body;

    // Validate required fields
    if (!professionalId || !professionalType || !appointmentDate || !startTime) {
      return res.status(400).json({
        success: false,
        error: 'Professional ID, professional type, appointment date, and start time are required'
      });
    }

    // Get patient profile ID
    const patientProfile = await PatientProfile.findOne({ userId: req.user.id });
    if (!patientProfile) {
      return res.status(404).json({
        success: false,
        error: 'Patient profile not found. Please complete your profile first.'
      });
    }

    const patientId = patientProfile._id;

    // Validate professional type
    if (!['doctor', 'physiotherapist'].includes(professionalType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid professional type. Must be "doctor" or "physiotherapist"'
      });
    }

    // Get professional details and validate
    let professional;
    let consultationFee;

    if (professionalType === 'doctor') {
      professional = await DoctorProfile.findById(professionalId)
        .populate('userId', 'isVerified isActive');
      if (!professional) {
        return res.status(404).json({
          success: false,
          error: 'Doctor not found'
        });
      }

      // Check if doctor is verified and active
      if (!professional.userId?.isVerified || !professional.userId?.isActive) {
        return res.status(400).json({
          success: false,
          error: 'Doctor is not available for appointments'
        });
      }

      consultationFee = professional.consultationFee || 0;
      if (type === 'home') {
        consultationFee += (professional.homeVisitFee || 0);
      }
    } else {
      professional = await PhysiotherapistProfile.findById(professionalId)
        .populate('userId', 'isVerified isActive');
      if (!professional) {
        return res.status(404).json({
          success: false,
          error: 'Physiotherapist not found'
        });
      }

      // Check if physio is verified and active
      if (!professional.userId?.isVerified || !professional.userId?.isActive) {
        return res.status(400).json({
          success: false,
          error: 'Physiotherapist is not available for appointments'
        });
      }

      // Get appropriate fee
      if (type === 'home') {
        consultationFee = professional.homeVisitFee || 0;
      } else {
        consultationFee = professional.consultationFee || 0;
      }
    }

    // Validate referral if provided
    if (referralId) {
      const referral = await Referral.findOne({
        _id: referralId,
        patientId: patientId
      });

      if (!referral) {
        return res.status(404).json({
          success: false,
          error: 'Referral not found or does not belong to you'
        });
      }

      if (referral.status !== 'professional_selected') {
        return res.status(400).json({
          success: false,
          error: 'Referral is not in valid state for appointment booking'
        });
      }
    }

    // Validate appointment date
    const appointmentDateTime = new Date(appointmentDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (appointmentDateTime < today) {
      return res.status(400).json({
        success: false,
        error: 'Appointment date cannot be in the past'
      });
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(startTime)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid time format. Use HH:MM (24-hour format)'
      });
    }

    // Check availability
    const isAvailable = await checkAvailability(
      professionalId,
      professionalType,
      appointmentDate,
      startTime
    );

    if (!isAvailable) {
      return res.status(400).json({
        success: false,
        error: 'Selected time slot is not available'
      });
    }

    // Get commission settings
    const settings = await CommissionSettings.findOne();
    if (!settings) {
      return res.status(500).json({
        success: false,
        error: 'Commission settings not configured'
      });
    }

    const commissionRate = professionalType === 'doctor'
      ? (professional.commissionRate || settings.defaultDoctorCommission)
      : (professional.commissionRate || settings.defaultPhysioCommission);

    const platformCommission = Math.round((consultationFee * commissionRate) / 100);
    const professionalEarning = consultationFee - platformCommission;

    // Determine appointment duration
    const duration = professionalType === 'doctor' ? 30 : 60; // Default 30 mins for doctor, 60 for physio

    // Create appointment
    const appointment = await Appointment.create({
      referralId,
      patientId,
      [professionalType === 'doctor' ? 'doctorId' : 'physioId']: professionalId,
      professionalType,
      appointmentDate: appointmentDateTime,
      startTime,
      duration,
      type,
      address: type === 'home' ? address : undefined,
      symptoms: symptoms || [],
      reason: reason || '',
      consultationFee,
      platformCommission,
      professionalEarning,
      totalAmount: consultationFee,
      status: 'pending',
      paymentStatus: 'pending',
      createdBy: req.user.id,
      patientNotes: req.body.patientNotes
    });

    // Update referral status if applicable
    if (referralId) {
      await Referral.findByIdAndUpdate(referralId, {
        appointmentId: appointment._id,
        status: 'appointment_booked',
        selectedProfessional: {
          professionalId,
          professionalType,
          consultationFee
        }
      });
    }

    // Create commission record
    const professionalModel =
      professionalType === 'doctor'
        ? 'DoctorProfile'
        : professionalType === 'physiotherapist'
          ? 'PhysiotherapistProfile'
          : 'PathologyProfile';

    await Commission.create({
      appointmentId: appointment._id,
      professionalId,
      professionalModel,           // ✅ add this
      professionalType,            // keep existing
      patientId,
      consultationFee,
      platformCommission,
      professionalEarning,
      commissionRate,
      payoutStatus: 'pending',
      commissionCycle: {
        month: new Date().getUTCMonth() + 1,
        year: new Date().getUTCFullYear(),
        cycleNumber: `${String(new Date().getUTCMonth() + 1).padStart(2, '0')}${new Date().getUTCFullYear()}`
      },
      createdBy: req.user.id
    });


    // Update calendar
    await updateCalendarForAppointment(appointment);

    // Send notifications
    await sendAppointmentNotifications(appointment, professional, patientProfile);

    res.status(201).json({
      success: true,
      message: 'Appointment created successfully',
      appointment,
      paymentRequired: consultationFee > 0
    });
  } catch (error) {
    console.error('Error creating appointment:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get appointments (role-based)
exports.getAppointments = async (req, res) => {
  try {
    const {
      status,
      type,
      startDate,
      endDate,
      professionalType,
      page = 1,
      limit = 20
    } = req.query;

    const filter = {};

    // Role-based filtering
    switch (req.user.role) {
      case 'patient':
        // Get patient profile ID
        const patientProfile = await PatientProfile.findOne({ userId: req.user.id });
        if (!patientProfile) {
          return res.status(404).json({
            success: false,
            error: 'Patient profile not found'
          });
        }
        filter.patientId = patientProfile._id;
        break;

      case 'doctor':
        // Get doctor profile ID
        const doctorProfile = await DoctorProfile.findOne({ userId: req.user.id });
        if (!doctorProfile) {
          return res.status(404).json({
            success: false,
            error: 'Doctor profile not found'
          });
        }
        filter.doctorId = doctorProfile._id;
        filter.professionalType = 'doctor';
        break;

      case 'physio':
        // Get physio profile ID
        const physioProfile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
        if (!physioProfile) {
          return res.status(404).json({
            success: false,
            error: 'Physiotherapist profile not found'
          });
        }
        filter.physioId = physioProfile._id;
        filter.professionalType = 'physiotherapist';
        break;

      case 'admin':
        // Admin can see all
        break;

      default:
        return res.status(403).json({
          success: false,
          error: 'Unauthorized to view appointments'
        });
    }

    // Apply filters
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (professionalType) filter.professionalType = professionalType;
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      filter.appointmentDate = {
        $gte: start,
        $lte: end
      };
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Base query
    let query = Appointment.find(filter)
      .sort({ appointmentDate: 1, startTime: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Populate based on role
    if (req.user.role === 'patient') {
      query = query
        .populate('doctorId', 'name specialization consultationFee clinicAddress')
        .populate('physioId', 'name services consultationFee clinicAddress');
    } else if (req.user.role === 'doctor' || req.user.role === 'physio' || req.user.role === 'admin') {
      query = query.populate('patientId', 'name phone age gender');
    }

    const appointments = await query;

    const total = await Appointment.countDocuments(filter);

    // Get stats for dashboard
    let stats = {};
    if (req.user.role === 'patient' || req.user.role === 'admin') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      stats = {
        upcoming: await Appointment.countDocuments({
          ...filter,
          appointmentDate: { $gte: today },
          status: { $in: ['pending', 'confirmed', 'accepted'] }
        }),
        completed: await Appointment.countDocuments({
          ...filter,
          status: 'completed'
        }),
        cancelled: await Appointment.countDocuments({
          ...filter,
          status: 'cancelled'
        })
      };
    }

    res.json({
      success: true,
      appointments,
      stats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching appointments:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointments'
    });
  }
};

// Get appointment by ID
exports.getAppointmentById = async (req, res) => {
  try {
    const { id } = req.params;

    const appointment = await Appointment.findById(id)
      .populate('patientId', 'name phone age gender bloodGroup address')
      // .populate('doctorId', 'name specialization qualifications consultationFee homeVisitFee clinicAddress')
      // .populate('physioId', 'name services consultationFee homeVisitFee clinicAddress')
      .populate('referralId', 'requirement symptoms')
      .populate('prescriptionId', 'diagnosis medicines exercises instructions');

    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    // Authorization check
    const isAuthorized = await canViewAppointment(req.user, appointment);
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to view this appointment'
      });
    }

    // Get related data
    let invoice = null;
    if (appointment.paymentStatus === 'paid' || appointment.status === 'completed') {
      invoice = await Invoice.findOne({ appointmentId: appointment._id });
    }

    res.json({
      success: true,
      appointment: {
        ...appointment.toObject(),
        invoice
      }
    });
  } catch (error) {
    console.error('Error fetching appointment:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointment'
    });
  }
};

// Update appointment status
exports.updateAppointmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, cancellationReason, notes } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Status is required'
      });
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    // Authorization check
    const canUpdate = await canUpdateStatus(req.user, appointment, status);
    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this appointment'
      });
    }

    // Validate status transition
    if (!isValidStatusTransition(appointment.status, status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot change status from ${appointment.status} to ${status}`
      });
    }

    const oldStatus = appointment.status;
    appointment.status = status;

    // Handle specific status updates
    if (status === 'cancelled') {
      appointment.cancellationReason = cancellationReason;
      appointment.cancelledBy = req.user.role;
      appointment.cancelledAt = new Date();

      // Calculate cancellation fee
      appointment.cancellationFee = calculateCancellationFee(appointment);

      // Update calendar
      await updateCalendarForCancellation(appointment);
    }

    if (status === 'accepted' || status === 'rejected') {
      appointment.respondedBy = req.user.role;
      appointment.respondedAt = new Date();

      if (status === 'accepted') {
        appointment.status = 'confirmed'; // Change accepted to confirmed
      }
    }

    if (status === 'completed') {
      appointment.actualEndTime = new Date();

      // Update professional stats
      await updateProfessionalStats(appointment);

      // Create invoice
      await createInvoiceForAppointment(appointment);
    }

    if (notes) {
      appointment.notes = appointment.notes || [];
      appointment.notes.push({
        note: notes,
        addedBy: req.user.role,
        addedAt: new Date()
      });
    }

    await appointment.save();

    // Send notification
    await sendStatusUpdateNotification(appointment, oldStatus, appointment.status);

    res.json({
      success: true,
      message: `Appointment ${appointment.status} successfully`,
      appointment
    });
  } catch (error) {
    console.error('Error updating appointment status:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Cancel appointment
exports.cancelAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    // Check if appointment can be cancelled
    if (appointment.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'Appointment is already cancelled'
      });
    }

    if (appointment.status === 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel completed appointment'
      });
    }

    // Check authorization
    let canCancel = false;

    if (req.user.role === 'patient') {
      const patientProfile = await PatientProfile.findOne({ userId: req.user.id });
      canCancel = patientProfile && appointment.patientId.toString() === patientProfile._id.toString();
    } else if (req.user.role === 'doctor' || req.user.role === 'physio') {
      const professionalProfile = req.user.role === 'doctor'
        ? await DoctorProfile.findOne({ userId: req.user.id })
        : await PhysiotherapistProfile.findOne({ userId: req.user.id });

      if (professionalProfile) {
        const professionalField = req.user.role === 'doctor' ? 'doctorId' : 'physioId';
        canCancel = appointment[professionalField]?.toString() === professionalProfile._id.toString();
      }
    } else if (req.user.role === 'admin') {
      canCancel = true;
    }

    if (!canCancel) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to cancel this appointment'
      });
    }

    // Calculate cancellation time difference
    const appointmentTime = new Date(appointment.appointmentDate);
    const startTimeParts = appointment.startTime.split(':');
    appointmentTime.setHours(parseInt(startTimeParts[0]), parseInt(startTimeParts[1]), 0, 0);

    const now = new Date();
    const hoursDiff = (appointmentTime - now) / (1000 * 60 * 60);

    if (hoursDiff < 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel past appointment'
      });
    }

    // Update appointment
    appointment.status = 'cancelled';
    appointment.cancellationReason = reason || 'Cancelled by user';
    appointment.cancelledBy = req.user.role;
    appointment.cancelledAt = new Date();
    appointment.cancellationFee = calculateCancellationFee(appointment);

    await appointment.save();

    // Update calendar
    await updateCalendarForCancellation(appointment);

    // Send notification
    await sendCancellationNotification(appointment);

    res.json({
      success: true,
      message: 'Appointment cancelled successfully',
      appointment,
      cancellationFee: appointment.cancellationFee,
      refundAmount: appointment.totalAmount - appointment.cancellationFee
    });
  } catch (error) {
    console.error('Error cancelling appointment:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Reschedule appointment
exports.rescheduleAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const { newDate, newTime, reason } = req.body;

    if (!newDate || !newTime) {
      return res.status(400).json({
        success: false,
        error: 'New date and time are required'
      });
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    // Check if appointment can be rescheduled
    if (appointment.status === 'cancelled' || appointment.status === 'completed') {
      return res.status(400).json({
        success: false,
        error: `Cannot reschedule ${appointment.status} appointment`
      });
    }

    if (appointment.rescheduleCount >= 2) {
      return res.status(400).json({
        success: false,
        error: 'Maximum reschedule limit reached'
      });
    }

    // Check authorization (only patient can reschedule)
    if (req.user.role !== 'patient') {
      return res.status(403).json({
        success: false,
        error: 'Only patients can reschedule appointments'
      });
    }

    const patientProfile = await PatientProfile.findOne({ userId: req.user.id });
    if (!patientProfile || appointment.patientId.toString() !== patientProfile._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to reschedule this appointment'
      });
    }

    // Validate new date and time
    const newDateTime = new Date(newDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (newDateTime < today) {
      return res.status(400).json({
        success: false,
        error: 'New appointment date cannot be in the past'
      });
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(newTime)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid time format. Use HH:MM (24-hour format)'
      });
    }

    // Check availability for new slot
    const professionalId = appointment.professionalType === 'doctor'
      ? appointment.doctorId
      : appointment.physioId;

    const isAvailable = await checkAvailability(
      professionalId,
      appointment.professionalType,
      newDate,
      newTime
    );

    if (!isAvailable) {
      return res.status(400).json({
        success: false,
        error: 'Selected time slot is not available'
      });
    }

    // Store previous appointment details
    const previousAppointment = {
      originalDate: appointment.appointmentDate,
      originalTime: appointment.startTime,
      rescheduledDate: new Date(),
      reason: reason || 'Rescheduled by patient'
    };

    appointment.previousAppointments = appointment.previousAppointments || [];
    appointment.previousAppointments.push(previousAppointment);

    // Update appointment
    const oldDate = appointment.appointmentDate;
    const oldTime = appointment.startTime;

    appointment.appointmentDate = newDateTime;
    appointment.startTime = newTime;
    appointment.rescheduleCount += 1;
    appointment.rescheduleReason = reason;
    appointment.status = 'rescheduled';

    await appointment.save();

    // Update calendar
    await updateCalendarForReschedule(appointment, oldDate, oldTime);

    // Send notification
    await sendRescheduleNotification(appointment, oldDate, oldTime);

    res.json({
      success: true,
      message: 'Appointment rescheduled successfully',
      appointment,
      rescheduleCount: appointment.rescheduleCount
    });
  } catch (error) {
    console.error('Error rescheduling appointment:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Complete appointment
exports.completeAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, followupRequired, followupDate } = req.body;

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    // Check if appointment can be completed
    if (appointment.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'Cannot complete cancelled appointment'
      });
    }

    if (appointment.status === 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Appointment is already completed'
      });
    }

    // Check authorization (only professional can complete)
    let canComplete = false;
    let professionalProfile = null;

    if (req.user.role === 'doctor' || req.user.role === 'physio') {
      professionalProfile = req.user.role === 'doctor'
        ? await DoctorProfile.findOne({ userId: req.user.id })
        : await PhysiotherapistProfile.findOne({ userId: req.user.id });

      if (professionalProfile) {
        const professionalField = req.user.role === 'doctor' ? 'doctorId' : 'physioId';
        canComplete = appointment[professionalField]?.toString() === professionalProfile._id.toString();
      }
    } else if (req.user.role === 'admin') {
      canComplete = true;
    }

    if (!canComplete) {
      return res.status(403).json({
        success: false,
        error: 'Only the assigned professional can complete this appointment'
      });
    }

    // Update appointment
    appointment.status = 'completed';
    appointment.actualEndTime = new Date();
    appointment.professionalNotes = notes;
    appointment.followupRequired = followupRequired || false;

    if (followupRequired && followupDate) {
      appointment.followupDate = new Date(followupDate);
    }

    await appointment.save();

    // Update professional stats
    await updateProfessionalStats(appointment);

    // Create invoice
    await createInvoiceForAppointment(appointment);

    // Send notification
    await sendCompletionNotification(appointment);

    res.json({
      success: true,
      message: 'Appointment completed successfully',
      appointment,
      invoiceGenerated: appointment.paymentStatus === 'paid'
    });
  } catch (error) {
    console.error('Error completing appointment:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// ========== HELPER FUNCTIONS ==========

// Check availability for appointment slot
async function checkAvailability(professionalId, professionalType, date, time) {
  try {
    const appointmentDate = new Date(date);
    const appointments = await Appointment.find({
      [professionalType === 'doctor' ? 'doctorId' : 'physioId']: professionalId,
      appointmentDate: {
        $gte: new Date(appointmentDate.setHours(0, 0, 0, 0)),
        $lt: new Date(appointmentDate.setHours(23, 59, 59, 999))
      },
      startTime: time,
      status: { $in: ['pending', 'confirmed', 'accepted', 'in_progress'] }
    });

    return appointments.length === 0;
  } catch (error) {
    console.error('Error checking availability:', error);
    return false;
  }
}

async function canViewAppointment(user, appointment) {
  if (user.role === 'admin') return true;

  if (user.role === 'patient') {
    const patientProfile = await PatientProfile.findOne({ userId: user.id });
    return patientProfile && appointment.patientId.toString() === patientProfile._id.toString();
  }

  if (user.role === 'doctor') {
    const doctorProfile = await DoctorProfile.findOne({ userId: user.id });
    return doctorProfile && appointment.doctorId?.toString() === doctorProfile._id.toString();
  }

  if (user.role === 'physio') {
    const physioProfile = await PhysiotherapistProfile.findOne({ userId: user.id });
    return physioProfile && appointment.physioId?.toString() === physioProfile._id.toString();
  }

  return false;
}

// Check if user can update appointment status
async function canUpdateStatus(user, appointment, newStatus) {
  if (user.role === 'admin') return true;

  if (user.role === 'patient') {
    const patientProfile = await PatientProfile.findOne({ userId: user.id });
    if (!patientProfile || appointment.patientId.toString() !== patientProfile._id.toString()) {
      return false;
    }

    // Patients can only cancel or reschedule their own appointments
    return ['cancelled', 'rescheduled'].includes(newStatus);
  }

  if (user.role === 'doctor') {
    const doctorProfile = await DoctorProfile.findOne({ userId: user.id });
    if (!doctorProfile || appointment.doctorId?.toString() !== doctorProfile._id.toString()) {
      return false;
    }

    // Doctors can accept, reject, complete, or cancel appointments
    return ['accepted', 'rejected', 'completed', 'cancelled', 'in_progress'].includes(newStatus);
  }

  if (user.role === 'physio') {
    const physioProfile = await PhysiotherapistProfile.findOne({ userId: user.id });
    if (!physioProfile || appointment.physioId?.toString() !== physioProfile._id.toString()) {
      return false;
    }

    // Physios can accept, reject, complete, or cancel appointments
    return ['accepted', 'rejected', 'completed', 'cancelled', 'in_progress'].includes(newStatus);
  }

  return false;
}

// Validate status transition
function isValidStatusTransition(oldStatus, newStatus) {
  const validTransitions = {
    'pending': ['accepted', 'rejected', 'cancelled'],
    'accepted': ['confirmed', 'cancelled'],
    'confirmed': ['in_progress', 'completed', 'cancelled'],
    'in_progress': ['completed', 'cancelled'],
    'completed': [], // Cannot change from completed
    'cancelled': [], // Cannot change from cancelled
    'rejected': [], // Cannot change from rejected
    'rescheduled': ['confirmed', 'cancelled']
  };

  return validTransitions[oldStatus]?.includes(newStatus) || false;
}

// Calculate cancellation fee
function calculateCancellationFee(appointment) {
  if (appointment.status === 'completed') return 0;

  const now = new Date();
  const appointmentTime = new Date(appointment.appointmentDate);
  const startTimeParts = appointment.startTime.split(':');
  appointmentTime.setHours(parseInt(startTimeParts[0]), parseInt(startTimeParts[1]), 0, 0);

  const hoursDiff = (appointmentTime - now) / (1000 * 60 * 60);

  // Get cancellation policy
  // Default policy: 0% if >24h, 25% if 12-24h, 50% if 6-12h, 75% if 2-6h, 100% if <2h
  if (hoursDiff > 24) return 0;
  if (hoursDiff > 12) return appointment.consultationFee * 0.25;
  if (hoursDiff > 6) return appointment.consultationFee * 0.50;
  if (hoursDiff > 2) return appointment.consultationFee * 0.75;
  return appointment.consultationFee; // No show or less than 2 hours
}

// Update professional stats after appointment completion
async function updateProfessionalStats(appointment) {
  try {
    const updateFields = {
      $inc: {
        totalConsultations: 1,
        totalEarnings: appointment.professionalEarning,
        pendingCommission: appointment.platformCommission
      }
    };

    if (appointment.professionalType === 'doctor') {
      await DoctorProfile.findByIdAndUpdate(appointment.doctorId, updateFields);
    } else {
      await PhysiotherapistProfile.findByIdAndUpdate(appointment.physioId, updateFields);
    }
  } catch (error) {
    console.error('Error updating professional stats:', error);
  }
}

// Create invoice for completed appointment
async function createInvoiceForAppointment(appointment) {
  try {
    // Check if invoice already exists
    const existingInvoice = await Invoice.findOne({ appointmentId: appointment._id });
    if (existingInvoice) return existingInvoice;

    const invoice = await Invoice.create({
      invoiceType: 'appointment',
      appointmentId: appointment._id,
      patientId: appointment.patientId,
      items: [{
        description: `${appointment.professionalType === 'doctor' ? 'Doctor' : 'Physiotherapist'} Consultation`,
        quantity: 1,
        unitPrice: appointment.consultationFee,
        amount: appointment.consultationFee
      }],
      subtotal: appointment.consultationFee,
      tax: 0,
      totalAmount: appointment.consultationFee,
      amountPaid: appointment.consultationFee, // Assuming paid on booking
      balanceDue: 0,
      status: 'paid',
      paymentMethod: 'online',
      commissionIncluded: true,
      commissionAmount: appointment.platformCommission,
      professionalId: appointment.professionalType === 'doctor' ? appointment.doctorId : appointment.physioId,
      professionalType: appointment.professionalType
    });

    return invoice;
  } catch (error) {
    console.error('Error creating invoice:', error);
    return null;
  }
}

function utcYMD(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function calculateEndTime(startTime, durationMin) {
  const [h, m] = startTime.split(":").map(Number);
  const total = h * 60 + m + durationMin;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

async function updateCalendarForAppointment(appointment) {
  try {
    const apptDate = new Date(appointment.appointmentDate);

    const year = apptDate.getUTCFullYear();
    const month = apptDate.getUTCMonth() + 1;

    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await Calendar.create({ year, month, days: [] });
    }

    const apptKey = utcYMD(apptDate);

    // find day by UTC date (string compare), without ISO
    let day = calendar.days.find(d => utcYMD(new Date(d.date)) === apptKey);

    if (!day) {
      // store day.date at UTC midnight to normalize matching
      const midnightUTC = new Date(Date.UTC(
        apptDate.getUTCFullYear(),
        apptDate.getUTCMonth(),
        apptDate.getUTCDate(),
        0, 0, 0, 0
      ));

      const dayName = midnightUTC.toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "UTC"
      });

      day = {
        date: midnightUTC,
        dayName,
        isHoliday: false,
        professionals: []
      };

      calendar.days.push(day);
    }

    const professionalField = appointment.professionalType === "doctor" ? "doctorId" : "physioId";
    const professionalId = appointment[professionalField];

    let prof = day.professionals.find(p =>
      p.professionalId.toString() === professionalId.toString() &&
      p.professionalType === appointment.professionalType
    );

    if (!prof) {
      prof = {
        professionalId,
        professionalType: appointment.professionalType,
        bookedSlots: [],
        breaks: [],
        workingHours: [],   // keep if your schema expects it
        isAvailable: true
      };
      day.professionals.push(prof);
    }

    // Prevent duplicates if function runs twice
    const exists = prof.bookedSlots?.some(bs =>
      bs.appointmentId?.toString() === appointment._id.toString()
    );

    if (!exists) {
      prof.bookedSlots.push({
        appointmentId: appointment._id,
        patientId: appointment.patientId,
        startTime: appointment.startTime,
        endTime: appointment.endTime || calculateEndTime(appointment.startTime, appointment.duration),
        status: appointment.status
      });
    }

    await calendar.save();
    return true;
  } catch (err) {
    console.error("Error updating calendar:", err);
    return false;
  }
}



// Update calendar for cancelled appointment
async function updateCalendarForCancellation(appointment) {
  try {
    const appointmentDate = new Date(appointment.appointmentDate);
    const year = appointmentDate.getFullYear();
    const month = appointmentDate.getMonth() + 1;

    const calendar = await Calendar.findOne({ year, month });
    if (!calendar) return;

    const dateStr = appointmentDate.toISOString().split('T')[0];

    const day = calendar.days.find(d => {
      const dDate = new Date(d.date);
      const dStr = dDate.toISOString().split('T')[0];
      return dStr === dateStr;
    });

    if (!day) return;

    const professionalField = appointment.professionalType === 'doctor' ? 'doctorId' : 'physioId';
    const professionalId = appointment[professionalField];

    const professional = day.professionals.find(
      p => p.professionalId.toString() === professionalId.toString() &&
        p.professionalType === appointment.professionalType
    );

    if (!professional) return;

    // Remove the booked slot
    professional.bookedSlots = professional.bookedSlots.filter(
      slot => slot.appointmentId.toString() !== appointment._id.toString()
    );

    await calendar.save();
  } catch (error) {
    console.error('Error updating calendar for cancellation:', error);
  }
}

// Update calendar for rescheduled appointment
async function updateCalendarForReschedule(appointment, oldDate, oldTime) {
  try {
    // Remove from old slot
    await updateCalendarForCancellation({
      ...appointment.toObject(),
      appointmentDate: oldDate,
      startTime: oldTime
    });

    // Add to new slot
    await updateCalendarForAppointment(appointment);
  } catch (error) {
    console.error('Error updating calendar for reschedule:', error);
  }
}

// Send appointment notifications
async function sendAppointmentNotifications(appointment, professional, patientProfile) {
  try {
    const professionalUserId = professional?.userId?._id || professional?.userId;

    // Patient notification
    await Notification.create({
      userId: patientProfile.userId,
      userRole: 'patient', // ✅ REQUIRED
      title: 'Appointment Created',
      message: `Your appointment with ${professional.name} is scheduled for ${appointment.appointmentDate.toLocaleDateString()} at ${appointment.startTime}`,
      type: 'appointment',
      channels: ['in_app', 'email'],
      relatedEntity: 'Appointment',
      relatedEntityId: appointment._id
    });

    // Professional notification
    await Notification.create({
      userId: professionalUserId,
      userRole: appointment.professionalType, // ✅ 'doctor' or 'physiotherapist'
      title: 'New Appointment Request',
      message: `New appointment request from ${patientProfile.name} for ${appointment.appointmentDate.toLocaleDateString()} at ${appointment.startTime}`,
      type: 'appointment',
      channels: ['in_app'],
      relatedEntity: 'Appointment',
      relatedEntityId: appointment._id
    });

  } catch (error) {
    console.error('Error sending notifications:', error);
  }
}


// Send status update notification
async function sendStatusUpdateNotification(appointment, oldStatus, newStatus) {
  try {
    const statusMessages = {
      'accepted': 'has been accepted',
      'rejected': 'has been rejected',
      'confirmed': 'has been confirmed',
      'in_progress': 'has started',
      'completed': 'has been completed',
      'cancelled': 'has been cancelled',
      'rescheduled': 'has been rescheduled'
    };

    const message = statusMessages[newStatus];
    if (!message) return;

    // Get patient user ID
    const patientProfile = await PatientProfile.findById(appointment.patientId);
    if (!patientProfile) return;

    await Notification.create({
      userId: patientProfile.userId,
      title: 'Appointment Status Update',
      message: `Your appointment ${message}`,
      type: 'appointment',
      channels: ['in_app'],
      relatedEntity: 'Appointment',
      relatedEntityId: appointment._id
    });

  } catch (error) {
    console.error('Error sending status update notification:', error);
  }
}

// Send cancellation notification
async function sendCancellationNotification(appointment) {
  try {
    // Get professional user ID
    let professionalUserId = null;
    if (appointment.professionalType === 'doctor') {
      const doctor = await DoctorProfile.findById(appointment.doctorId);
      professionalUserId = doctor?.userId;
    } else {
      const physio = await PhysiotherapistProfile.findById(appointment.physioId);
      professionalUserId = physio?.userId;
    }

    // Get patient user ID
    const patientProfile = await PatientProfile.findById(appointment.patientId);

    // Notify professional
    if (professionalUserId) {
      await Notification.create({
        userId: professionalUserId,
        title: 'Appointment Cancelled',
        message: `Appointment with ${patientProfile?.name || 'patient'} has been cancelled`,
        type: 'appointment',
        channels: ['in_app'],
        relatedEntity: 'Appointment',
        relatedEntityId: appointment._id
      });
    }

    // Notify patient
    if (patientProfile) {
      await Notification.create({
        userId: patientProfile.userId,
        title: 'Appointment Cancelled',
        message: `Your appointment has been cancelled. Refund amount: ₹${appointment.totalAmount - appointment.cancellationFee}`,
        type: 'appointment',
        channels: ['in_app', 'email'],
        relatedEntity: 'Appointment',
        relatedEntityId: appointment._id
      });
    }

  } catch (error) {
    console.error('Error sending cancellation notification:', error);
  }
}

// Send reschedule notification
async function sendRescheduleNotification(appointment, oldDate, oldTime) {
  try {
    // Get professional user ID
    let professionalUserId = null;
    if (appointment.professionalType === 'doctor') {
      const doctor = await DoctorProfile.findById(appointment.doctorId);
      professionalUserId = doctor?.userId;
    } else {
      const physio = await PhysiotherapistProfile.findById(appointment.physioId);
      professionalUserId = physio?.userId;
    }

    // Get patient user ID
    const patientProfile = await PatientProfile.findById(appointment.patientId);

    const newDateStr = appointment.appointmentDate.toLocaleDateString();

    // Notify professional
    if (professionalUserId) {
      await Notification.create({
        userId: professionalUserId,
        title: 'Appointment Rescheduled',
        message: `Appointment with ${patientProfile?.name || 'patient'} has been rescheduled to ${newDateStr} at ${appointment.startTime}`,
        type: 'appointment',
        channels: ['in_app'],
        relatedEntity: 'Appointment',
        relatedEntityId: appointment._id
      });
    }

  } catch (error) {
    console.error('Error sending reschedule notification:', error);
  }
}

// Send completion notification
async function sendCompletionNotification(appointment) {
  try {
    // Get patient user ID
    const patientProfile = await PatientProfile.findById(appointment.patientId);
    if (!patientProfile) return;

    await Notification.create({
      userId: patientProfile.userId,
      title: 'Appointment Completed',
      message: 'Your appointment has been completed. Prescription will be available shortly.',
      type: 'appointment',
      channels: ['in_app'],
      relatedEntity: 'Appointment',
      relatedEntityId: appointment._id
    });

  } catch (error) {
    console.error('Error sending completion notification:', error);
  }
}