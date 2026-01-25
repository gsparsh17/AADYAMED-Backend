const DoctorProfile = require('../models/DoctorProfile');
const User = require('../models/User');
const Calendar = require('../models/Calendar');

// ========== PUBLIC FUNCTIONS ==========

// ✅ Create a new doctor (Admin only)
exports.createDoctor = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      specialization,
      qualifications,
      experienceYears,
      licenseNumber,
      consultationFee,
      homeVisitFee,
      clinicAddress,
      availability
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false,
        error: 'User with this email already exists. Please use a different email.' 
      });
    }

    // Create User first
    const newUser = await User.create({
      email,
      password: req.body.password || 'temporary123',
      role: 'doctor',
      phone
    });

    // Create DoctorProfile
    const newDoctor = await DoctorProfile.create({
      userId: newUser._id,
      name,
      email,
      phone,
      specialization: specialization || [],
      qualifications: qualifications || [],
      experienceYears: experienceYears || 0,
      licenseNumber,
      licenseDocument: req.body.licenseDocument,
      clinicAddress: {
        address: clinicAddress?.address || '',
        city: clinicAddress?.city || '',
        state: clinicAddress?.state || '',
        pincode: clinicAddress?.pincode || '',
        location: clinicAddress?.location || {
          type: 'Point',
          coordinates: [0, 0]
        }
      },
      consultationFee: consultationFee || 0,
      homeVisitFee: homeVisitFee || 0,
      availability: availability || [],
      about: req.body.about || '',
      services: req.body.services || [],
      languages: req.body.languages || ['English'],
      gender: req.body.gender,
      dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null,
      bankDetails: {
        accountName: req.body.bankDetails?.accountName,
        accountNumber: req.body.bankDetails?.accountNumber,
        ifscCode: req.body.bankDetails?.ifscCode,
        bankName: req.body.bankDetails?.bankName,
        branch: req.body.bankDetails?.branch
      },
      commissionRate: req.body.commissionRate || 20
    });

    // Update calendar with doctor's availability
    try {
      console.log(`🗓️ Adding new doctor ${name} to calendar...`);
      await addDoctorToCalendar(newDoctor);
      console.log(`✅ Calendar updated for Doctor ${name}`);
    } catch (calendarError) {
      console.error('❌ Failed to update calendar with new doctor:', calendarError);
    }

    res.status(201).json({
      success: true,
      message: 'Doctor created successfully. Profile pending admin verification.',
      doctor: newDoctor,
      user: {
        id: newUser._id,
        email: newUser.email,
        role: newUser.role,
        isVerified: newUser.isVerified
      }
    });
  } catch (err) {
    console.error('Doctor creation error:', err.message);
    
    // Clean up user if doctor creation fails
    if (req.body.email) {
      await User.findOneAndDelete({ email: req.body.email });
    }
    
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
};

// Get all doctors (public)
exports.getAllDoctors = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      specialization,
      verificationStatus,
      search,
      minRating,
      maxFee,
      city
    } = req.query;

    const filter = {};

    // Filter by specialization
    if (specialization) {
      filter.specialization = { $in: [specialization] };
    }

    // Filter by verification status
    if (verificationStatus) {
      filter.verificationStatus = verificationStatus;
    } else {
      // Default: show only approved doctors for public
      filter.verificationStatus = 'approved';
    }

    // Filter by search term
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { specialization: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by minimum rating
    if (minRating) {
      filter.averageRating = { $gte: parseFloat(minRating) };
    }

    // Filter by maximum consultation fee
    if (maxFee) {
      filter.consultationFee = { $lte: parseFloat(maxFee) };
    }

    // Filter by city
    if (city) {
      filter['clinicAddress.city'] = { $regex: city, $options: 'i' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const doctors = await DoctorProfile.find(filter)
      .select('-password -bankDetails -licenseDocument')
      .populate('userId', 'email isVerified')
      .sort({ averageRating: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await DoctorProfile.countDocuments(filter);

    res.json({
      success: true,
      doctors,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Error fetching doctors:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch doctors' 
    });
  }
};

// Get doctor by ID (public)
exports.getDoctorById = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findById(req.params.id)
      .select('-password -bankDetails')
      .populate('userId', 'email isVerified');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor not found' 
      });
    }

    // Get doctor's upcoming appointments (public view - limited info)
    const Appointment = require('../models/Appointment');
    const upcomingAppointments = await Appointment.find({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: new Date() },
      status: { $in: ['confirmed', 'accepted'] }
    })
    .select('appointmentDate startTime type')
    .sort({ appointmentDate: 1 })
    .limit(5);

    res.json({
      success: true,
      doctor: {
        ...doctor.toObject(),
        upcomingAppointments
      }
    });
  } catch (err) {
    console.error('Error fetching doctor:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch doctor details' 
    });
  }
};

