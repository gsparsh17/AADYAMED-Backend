const crypto = require('crypto');
const User = require('../models/User');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const PathologyProfile = require('../models/PathologyProfile');
const { generateToken }= require('../utils/generateToken');
const sendEmail = require('../utils/sendEmail');
const { default: mongoose } = require('mongoose');

// ========== HELPER FUNCTIONS ==========

const getClientIp = (req) => {
  return req.headers['x-forwarded-for'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         req.ip;
};

const validateRegistrationData = (data) => {
  const errors = [];
  
  // Email validation
  const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
  if (!emailRegex.test(data.email)) {
    errors.push('Please enter a valid email address');
  }
  
  // Password validation
  if (data.password.length < 6) {
    errors.push('Password must be at least 6 characters');
  }
  
  // Role validation
  const validRoles = ['doctor', 'physiotherapist', 'patient', 'pathology', 'pharmacy'];
  if (!validRoles.includes(data.role)) {
    errors.push('Invalid role selected');
  }
  
  // Phone validation
  const phoneRegex = /^[0-9]{10}$/;
  if (!phoneRegex.test(data.phone)) {
    errors.push('Please enter a valid 10-digit phone number');
  }
  
  // Name validation
  if (!data.name || data.name.trim().length < 2) {
    errors.push('Name must be at least 2 characters');
  }
  
  return errors;
};

// ========== AUTH CONTROLLER FUNCTIONS ==========

/**
 * @desc    Register a new user (Basic registration only)
 * @route   POST /api/auth/register
 * @access  Public
 */
exports.register = async (req, res) => {
  try {
    const { email, password, role, phone, name } = req.body;
    
    // Validate input data
    const validationErrors = validateRegistrationData(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: validationErrors.join(', ')
      });
    }
    
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'An account with this email already exists'
      });
    }
    
    // Create basic user (NO PROFILE CREATED)
    const user = await User.create({
      email,
      password,
      role,
      phone,
      name: name.trim(),
      registrationSource: req.headers['x-registration-source'] || 'web'
    });
    
    // Generate email verification token
    const verificationToken = user.cr;
    await user.save();
    
    // Send verification email
    // try {
    //   const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;
      
    //   await sendEmail({
    //     to: user.email,
    //     subject: 'Verify Your Email - AADYAMED',
    //     html: `
    //       <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
    //         <div style="text-align: center; margin-bottom: 30px;">
    //           <h2 style="color: #2563eb; margin-bottom: 10px;">Welcome to AADYAMED!</h2>
    //           <p style="color: #666; font-size: 16px;">Healthcare at your fingertips</p>
    //         </div>
            
    //         <div style="background-color: #f8fafc; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
    //           <p style="margin: 0; color: #334155; line-height: 1.6;">
    //             Hello <strong>${user.name}</strong>,<br><br>
    //             Thank you for creating an account with AADYAMED. To get started, please verify your email address by clicking the button below:
    //           </p>
    //         </div>
            
    //         <div style="text-align: center; margin: 30px 0;">
    //           <a href="${verificationUrl}" 
    //              style="background-color: #2563eb; color: white; padding: 14px 28px; 
    //                     text-decoration: none; border-radius: 6px; font-weight: 600; 
    //                     display: inline-block; font-size: 16px; border: none; cursor: pointer;">
    //             Verify Email Address
    //           </a>
    //         </div>
            
    //         <div style="color: #64748b; font-size: 14px; text-align: center; margin-bottom: 20px;">
    //           <p style="margin: 5px 0;">Or copy and paste this link in your browser:</p>
    //           <p style="margin: 10px 0; padding: 10px; background-color: #f1f5f9; border-radius: 4px; word-break: break-all;">
    //             ${verificationUrl}
    //           </p>
    //           <p style="margin: 5px 0;">This link will expire in 24 hours.</p>
    //         </div>
            
    //         <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">
            
    //         <div style="color: #94a3b8; font-size: 12px; text-align: center;">
    //           <p style="margin: 5px 0;">If you didn't create an account with AADYAMED, please ignore this email.</p>
    //           <p style="margin: 5px 0;">Need help? Contact our support team at <a href="mailto:support@aadyamed.com" style="color: #2563eb;">support@aadyamed.com</a></p>
    //           <p style="margin: 5px 0;">© ${new Date().getFullYear()} AADYAMED. All rights reserved.</p>
    //         </div>
    //       </div>
    //     `
    //   });
      
    //   console.log(`Verification email sent to ${user.email}`);
      
    // } catch (emailError) {
    //   console.error('Failed to send verification email:', emailError);
    //   // Continue even if email fails
    // }
    
    // Generate JWT token (for auto-login after verification)
    const token = generateToken(user._id);
    
    res.status(201).json({
      success: true,
      message: 'Registration successful! Please check your email to verify your account.',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        phone: user.phone,
        isVerified: user.isVerified,
        profileCompleted: user.profileCompleted,
        status: user.status
      }
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle specific MongoDB errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: errors.join(', ')
      });
    }
    
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        error: `An account with this ${field} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Registration failed. Please try again later.'
    });
  }
};

/**
 * @desc    Verify user email
 * @route   GET /api/auth/verify-email/:token
 * @access  Public
 */
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;
    
    // Hash the token
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
    
    // Find user with valid token
    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired verification link. Please request a new verification email.'
      });
    }
    
    // Update user verification status
    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();
    
    // Generate login token for auto-login
    const loginToken = generateToken(user._id);
    
    res.json({
      success: true,
      message: 'Email verified successfully!',
      token: loginToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isVerified: user.isVerified,
        profileCompleted: user.profileCompleted
      },
      nextStep: user.profileCompleted ? 'dashboard' : 'complete-profile'
    });
    
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Email verification failed. Please try again.'
    });
  }
};

/**
 * @desc    Resend verification email
 * @route   POST /api/auth/resend-verification
 * @access  Public
 */
exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }
    
    const user = await User.findOne({ email });
    
    // For security, don't reveal if user doesn't exist
    if (!user) {
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification link has been sent.'
      });
    }
    
    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        error: 'Email is already verified'
      });
    }
    
    // Generate new verification token
    const verificationToken = user.createEmailVerificationToken();
    await user.save();
    
    // Send verification email
    try {
      const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;
      
      await sendEmail({
        to: user.email,
        subject: 'Verify Your Email - AADYAMED',
        html: `<p>Click <a href="${verificationUrl}">here</a> to verify your email.</p>`
      });
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
    }
    
    res.json({
      success: true,
      message: 'Verification email sent successfully'
    });
    
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resend verification email'
    });
  }
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Please provide email and password'
      });
    }
    
    // Find user with password
    const user = await User.findByEmail(email, true);
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }
    
    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }
    
    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Your account has been deactivated. Please contact support.'
      });
    }
    
    // Check if email is verified
    // if (!user.isVerified) {
    //   return res.status(403).json({
    //     success: false,
    //     error: 'Please verify your email before logging in.',
    //     requiresVerification: true,
    //     email: user.email
    //   });
    // }
    
    // Update last login
    const clientIp = getClientIp(req);
    await user.updateLastLogin(clientIp);
    
    // Generate JWT token
    const token = generateToken(user._id);
    
    // Get profile if exists
    let profile = null;
    if (user.profileCompleted && user.profileId && user.profileModel) {
      try {
        profile = await mongoose.model(user.profileModel).findById(user.profileId);
      } catch (profileError) {
        console.error('Error fetching profile:', profileError);
      }
    }
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        phone: user.phone,
        isVerified: user.isVerified,
        profileCompleted: user.profileCompleted,
        profileId: user.profileId,
        status: user.status,
        preferences: user.preferences
      },
      profile,
      nextStep: user.profileCompleted ? null : 'complete-profile'
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed. Please try again.'
    });
  }
};

/**
 * @desc    Complete user profile
 * @route   POST /api/auth/complete-profile
 * @access  Private
 */
exports.completeProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = req.user;
    const profileData = req.body;
    
    // Check if profile already completed
    if (user.profileCompleted) {
      return res.status(400).json({
        success: false,
        error: 'Profile is already completed'
      });
    }
    
    let profile;
    let profileModel;
    
    switch(user.role) {
      case 'doctor':
        // Validate required doctor fields
        if (!profileData.licenseNumber || !profileData.consultationFee) {
          return res.status(400).json({
            success: false,
            error: 'License number and consultation fee are required'
          });
        }
        
        profile = await DoctorProfile.create({
          userId,
          name: user.name,
          email: user.email,
          contactNumber: user.phone,
          ...profileData,
          verificationStatus: 'pending'
        });
        profileModel = 'DoctorProfile';
        break;
        
      case 'physiotherapist':
        if (!profileData.licenseNumber || !profileData.consultationFee || !profileData.homeVisitFee) {
          return res.status(400).json({
            success: false,
            error: 'License number, consultation fee, and home visit fee are required'
          });
        }
        
        profile = await PhysiotherapistProfile.create({
          userId,
          name: user.name,
          email: user.email,
          contactNumber: user.phone,
          ...profileData,
          verificationStatus: 'pending'
        });
        profileModel = 'PhysiotherapistProfile';
        break;
        
      case 'patient':
        // Validate required patient fields
        if (!profileData.dateOfBirth || !profileData.gender) {
          return res.status(400).json({
            success: false,
            error: 'Date of birth and gender are required'
          });
        }
        
        profile = await PatientProfile.create({
          userId,
          name: user.name,
          email: user.email,
          phone: user.phone,
          ...profileData
        });
        profileModel = 'PatientProfile';
        break;
        
      case 'pathology':
        if (!profileData.labName) {
          return res.status(400).json({
            success: false,
            error: 'Lab name is required'
          });
        }
        
        profile = await PathologyProfile.create({
          userId,
          labName: profileData.labName,
          email: user.email,
          phone: user.phone,
          ...profileData,
          verificationStatus: 'pending'
        });
        profileModel = 'PathologyProfile';
        break;
        
      case 'pharmacy':
        const Pharmacy = require('../models/Pharmacy');
        
        if (!profileData.licenseNumber) {
          return res.status(400).json({
            success: false,
            error: 'Pharmacy license number is required'
          });
        }
        
        profile = await Pharmacy.create({
          userId,
          name: profileData.pharmacyName || user.name,
          licenseNumber: profileData.licenseNumber,
          email: user.email,
          phone: user.phone,
          address: profileData.address
        });
        profileModel = 'Pharmacy';
        break;
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid user role'
        });
    }
    
    // Update user with profile information
    user.profileCompleted = true;
    user.profileId = profile._id;
    user.profileModel = profileModel;
    await user.save();
    
    // Send notification to admin for professional verification
    if (['doctor', 'physiotherapist', 'pathology'].includes(user.role)) {
      // Here you can trigger admin notification
      console.log(`New ${user.role} profile submitted for verification: ${profile._id}`);
      
      // Send email to admin
      try {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: `New ${user.role} Profile Needs Verification`,
          html: `
            <p>A new ${user.role} profile has been submitted for verification.</p>
            <p><strong>Name:</strong> ${user.name}</p>
            <p><strong>Email:</strong> ${user.email}</p>
            <p><strong>Phone:</strong> ${user.phone}</p>
            <p>Please review and verify the profile in the admin panel.</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send admin notification:', emailError);
      }
    }
    
    res.json({
      success: true,
      message: 'Profile completed successfully',
      profile,
      nextSteps: getNextSteps(user.role, profile.verificationStatus)
    });
    
  } catch (error) {
    console.error('Complete profile error:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: errors.join(', ')
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to complete profile. Please try again.'
    });
  }
};

