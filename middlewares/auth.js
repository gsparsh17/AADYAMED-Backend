const jwt = require('jsonwebtoken');
const User = require('../models/User');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const PathologyProfile = require('../models/PathologyProfile');

exports.protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    
    if (!token) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }
    
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'User not found or inactive' });
    }
    
    // Get profile based on role
    let profile;
    switch(user.role) {
      case 'doctor':
        profile = await DoctorProfile.findOne({ userId: user._id });
        break;
      case 'physiotherapist':
        profile = await PhysiotherapistProfile.findOne({ userId: user._id });
        break;
      case 'patient':
        profile = await PatientProfile.findOne({ userId: user._id });
        break;
      case 'pathology':
        profile = await PathologyProfile.findOne({ userId: user._id });
        break;
    }
    
    req.user = {
      id: user._id,
      email: user.email,
      role: user.role,
      profileId: profile?._id,
      isVerified: user.isVerified
    };
    
    next();
  } catch (error) {
    res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `User role ${req.user.role} is not authorized to access this route` 
      });
    }
    next();
  };
};