// Get doctors by specialization (public)
exports.getDoctorsBySpecialization = async (req, res) => {
  try {
    const { specialization } = req.params;
    const { city, minRating, maxFee, page = 1, limit = 20 } = req.query;

    const filter = {
      specialization: { $in: [specialization] },
      verificationStatus: 'approved',
      isActive: true
    };

    // Optional city filter
    if (city) {
      filter['clinicAddress.city'] = { $regex: city, $options: 'i' };
    }

    // Optional minimum rating filter
    if (minRating) {
      filter.averageRating = { $gte: parseFloat(minRating) };
    }

    // Optional maximum fee filter
    if (maxFee) {
      filter.consultationFee = { $lte: parseFloat(maxFee) };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const doctors = await DoctorProfile.find(filter)
      .select('name specialization averageRating consultationFee homeVisitFee clinicAddress availability totalConsultations')
      .sort({ averageRating: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await DoctorProfile.countDocuments(filter);

    res.json({
      success: true,
      specialization,
      count: doctors.length,
      doctors,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Error fetching doctors by specialization:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch doctors' 
    });
  }
};

// Get doctor's availability (public)
exports.getDoctorAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { date } = req.query;

    const doctor = await DoctorProfile.findById(id)
      .select('availability name consultationFee homeVisitFee')
      .populate('userId', 'isVerified');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor not found' 
      });
    }

    // Check if doctor is verified
    if (!doctor.userId?.isVerified) {
      return res.status(400).json({
        success: false,
        error: 'Doctor profile is not verified'
      });
    }

    const targetDate = date ? new Date(date) : new Date();
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

    // Get doctor's availability for this day
    const dayAvailability = doctor.availability?.find(a => a.day === dayName);

    if (!dayAvailability) {
      return res.json({
        success: true,
        date: targetDate.toISOString().split('T')[0],
        isAvailable: false,
        slots: [],
        doctorName: doctor.name,
        consultationFee: doctor.consultationFee,
        homeVisitFee: doctor.homeVisitFee
      });
    }

    // Check calendar for booked slots
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const dateStr = targetDate.toISOString().split('T')[0];

    const calendar = await Calendar.findOne({ year, month });
    let bookedSlots = [];

    if (calendar) {
      const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
      if (day) {
        const professional = day.professionals.find(
          p => p.professionalId.toString() === id && p.professionalType === 'doctor'
        );
        if (professional) {
          bookedSlots = professional.bookedSlots.filter(slot => slot.isBooked);
        }
      }
    }

    // Filter out booked slots
    const availableSlots = dayAvailability.slots.map(slot => {
      const isBooked = bookedSlots.some(booked => 
        booked.startTime === slot.startTime && booked.endTime === slot.endTime
      );
      
      return {
        startTime: slot.startTime,
        endTime: slot.endTime,
        type: slot.type || 'clinic',
        maxPatients: slot.maxPatients || 1,
        isBooked,
        isAvailable: !isBooked,
        fee: slot.type === 'home' ? doctor.homeVisitFee : doctor.consultationFee
      };
    });

    res.json({
      success: true,
      date: dateStr,
      dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
      isAvailable: availableSlots.some(slot => slot.isAvailable),
      slots: availableSlots,
      doctorName: doctor.name,
      consultationFee: doctor.consultationFee,
      homeVisitFee: doctor.homeVisitFee
    });
  } catch (err) {
    console.error('Error fetching doctor availability:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch availability' 
    });
  }
};

