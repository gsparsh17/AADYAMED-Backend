const Referral = require('../models/Referral');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');

exports.createReferral = async (req, res) => {
  try {
    const { requirement } = req.body;
    const patientId = req.user.profileId; // Assuming profileId is attached to req.user
    
    const referral = await Referral.create({
      patientId,
      requirement,
      status: 'submitted'
    });
    
    // Generate suggestions
    await generateSuggestions(referral._id);
    
    res.status(201).json({ success: true, referral });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getReferrals = async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const filter = { patientId: req.user.profileId };
    
    if (status) filter.status = status;
    
    const referrals = await Referral.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('suggestedProfessionals.doctorId', 'name specialization averageRating consultationFee')
      .populate('suggestedProfessionals.physioId', 'name specialization averageRating consultationFee homeVisitFee');
    
    const total = await Referral.countDocuments(filter);
    
    res.json({
      success: true,
      referrals,
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

exports.getReferralById = async (req, res) => {
  try {
    const referral = await Referral.findById(req.params.id)
      .populate('patientId', 'name age gender')
      .populate('suggestedProfessionals.doctorId')
      .populate('suggestedProfessionals.physioId')
      .populate('appointmentId');
    
    if (!referral) {
      return res.status(404).json({ message: 'Referral not found' });
    }
    
    res.json({ success: true, referral });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.selectProfessional = async (req, res) => {
  try {
    const { professionalId, type, reason } = req.body;
    
    const referral = await Referral.findById(req.params.id);
    if (!referral) {
      return res.status(404).json({ message: 'Referral not found' });
    }
    
    // Check if professional is in suggestions
    const suggestion = referral.suggestedProfessionals.find(s => 
      (type === 'doctor' && s.doctorId?.toString() === professionalId) ||
      (type === 'physiotherapist' && s.physioId?.toString() === professionalId)
    );
    
    if (!suggestion) {
      return res.status(400).json({ message: 'Professional not in suggestions' });
    }
    
    referral.selectedProfessional = {
      professionalId,
      type,
      selectedAt: Date.now(),
      selectionReason: reason
    };
    referral.status = 'professional_selected';
    
    await referral.save();
    
    res.json({ success: true, referral });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper function to generate suggestions
async function generateSuggestions(referralId) {
  const referral = await Referral.findById(referralId);
  const { requirement } = referral;
  
  let suggestions = [];
  
  // Get doctors matching criteria
  if (requirement.preferredSpecialization.length > 0) {
    const doctorQuery = {
      verificationStatus: 'approved',
      isActive: true,
      specialization: { $in: requirement.preferredSpecialization }
    };
    
    if (requirement.preferredLocation) {
      doctorQuery['clinicAddress.location'] = {
        $near: {
          $geometry: requirement.preferredLocation,
          $maxDistance: 20000 // 20km
        }
      };
    }
    
    const doctors = await DoctorProfile.find(doctorQuery)
      .limit(10)
      .select('name specialization averageRating consultationFee clinicAddress');
    
    suggestions = suggestions.concat(doctors.map(doctor => ({
      doctorId: doctor._id,
      type: 'doctor',
      matchScore: calculateMatchScore(doctor, requirement),
      consultationFee: doctor.consultationFee,
      averageRating: doctor.averageRating,
      distance: calculateDistance(doctor.clinicAddress.location, requirement.preferredLocation)
    })));
  }
  
  // Get physiotherapists
  const physioQuery = {
    verificationStatus: 'approved',
    isActive: true,
    specialization: { $in: requirement.preferredSpecialization }
  };
  
  const physios = await PhysiotherapistProfile.find(physioQuery)
    .limit(10)
    .select('name specialization averageRating consultationFee homeVisitFee clinicAddress');
  
  suggestions = suggestions.concat(physios.map(physio => ({
    physioId: physio._id,
    type: 'physiotherapist',
    matchScore: calculateMatchScore(physio, requirement),
    consultationFee: physio.consultationFee,
    homeVisitFee: physio.homeVisitFee,
    averageRating: physio.averageRating,
    distance: calculateDistance(physio.clinicAddress.location, requirement.preferredLocation)
  })));
  
  // Sort by match score
  suggestions.sort((a, b) => b.matchScore - a.matchScore);
  
  referral.suggestedProfessionals = suggestions.slice(0, 5);
  referral.status = 'suggestions_generated';
  await referral.save();
}

function calculateMatchScore(professional, requirement) {
  let score = 0;
  
  // Specialization match
  const specializationMatch = professional.specialization.some(s => 
    requirement.preferredSpecialization.includes(s)
  );
  if (specializationMatch) score += 40;
  
  // Rating
  score += (professional.averageRating || 3) * 10;
  
  // Price match
  if (requirement.budgetRange) {
    const fee = professional.consultationFee || professional.homeVisitFee;
    if (fee <= requirement.budgetRange.max) {
      const priceRatio = fee / requirement.budgetRange.max;
      score += (1 - priceRatio) * 20;
    }
  }
  
  // Experience
  if (professional.experienceYears) {
    score += Math.min(professional.experienceYears, 10);
  }
  
  // Availability (simplified)
  score += 10;
  
  return Math.min(score, 100);
}

function calculateDistance(loc1, loc2) {
  if (!loc1 || !loc2) return null;
  
  const R = 6371; // Earth's radius in km
  const lat1 = loc1.coordinates[1] * Math.PI / 180;
  const lat2 = loc2.coordinates[1] * Math.PI / 180;
  const dLat = (loc2.coordinates[1] - loc1.coordinates[1]) * Math.PI / 180;
  const dLon = (loc2.coordinates[0] - loc1.coordinates[0]) * Math.PI / 180;
  
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  
  return R * c;
}