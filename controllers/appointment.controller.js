const Appointment = require('../models/Appointment');
const Referral = require('../models/Referral');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const Commission = require('../models/Commission');
const CommissionSettings = require('../models/CommissionSettings');
const Notification = require('../models/Notification');

exports.createAppointment = async (req, res) => {
  try {
    const {
      referralId,
      professionalId,
      professionalType,
      appointmentDate,
      startTime,
      type,
      address,
      symptoms,
      reason
    } = req.body;
    
    const patientId = req.user.profileId;
    
    // Get professional details
    let professional;
    let consultationFee;
    
    if (professionalType === 'doctor') {
      professional = await DoctorProfile.findById(professionalId);
      consultationFee = professional.consultationFee;
      if (type === 'home') consultationFee += (professional.homeVisitFee || 0);
    } else {
      professional = await PhysiotherapistProfile.findById(professionalId);
      consultationFee = type === 'home' ? professional.homeVisitFee : professional.consultationFee;
    }
    
    if (!professional) {
      return res.status(404).json({ message: 'Professional not found' });
    }
    
    // Check availability
    const isAvailable = await checkAvailability(
      professionalId,
      professionalType,
      appointmentDate,
      startTime
    );
    
    if (!isAvailable) {
      return res.status(400).json({ message: 'Selected slot is not available' });
    }
    
    // Get commission settings
    const settings = await CommissionSettings.getSettings();
    const commissionRate = professionalType === 'doctor' 
      ? settings.defaultDoctorCommission 
      : settings.defaultPhysioCommission;
    
    const platformCommission = (consultationFee * commissionRate) / 100;
    const professionalEarning = consultationFee - platformCommission;
    
    // Create appointment
    const appointment = await Appointment.create({
      referralId,
      patientId,
      [professionalType === 'doctor' ? 'doctorId' : 'physioId']: professionalId,
      professionalType,
      appointmentDate,
      startTime,
      type,
      address: type === 'home' ? address : undefined,
      symptoms,
      reason,
      consultationFee,
      platformCommission,
      professionalEarning,
      totalAmount: consultationFee,
      duration: 30 // Default 30 minutes
    });
    
    // Update referral
    if (referralId) {
      await Referral.findByIdAndUpdate(referralId, {
        appointmentId: appointment._id,
        status: 'appointment_booked'
      });
    }
    
    // Create commission record
    await Commission.create({
      appointmentId: appointment._id,
      professionalId,
      professionalType,
      patientId,
      consultationFee,
      platformCommission,
      professionalEarning,
      commissionRate,
      commissionCycle: {
        month: new Date().getMonth() + 1,
        year: new Date().getFullYear(),
        cycleNumber: `${(new Date().getMonth() + 1).toString().padStart(2, '0')}${new Date().getFullYear()}`
      }
    });
    
    // Send notifications
    await sendAppointmentNotifications(appointment);
    
    res.status(201).json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAppointments = async (req, res) => {
  try {
    const { 
      status, 
      type, 
      startDate, 
      endDate,
      page = 1, 
      limit = 10 
    } = req.query;
    
    const filter = {};
    
    // Role-based filtering
    switch(req.user.role) {
      case 'patient':
        filter.patientId = req.user.profileId;
        break;
      case 'doctor':
        filter.doctorId = req.user.profileId;
        filter.professionalType = 'doctor';
        break;
      case 'physiotherapist':
        filter.physioId = req.user.profileId;
        filter.professionalType = 'physiotherapist';
        break;
      case 'admin':
        // Admin can see all
        break;
    }
    
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.appointmentDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const appointments = await Appointment.find(filter)
      .sort({ appointmentDate: 1, startTime: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('patientId', 'name phone')
      .populate('doctorId', 'name specialization')
      .populate('physioId', 'name specialization');
    
    const total = await Appointment.countDocuments(filter);
    
    res.json({
      success: true,
      appointments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateAppointmentStatus = async (req, res) => {
  try {
    const { status, cancellationReason, rescheduleDate, rescheduleTime } = req.body;
    
    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    
    // Authorization check
    if (!canUpdateStatus(req.user, appointment)) {
      return res.status(403).json({ message: 'Not authorized to update this appointment' });
    }
    
    const oldStatus = appointment.status;
    appointment.status = status;
    
    if (status === 'cancelled') {
      appointment.cancellationReason = cancellationReason;
      appointment.cancelledBy = req.user.role;
      
      // Apply cancellation fee based on timing
      appointment.cancellationFee = calculateCancellationFee(appointment);
    }
    
    if (status === 'rescheduled' && rescheduleDate && rescheduleTime) {
      appointment.rescheduleCount += 1;
      appointment.previousAppointments.push({
        appointmentId: appointment._id,
        date: appointment.appointmentDate,
        reason: 'Rescheduled by ' + req.user.role
      });
      appointment.appointmentDate = rescheduleDate;
      appointment.startTime = rescheduleTime;
    }
    
    if (status === 'completed') {
      appointment.actualEndTime = new Date();
    }
    
    await appointment.save();
    
    // Update professional stats
    await updateProfessionalStats(appointment);
    
    // Send notifications
    await sendStatusUpdateNotification(appointment, oldStatus, status);
    
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper functions
async function checkAvailability(professionalId, type, date, time) {
  const existingAppointments = await Appointment.find({
    [type === 'doctor' ? 'doctorId' : 'physioId']: professionalId,
    appointmentDate: date,
    startTime: time,
    status: { $in: ['confirmed', 'accepted', 'in_progress'] }
  });
  
  return existingAppointments.length === 0;
}

function canUpdateStatus(user, appointment) {
  if (user.role === 'admin') return true;
  
  if (user.role === 'patient' && appointment.patientId.toString() === user.profileId) {
    return ['cancelled', 'rescheduled'].includes(req.body.status);
  }
  
  if ((user.role === 'doctor' && appointment.doctorId?.toString() === user.profileId) ||
      (user.role === 'physiotherapist' && appointment.physioId?.toString() === user.profileId)) {
    return ['accepted', 'rejected', 'completed', 'in_progress', 'cancelled', 'rescheduled'].includes(req.body.status);
  }
  
  return false;
}

function calculateCancellationFee(appointment) {
  const now = new Date();
  const appointmentTime = new Date(appointment.appointmentDate);
  appointmentTime.setHours(parseInt(appointment.startTime.split(':')[0]));
  appointmentTime.setMinutes(parseInt(appointment.startTime.split(':')[1]));
  
  const hoursDiff = (appointmentTime - now) / (1000 * 60 * 60);
  
  if (hoursDiff > 24) return 0;
  if (hoursDiff > 12) return appointment.consultationFee * 0.25;
  if (hoursDiff > 6) return appointment.consultationFee * 0.50;
  if (hoursDiff > 2) return appointment.consultationFee * 0.75;
  return appointment.consultationFee; // No show or less than 2 hours
}

async function updateProfessionalStats(appointment) {
  if (appointment.status === 'completed') {
    const updateFields = {
      $inc: {
        totalConsultations: 1,
        totalEarnings: appointment.professionalEarning
      }
    };
    
    if (appointment.professionalType === 'doctor') {
      await DoctorProfile.findByIdAndUpdate(appointment.doctorId, updateFields);
    } else {
      await PhysiotherapistProfile.findByIdAndUpdate(appointment.physioId, updateFields);
    }
  }
}

async function sendAppointmentNotifications(appointment) {
  // Implementation for sending notifications
}