// ========== DOCTOR-ONLY FUNCTIONS ==========

// Get current doctor's profile
exports.getProfile = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id })
      .populate('userId', 'email isVerified lastLogin');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    res.json({
      success: true,
      doctor
    });
  } catch (err) {
    console.error('Error fetching doctor profile:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch profile' 
    });
  }
};

// Update current doctor's profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    
    // Remove fields that shouldn't be updated directly
    delete updates.verificationStatus;
    delete updates.totalEarnings;
    delete updates.totalConsultations;
    delete updates.averageRating;
    delete updates.totalReviews;
    delete updates.pendingCommission;
    delete updates.paidCommission;
    delete updates.userId;

    const doctor = await DoctorProfile.findOneAndUpdate(
      { userId: req.user.id },
      updates,
      { new: true, runValidators: true }
    ).populate('userId', 'email');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    // Update associated user if email changed
    if (updates.email && doctor.userId) {
      await User.findByIdAndUpdate(doctor.userId, {
        email: updates.email
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      doctor
    });
  } catch (err) {
    console.error('Error updating doctor profile:', err.message);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
};

// Update current doctor's availability
exports.updateAvailability = async (req, res) => {
  try {
    const { availability } = req.body;

    const doctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    doctor.availability = availability;
    await doctor.save();

    // Update calendar with new availability
    try {
      await updateDoctorInCalendar(doctor._id, doctor);
    } catch (calendarError) {
      console.error('Error updating doctor in calendar:', calendarError);
    }

    res.json({
      success: true,
      message: 'Availability updated successfully',
      availability: doctor.availability
    });
  } catch (err) {
    console.error('Error updating availability:', err.message);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
};

// Get current doctor's appointments
exports.getAppointments = async (req, res) => {
  try {
    const { 
      status, 
      type,
      startDate,
      endDate,
      page = 1,
      limit = 20 
    } = req.query;

    const doctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    const filter = { 
      doctorId: doctor._id,
      professionalType: 'doctor'
    };

    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.appointmentDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const Appointment = require('../models/Appointment');
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('referralId', 'requirement')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

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
  } catch (err) {
    console.error('Error fetching appointments:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch appointments' 
    });
  }
};

// Get current doctor's earnings summary
exports.getEarnings = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id })
      .select('totalEarnings pendingCommission paidCommission totalConsultations');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const Commission = require('../models/Commission');
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: doctor._id,
          professionalType: 'doctor',
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$professionalEarning' },
          totalCommission: { $sum: '$platformCommission' }
        }
      }
    ]);

    res.json({
      success: true,
      earnings: {
        totalEarnings: doctor.totalEarnings || 0,
        pendingCommission: doctor.pendingCommission || 0,
        paidCommission: doctor.paidCommission || 0,
        monthlyEarnings: monthlyEarnings[0]?.totalEarnings || 0,
        monthlyCommission: monthlyEarnings[0]?.totalCommission || 0
      },
      stats: {
        totalConsultations: doctor.totalConsultations || 0
      }
    });
  } catch (err) {
    console.error('Error fetching earnings:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch earnings data' 
    });
  }
};

// Get current doctor's detailed earnings report
exports.getDoctorEarnings = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    const { startDate, endDate, groupBy = 'month' } = req.query;

    const matchStage = {
      professionalId: doctor._id,
      professionalType: 'doctor'
    };

    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const Commission = require('../models/Commission');
    const earnings = await Commission.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: groupBy === 'month' ? {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          } : {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          totalEarnings: { $sum: '$professionalEarning' },
          totalCommission: { $sum: '$platformCommission' },
          appointmentCount: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);

    // Get pending commission
    const pendingCommission = await Commission.aggregate([
      {
        $match: {
          professionalId: doctor._id,
          professionalType: 'doctor',
          payoutStatus: 'pending'
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$platformCommission' },
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      success: true,
      earnings,
      pendingCommission: pendingCommission[0]?.total || 0,
      profileStats: {
        totalEarnings: doctor.totalEarnings || 0,
        pendingCommission: doctor.pendingCommission || 0,
        paidCommission: doctor.paidCommission || 0
      }
    });
  } catch (err) {
    console.error('Error fetching earnings report:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch earnings report' 
    });
  }
};