/**
 * @desc    Get profile completion status
 * @route   GET /api/auth/profile-status
 * @access  Private
 */
exports.getProfileStatus = async (req, res) => {
  try {
    const user = req.user;
    
    let profile = null;
    let verificationStatus = null;
    
    if (user.profileCompleted && user.profileId && user.profileModel) {
      try {
        profile = await mongoose.model(user.profileModel).findById(user.profileId);
        
        // Get verification status for professionals
        if (['doctor', 'physiotherapist', 'pathology'].includes(user.role)) {
          verificationStatus = profile.verificationStatus;
        }
      } catch (profileError) {
        console.error('Error fetching profile:', profileError);
      }
    }
    
    res.json({
      success: true,
      profileCompleted: user.profileCompleted,
      role: user.role,
      verificationStatus,
      profile,
      requiresProfileCompletion: !user.profileCompleted,
      requiresVerification: ['doctor', 'physiotherapist', 'pathology'].includes(user.role) && 
                           verificationStatus !== 'approved'
    });
    
  } catch (error) {
    console.error('Get profile status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get profile status'
    });
  }
};

/**
 * @desc    Update user profile
 * @route   PUT /api/auth/profile
 * @access  Private
 */
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = req.user;
    const updates = req.body;
    
    // Check if profile exists
    if (!user.profileCompleted || !user.profileId || !user.profileModel) {
      return res.status(400).json({
        success: false,
        error: 'Please complete your profile first'
      });
    }
    
    let profile;
    
    switch(user.profileModel) {
      case 'DoctorProfile':
        profile = await DoctorProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      case 'PhysiotherapistProfile':
        profile = await PhysiotherapistProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      case 'PatientProfile':
        profile = await PatientProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      case 'PathologyProfile':
        profile = await PathologyProfile.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      case 'Pharmacy':
        const Pharmacy = require('../models/Pharmacy');
        profile = await Pharmacy.findOneAndUpdate(
          { userId },
          updates,
          { new: true, runValidators: true }
        );
        break;
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid profile type'
        });
    }
    
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      profile
    });
    
  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: errors.join(', ')
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
};

