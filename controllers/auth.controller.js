const User = require('../models/User');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const PathologyProfile = require('../models/PathologyProfile');
const generateToken = require('../utils/generateToken');
const sendEmail = require('../utils/sendEmail');
const crypto = require('crypto');

exports.register = async (req, res) => {
  try {
    const { email, password, role, phone, name } = req.body;
    
    // Check if user exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }
    
    // Create user
    const user = await User.create({
      email,
      password,
      role,
      phone: role === 'patient' ? phone : undefined
    });
    
    // Create profile based on role
    let profile;
    switch(role) {
      case 'doctor':
        profile = await DoctorProfile.create({
          userId: user._id,
          name,
          email: user.email,
          contactNumber: phone
        });
        break;
      case 'physiotherapist':
        profile = await PhysiotherapistProfile.create({
          userId: user._id,
          name,
          email: user.email,
          contactNumber: phone
        });
        break;
      case 'patient':
        profile = await PatientProfile.create({
          userId: user._id,
          name,
          phone: user.phone,
          email: user.email
        });
        break;
      case 'pathology':
        profile = await PathologyProfile.create({
          userId: user._id,
          labName: name,
          email: user.email,
          phone
        });
        break;
    }
    
    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    user.emailVerificationToken = crypto
      .createHash('sha256')
      .update(verificationToken)
      .digest('hex');
    user.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    await user.save();
    
    // Send verification email
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Verify Your Email - AADYAMED',
      html: `<p>Please click <a href="${verificationUrl}">here</a> to verify your email.</p>`
    });
    
    // Generate JWT
    const token = generateToken(user._id);
    
    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified
      },
      profile
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    if (!user.isActive) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }
    
    // Update last login
    user.lastLogin = Date.now();
    await user.save();
    
    const token = generateToken(user._id);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;
    
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
    
    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }
    
    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();
    
    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes
    
    await user.save();
    
    // Send reset email
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Password Reset Request - AADYAMED',
      html: `<p>Click <a href="${resetUrl}">here</a> to reset your password.</p>`
    });
    
    res.json({ success: true, message: 'Reset email sent' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
    
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }
    
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    
    res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = req.body;
    
    let profile;
    switch(req.user.role) {
      case 'doctor':
        profile = await DoctorProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      case 'physiotherapist':
        profile = await PhysiotherapistProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      case 'patient':
        profile = await PatientProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      case 'pathology':
        profile = await PathologyProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
    }
    
    // Update profile complete status
    if (profile) {
      const user = await User.findById(userId);
      user.profileComplete = true;
      await user.save();
    }
    
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};