// Get current doctor's dashboard
exports.getDoctorDashboard = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id })
      .select('name specialization averageRating totalConsultations totalEarnings');

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor profile not found'
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get today's appointments
    const Appointment = require('../models/Appointment');
    const todaysAppointments = await Appointment.countDocuments({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: today },
      status: { $in: ['confirmed', 'accepted'] }
    });

    // Get pending appointments
    const pendingAppointments = await Appointment.countDocuments({
      doctorId: doctor._id,
      professionalType: 'doctor',
      status: 'pending'
    });

    // Get this month's earnings
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const Commission = require('../models/Commission');
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: doctor._id,
          professionalType: 'doctor',
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$professionalEarning' }
        }
      }
    ]);

    // Get recent appointments
    const recentAppointments = await Appointment.find({
      doctorId: doctor._id,
      professionalType: 'doctor'
    })
    .populate('patientId', 'name')
    .sort({ appointmentDate: -1 })
    .limit(5);

    res.json({
      success: true,
      stats: {
        totalConsultations: doctor.totalConsultations || 0,
        totalEarnings: doctor.totalEarnings || 0,
        averageRating: doctor.averageRating || 0,
        todaysAppointments,
        pendingAppointments,
        monthlyEarnings: monthlyEarnings[0]?.total || 0
      },
      recentAppointments,
      profile: {
        name: doctor.name,
        specialization: doctor.specialization
      }
    });
  } catch (err) {
    console.error('Error fetching doctor dashboard:', err.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
};

// ========== ADMIN-ONLY FUNCTIONS ==========

// Update any doctor by ID (Admin only)
exports.updateDoctor = async (req, res) => {
  try {
    const doctorId = req.params.id;
    const updates = req.body;

    // Remove fields that shouldn't be updated directly
    delete updates.totalEarnings;
    delete updates.totalConsultations;
    delete updates.pendingCommission;
    delete updates.paidCommission;

    const doctor = await DoctorProfile.findByIdAndUpdate(
      doctorId,
      updates,
      { new: true, runValidators: true }
    ).populate('userId', 'email');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor not found' 
      });
    }

    // Update associated user if email changed
    if (updates.email && doctor.userId) {
      await User.findByIdAndUpdate(doctor.userId, {
        email: updates.email
      });
    }

    // Update calendar if availability changed
    if (updates.availability) {
      try {
        await updateDoctorInCalendar(doctorId, doctor);
      } catch (calendarError) {
        console.error('Error updating doctor in calendar:', calendarError);
      }
    }

    res.json({
      success: true,
      message: 'Doctor updated successfully',
      doctor
    });
  } catch (err) {
    console.error('Error updating doctor:', err.message);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
};

// Delete doctor by ID (Admin only)
exports.deleteDoctor = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findById(req.params.id);
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor not found' 
      });
    }

    // Check if doctor has upcoming appointments
    const Appointment = require('../models/Appointment');
    const upcomingAppointments = await Appointment.countDocuments({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: new Date() },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    });

    if (upcomingAppointments > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete doctor with upcoming appointments. Cancel appointments first.'
      });
    }

    // Remove doctor from calendar before deleting
    try {
      await removeDoctorFromCalendar(doctor._id);
    } catch (calendarError) {
      console.error('Error removing doctor from calendar:', calendarError);
    }

    // Delete associated user
    if (doctor.userId) {
      await User.findByIdAndDelete(doctor.userId);
    }

    // Delete the doctor profile
    await DoctorProfile.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Doctor deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting doctor:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete doctor' 
    });
  }
};

