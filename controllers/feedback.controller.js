const Feedback = require('../models/Feedback');
const Appointment = require('../models/Appointment');

exports.submitFeedback = async (req, res) => {
  try {
    const { 
      appointmentId, 
      overallRating, 
      categoryRatings, 
      comments,
      strengths,
      areasForImprovement,
      wouldRecommend,
      isAnonymous 
    } = req.body;
    
    const appointment = await Appointment.findById(appointmentId)
      .populate('patientId doctorId physioId');
    
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    
    // Check if feedback already exists
    const existingFeedback = await Feedback.findOne({ appointmentId });
    if (existingFeedback) {
      return res.status(400).json({ message: 'Feedback already submitted for this appointment' });
    }
    
    // Check if user is the patient from the appointment
    if (appointment.patientId._id.toString() !== req.user.profileId) {
      return res.status(403).json({ message: 'Only the patient can submit feedback for this appointment' });
    }
    
    // Check if appointment is completed
    if (appointment.status !== 'completed') {
      return res.status(400).json({ message: 'Feedback can only be submitted for completed appointments' });
    }
    
    const feedback = await Feedback.create({
      appointmentId,
      patientId: appointment.patientId._id,
      professionalId: appointment.professionalType === 'doctor' 
        ? appointment.doctorId._id 
        : appointment.physioId._id,
      professionalType: appointment.professionalType,
      overallRating,
      categoryRatings,
      comments,
      strengths,
      areasForImprovement,
      wouldRecommend,
      isAnonymous,
      status: 'submitted'
    });
    
    // Update professional's average rating
    await updateProfessionalRating(feedback);
    
    res.status(201).json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getFeedback = async (req, res) => {
  try {
    const { 
      professionalId,
      professionalType,
      minRating,
      startDate,
      endDate,
      page = 1,
      limit = 10 
    } = req.query;
    
    const filter = { status: 'approved' };
    
    if (professionalId && professionalType) {
      filter.professionalId = professionalId;
      filter.professionalType = professionalType;
    }
    
    if (minRating) {
      filter.overallRating = { $gte: parseInt(minRating) };
    }
    
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const feedbacks = await Feedback.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('patientId', 'name')
      .populate('professionalId', 'name specialization');
    
    const total = await Feedback.countDocuments(filter);
    
    // Calculate average rating
    const stats = await Feedback.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          averageRating: { $avg: '$overallRating' },
          totalReviews: { $sum: 1 },
          ratingDistribution: {
            $push: '$overallRating'
          }
        }
      }
    ]);
    
    // Calculate rating distribution
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    if (stats[0] && stats[0].ratingDistribution) {
      stats[0].ratingDistribution.forEach(rating => {
        distribution[rating] = (distribution[rating] || 0) + 1;
      });
    }
    
    res.json({
      success: true,
      feedbacks,
      stats: stats[0] ? {
        averageRating: stats[0].averageRating.toFixed(1),
        totalReviews: stats[0].totalReviews,
        distribution
      } : null,
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

exports.getMyFeedback = async (req, res) => {
  try {
    const filter = {};
    
    if (req.user.role === 'patient') {
      filter.patientId = req.user.profileId;
    } else if (['doctor', 'physiotherapist'].includes(req.user.role)) {
      filter.professionalId = req.user.profileId;
      filter.professionalType = req.user.role;
    } else {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    const feedbacks = await Feedback.find(filter)
      .sort({ createdAt: -1 })
      .populate('patientId', 'name')
      .populate('professionalId', 'name specialization')
      .populate('appointmentId', 'appointmentDate type');
    
    res.json({ success: true, feedbacks });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateFeedbackStatus = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { status, adminNotes } = req.body;
    
    const feedback = await Feedback.findById(req.params.id);
    if (!feedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    
    feedback.status = status;
    feedback.adminNotes = adminNotes;
    feedback.reviewedBy = req.user.id;
    feedback.reviewedAt = new Date();
    
    await feedback.save();
    
    // If approved, update professional rating
    if (status === 'approved') {
      await updateProfessionalRating(feedback);
    }
    
    res.json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addProfessionalResponse = async (req, res) => {
  try {
    const { response, isPublic } = req.body;
    
    const feedback = await Feedback.findById(req.params.id);
    if (!feedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    
    // Check if user is the professional being reviewed
    if (feedback.professionalId.toString() !== req.user.profileId) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    feedback.professionalResponse = {
      response,
      respondedAt: new Date(),
      isPublic
    };
    
    await feedback.save();
    
    res.json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper function
async function updateProfessionalRating(feedback) {
  if (feedback.status !== 'approved') return;
  
  const stats = await Feedback.aggregate([
    {
      $match: {
        professionalId: feedback.professionalId,
        professionalType: feedback.professionalType,
        status: 'approved'
      }
    },
    {
      $group: {
        _id: null,
        averageRating: { $avg: '$overallRating' },
        totalReviews: { $sum: 1 }
      }
    }
  ]);
  
  if (stats[0]) {
    const updateData = {
      averageRating: parseFloat(stats[0].averageRating.toFixed(1)),
      totalReviews: stats[0].totalReviews
    };
    
    if (feedback.professionalType === 'doctor') {
      await DoctorProfile.findByIdAndUpdate(feedback.professionalId, updateData);
    } else {
      await PhysiotherapistProfile.findByIdAndUpdate(feedback.professionalId, updateData);
    }
  }
}