/**
 * @desc    Forgot password
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Please provide your email address'
      });
    }
    
    const user = await User.findOne({ email });
    
    // Don't reveal if user exists (security)
    if (!user) {
      return res.json({
        success: true,
        message: 'If an account exists with this email, you will receive a password reset link.'
      });
    }
    
    // Generate reset token
    const resetToken = user.createPasswordResetToken();
    await user.save();
    
    // Send reset email
    try {
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
      
      await sendEmail({
        to: user.email,
        subject: 'Reset Your Password - AADYAMED',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h3>Password Reset Request</h3>
            <p>You requested to reset your password. Click the button below to set a new password:</p>
            <p style="margin: 30px 0;">
              <a href="${resetUrl}" 
                 style="background-color: #dc2626; color: white; padding: 12px 24px; 
                        text-decoration: none; border-radius: 5px; display: inline-block;">
                Reset Password
              </a>
            </p>
            <p>Or copy this link:</p>
            <p style="color: #666; word-break: break-all;">${resetUrl}</p>
            <p>This link will expire in 10 minutes.</p>
            <p>If you didn't request a password reset, please ignore this email.</p>
          </div>
        `
      });
    } catch (emailError) {
      console.error('Failed to send reset email:', emailError);
    }
    
    res.json({
      success: true,
      message: 'Password reset email sent if account exists'
    });
    
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process password reset request'
    });
  }
};

/**
 * @desc    Reset password
 * @route   POST /api/auth/reset-password/:token
 * @access  Public
 */
exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    
    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }
    
    // Hash the token
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
    
    // Find user with valid token
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token'
      });
    }
    
    // Update password
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    
    res.json({
      success: true,
      message: 'Password reset successful. You can now login with your new password.'
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset password'
    });
  }
};

/**
 * @desc    Change password (authenticated user)
 * @route   PUT /api/auth/change-password
 * @access  Private
 */
exports.changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Please provide current and new password'
      });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 6 characters'
      });
    }
    
    // Get user with password
    const user = await User.findById(userId).select('+password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }
    
    // Update password
    user.password = newPassword;
    await user.save();
    
    res.json({
      success: true,
      message: 'Password changed successfully'
    });
    
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
};

/**
 * @desc    Get current user
 * @route   GET /api/auth/me
 * @access  Private
 */
exports.getCurrentUser = async (req, res) => {
  try {
    const user = req.user;
    
    let profile = null;
    if (user.profileCompleted && user.profileId && user.profileModel) {
      try {
        profile = await mongoose.model(user.profileModel).findById(user.profileId);
      } catch (profileError) {
        console.error('Error fetching profile:', profileError);
      }
    }
    
    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        phone: user.phone,
        isVerified: user.isVerified,
        profileCompleted: user.profileCompleted,
        profileId: user.profileId,
        profileModel: user.profileModel,
        status: user.status,
        preferences: user.preferences,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      },
      profile
    });
    
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user information'
    });
  }
};

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 */
exports.logout = async (req, res) => {
  try {
    // In a real application, you might want to:
    // 1. Invalidate the token (if using token blacklisting)
    // 2. Clear device token for push notifications
    // 3. Log the logout event
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
    
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed'
    });
  }
};

// ========== HELPER FUNCTIONS ==========

function getNextSteps(role, verificationStatus = null) {
  const baseSteps = {
    doctor: [
      verificationStatus === 'pending' 
        ? 'Wait for admin verification (24-48 hours)' 
        : 'Your profile is being reviewed',
      'Set your availability schedule',
      'Add your bank details for payouts'
    ],
    physiotherapist: [
      verificationStatus === 'pending' 
        ? 'Wait for admin verification' 
        : 'Your profile is being reviewed',
      'Set your service areas and availability',
      'Complete bank details for payouts'
    ],
    patient: [
      'Add your medical history (optional)',
      'Book your first appointment',
      'Set your notification preferences'
    ],
    pathology: [
      verificationStatus === 'pending' 
        ? 'Wait for admin verification' 
        : 'Your profile is being reviewed',
      'Add test services and pricing',
      'Set up test slots and availability'
    ],
    pharmacy: [
      'Add medicine inventory',
      'Set up supplier information',
      'Configure pharmacy settings'
    ]
  };
  
  return baseSteps[role] || ['Complete your profile setup'];
}