// Bulk create doctors (Admin only)
exports.bulkCreateDoctors = async (req, res) => {
  const doctorsData = req.body;
  console.log('Bulk import data:', doctorsData);

  if (!doctorsData || !Array.isArray(doctorsData)) {
    return res.status(400).json({ 
      success: false,
      error: 'Invalid data format. Expected an array.' 
    });
  }

  const successfulImports = [];
  const failedImports = [];

  for (const doctorData of doctorsData) {
    try {
      // Check if user already exists
      const userExists = await User.findOne({ email: doctorData.email });
      if (userExists) {
        throw new Error('User with this email already exists.');
      }

      // Create User
      const newUser = await User.create({
        name: doctorData.name,
        email: doctorData.email,
        password: doctorData.password || 'temporary123',
        role: 'doctor',
        phone: doctorData.phone
      });

      // Create DoctorProfile
      const newDoctor = await DoctorProfile.create({
        userId: newUser._id,
        name: doctorData.name,
        email: doctorData.email,
        phone: doctorData.phone,
        specialization: doctorData.specialization || [],
        qualifications: doctorData.qualifications || [],
        experienceYears: doctorData.experienceYears || 0,
        licenseNumber: doctorData.licenseNumber,
        clinicAddress: {
          address: doctorData.address || '',
          city: doctorData.city || '',
          state: doctorData.state || '',
          pincode: doctorData.pincode || '',
          location: doctorData.location || {
            type: 'Point',
            coordinates: [0, 0]
          }
        },
        consultationFee: doctorData.consultationFee || 0,
        homeVisitFee: doctorData.homeVisitFee || 0,
        availability: doctorData.availability || [],
        about: doctorData.about || '',
        services: doctorData.services || [],
        gender: doctorData.gender,
        dateOfBirth: doctorData.dateOfBirth ? new Date(doctorData.dateOfBirth) : null,
        bankDetails: doctorData.bankDetails,
        commissionRate: doctorData.commissionRate || 20
      });

      // Add to calendar
      try {
        await addDoctorToCalendar(newDoctor);
      } catch (calendarError) {
        console.error('Error adding doctor to calendar during bulk import:', calendarError);
      }

      successfulImports.push({
        id: newDoctor._id,
        name: newDoctor.name,
        email: newDoctor.email
      });
    } catch (err) {
      failedImports.push({ 
        email: doctorData.email, 
        reason: err.message 
      });
    }
  }

  res.status(201).json({
    success: true,
    message: 'Bulk import process completed.',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    successfulImports,
    failedImports
  });
};

// ========== HELPER FUNCTIONS ==========

// Helper function to add doctor to calendar
async function addDoctorToCalendar(doctor) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Generate dates for next 30 days
  const datesToUpdate = [];
  for (let i = 0; i <= 30; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    date.setHours(0, 0, 0, 0);
    datesToUpdate.push(date);
  }

  // Get current month/year for calendar
  const targetDate = new Date();
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;

  let calendar = await Calendar.findOne({ year, month });
  if (!calendar) {
    calendar = new Calendar({ 
      year, 
      month, 
      days: [] 
    });
  }

  let needsUpdate = false;

  for (const targetDate of datesToUpdate) {
    const dateStr = targetDate.toISOString().split('T')[0];
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    
    // Check doctor's availability for this day
    const dayAvailability = doctor.availability?.find(a => a.day === dayName);
    if (!dayAvailability) continue;

    const existingDayIndex = calendar.days.findIndex(
      d => d.date.toISOString().split('T')[0] === dateStr
    );

    if (existingDayIndex !== -1) {
      const existingDay = calendar.days[existingDayIndex];
      const isDoctorAlreadyAdded = existingDay.professionals.some(
        p => p.professionalId.toString() === doctor._id.toString() && 
             p.professionalType === 'doctor'
      );

      if (!isDoctorAlreadyAdded) {
        needsUpdate = true;
        
        const bookedSlots = dayAvailability.slots.map(slot => ({
          startTime: slot.startTime,
          endTime: slot.endTime,
          isBooked: false,
          type: slot.type || 'clinic'
        }));

        existingDay.professionals.push({
          professionalId: doctor._id,
          professionalType: 'doctor',
          bookedSlots: bookedSlots,
          breaks: [],
          isAvailable: true
        });
      }
    } else {
      needsUpdate = true;
      
      const bookedSlots = dayAvailability.slots.map(slot => ({
        startTime: slot.startTime,
        endTime: slot.endTime,
        isBooked: false,
        type: slot.type || 'clinic'
      }));

      calendar.days.push({
        date: targetDate,
        dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        isHoliday: false,
        professionals: [{
          professionalId: doctor._id,
          professionalType: 'doctor',
          bookedSlots: bookedSlots,
          breaks: [],
          isAvailable: true
        }]
      });
    }
  }

  if (needsUpdate) {
    // Filter to keep only next 30 days
    const todayStr = today.toISOString().split('T')[0];
    calendar.days = calendar.days.filter(day => {
      const dayDate = new Date(day.date);
      const diffDays = Math.floor((dayDate - today) / (1000 * 60 * 60 * 24));
      return diffDays >= 0 && diffDays <= 30;
    });

    // Sort days chronologically
    calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));

    await calendar.save();
  }
}

// Helper function to update doctor in calendar
async function updateDoctorInCalendar(doctorId, updatedDoctor) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Update next 30 days
  const datesToUpdate = [];
  for (let i = 0; i <= 30; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    date.setHours(0, 0, 0, 0);
    datesToUpdate.push(date);
  }

  // Get current month/year for calendar
  const targetDate = new Date();
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;

  let calendar = await Calendar.findOne({ year, month });
  if (!calendar) return;

  let updated = false;

  for (const targetDate of datesToUpdate) {
    const dateStr = targetDate.toISOString().split('T')[0];
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    
    const dayAvailability = updatedDoctor.availability?.find(a => a.day === dayName);

    const existingDayIndex = calendar.days.findIndex(
      d => d.date.toISOString().split('T')[0] === dateStr
    );

    if (existingDayIndex !== -1) {
      const existingDay = calendar.days[existingDayIndex];
      const professionalIndex = existingDay.professionals.findIndex(
        p => p.professionalId.toString() === doctorId.toString() && 
             p.professionalType === 'doctor'
      );

      if (professionalIndex !== -1) {
        if (!dayAvailability) {
          existingDay.professionals.splice(professionalIndex, 1);
          updated = true;
        } else {
          const bookedSlots = dayAvailability.slots.map(slot => ({
            startTime: slot.startTime,
            endTime: slot.endTime,
            isBooked: false,
            type: slot.type || 'clinic'
          }));

          existingDay.professionals[professionalIndex].bookedSlots = bookedSlots;
          updated = true;
        }
      } else if (dayAvailability) {
        const bookedSlots = dayAvailability.slots.map(slot => ({
          startTime: slot.startTime,
          endTime: slot.endTime,
          isBooked: false,
          type: slot.type || 'clinic'
        }));

        existingDay.professionals.push({
          professionalId: updatedDoctor._id,
          professionalType: 'doctor',
          bookedSlots: bookedSlots,
          breaks: [],
          isAvailable: true
        });
        updated = true;
      }
    }
  }

  if (updated) {
    calendar.days = calendar.days.filter(day => day.professionals.length > 0);
    calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
    await calendar.save();
  }
}

// Helper function to remove doctor from calendar
async function removeDoctorFromCalendar(doctorId) {
  const calendars = await Calendar.find({
    'days.professionals.professionalId': doctorId
  });

  for (const calendar of calendars) {
    let updated = false;
    
    for (const day of calendar.days) {
      const initialLength = day.professionals.length;
      day.professionals = day.professionals.filter(
        p => !(p.professionalId.toString() === doctorId.toString() && 
               p.professionalType === 'doctor')
      );
      
      if (day.professionals.length !== initialLength) {
        updated = true;
      }
    }
    
    calendar.days = calendar.days.filter(day => day.professionals.length > 0);
    
    if (updated) {
      await calendar.save();
    }
  }
}