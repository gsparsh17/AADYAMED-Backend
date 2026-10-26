const crypto = require('crypto');
const User = require('../models/User');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PatientProfile = require('../models/PatientProfile');
const PathologyProfile = require('../models/PathologyProfile');
const PharmacyProfile = require('../models/PharmacyProfile');
const MRProfile = require('../models/MRProfile');
const { generateToken }= require('../utils/generateToken');
const otpService = require('../services/otp.service');
const sendEmail = require('../utils/sendEmail');
const { default: mongoose } = require('mongoose');
const { provisionPharmacyTenant } = require('../services/pharmacyTenant.service');


async function sendVerificationEmail(user, verificationToken) {
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '');
  if (!frontendUrl) {
    console.warn('Verification email not sent: FRONTEND_URL is not configured');
    return false;
  }

  const verificationUrl = `${frontendUrl}/verify-email/${verificationToken}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify Your Email - AadyaPlus',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to AadyaPlus</h2>
        <p>Hello ${user.name},</p>
        <p>Please verify your email address to finish setting up your account.</p>
        <p><a href="${verificationUrl}">Verify email address</a></p>
        <p>This verification link expires in 24 hours.</p>
      </div>
    `,
  });
  return true;
}

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
  const validRoles = ['doctor', 'physio', 'patient', 'pathology', 'pharmacy'];
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
    // When the app signs a user up from the OTP screen it passes the token
    // issued at verify time. Redeeming it here is what makes the phone
    // trustworthy — and redeeming is single-use, so one verified number
    // cannot be spun into many accounts.
    if (req.body.verificationToken) {
      const ok = await otpService.consumeVerification({
        phone: req.body.phone,
        verificationToken: req.body.verificationToken,
        purpose: 'signup',
      });
      if (!ok) {
        return res.status(401).json({ success: false, error: 'Phone verification has expired. Verify your number again.' });
      }
      req.body.phone = otpService.normalisePhone(req.body.phone);
      req.body.phoneVerified = true;

      // Refuse to add a second account to a number that already has one:
      // that is exactly how the ambiguous rows already in the database were
      // created, and each one permanently locks that number out of OTP login.
      const taken = await User.exists({ phone: req.body.phone });
      if (taken) {
        return res.status(409).json({ success: false, error: 'An account already exists for this mobile number. Sign in instead.' });
      }
    }

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
    const verificationToken = user.createEmailVerificationToken();
    await user.save();
    
    // Send the initial verification email. Registration still succeeds if the
    // mail provider is temporarily unavailable; resend-verification can retry.
    let verificationEmailSent = false;
    try {
      verificationEmailSent = await sendVerificationEmail(user, verificationToken);
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError.message);
    }

    // Generate JWT token (for auto-login after verification)
    const token = generateToken(user._id);
    
    res.status(201).json({
      success: true,
      message: verificationEmailSent
        ? 'Registration successful! Please check your email to verify your account.'
        : 'Registration successful. Verification email could not be sent; please use resend verification.',
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
      await sendVerificationEmail(user, verificationToken);
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError.message);
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
// ===== Helper: resolve profile by userId (even if user.profileId is missing) =====
async function resolveProfileForUser(user) {
  // If already linked properly, use it
  if (user.profileId && user.profileModel) {
    try {
      const doc = await mongoose.model(user.profileModel).findById(user.profileId);
      return doc ? { profile: doc, profileId: doc._id, profileModel: user.profileModel } : null;
    } catch (e) {
      // fall through to scanning collections
      console.error('resolveProfileForUser: linked profile fetch failed:', e);
    }
  }

  const userId = user._id;

  // Role-first lookup (fast path)
  const roleToModel = {
    doctor: { Model: DoctorProfile, modelName: 'DoctorProfile' },
    physio: { Model: PhysiotherapistProfile, modelName: 'PhysiotherapistProfile' },
    patient: { Model: PatientProfile, modelName: 'PatientProfile' },
    pathology: { Model: PathologyProfile, modelName: 'PathologyProfile' },
    // pharmacy is required lazily because you required it elsewhere too
    pharmacy: { Model: PharmacyProfile, modelName: 'PharmacyProfile' },
    mr: { Model: MRProfile, modelName: 'MRProfile' }
  };

  const primary = roleToModel[user.role];
  if (primary?.Model) {
    const found = await primary.Model.findOne({ userId });
    if (found) return { profile: found, profileId: found._id, profileModel: primary.modelName };
  }

  // Fallback scan (covers mismatched role data / migrated users)
  const scanModels = [
    { Model: DoctorProfile, modelName: 'DoctorProfile' },
    { Model: PhysiotherapistProfile, modelName: 'PhysiotherapistProfile' },
    { Model: PatientProfile, modelName: 'PatientProfile' },
    { Model: PathologyProfile, modelName: 'PathologyProfile' },
    { Model: PharmacyProfile, modelName: 'PharmacyProfile' },
    { Model: MRProfile, modelName: 'MRProfile' }
  ];

  for (const m of scanModels) {
    try {
      const found = await m.Model.findOne({ userId });
      if (found) return { profile: found, profileId: found._id, profileModel: m.modelName };
    } catch (e) {
      console.error(`resolveProfileForUser: scan failed for ${m.modelName}:`, e);
    }
  }

  return null;
}

/**
 * The single account a phone number identifies.
 *
 * `phone` is required on User but **not unique**, and real data already has
 * numbers shared by several accounts. Signing in "the" user for such a number
 * would mean `findOne` picking one arbitrarily — a doctor could land in a
 * pharmacy's dashboard. So an ambiguous number is refused outright rather
 * than resolved by luck.
 */
async function resolveUserByPhone(phone) {
  const matches = await User.find({ phone }).limit(2);
  if (matches.length > 1) {
    const error = new Error(
      'Several accounts use this mobile number, so it cannot be used to sign in. Please sign in with your email and password, or contact support.',
    );
    error.statusCode = 409;
    throw error;
  }
  return matches[0] || null;
}

/**
 * Phone + OTP authentication.
 *
 * Sign-in and sign-up share one challenge flow but stay separate purposes, so
 * a code issued to sign in cannot be replayed to create an account.
 */
exports.sendLoginOtp = async (req, res) => {
  try {
    const phone = otpService.normalisePhone(req.body.phone);
    if (!phone) return res.status(400).json({ success: false, error: 'Enter a valid 10-digit mobile number' });

    const existing = await resolveUserByPhone(phone);
    const purpose = existing ? 'login' : 'signup';

    // The response says which flow the caller is in, so the app can go
    // straight to "create your account" instead of failing at verify time.
    // It does not say whether the *account* exists in any other terms, which
    // is the same thing any OTP login discloses by necessity.
    if (existing && existing.isActive === false) {
      return res.status(403).json({ success: false, error: 'Your account has been deactivated. Please contact support.' });
    }

    const result = await otpService.sendOtp({ phone, purpose, ip: getClientIp(req) });
    res.json({ success: true, purpose, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

/**
 * Verifies the code. An existing user is signed straight in; a new number gets
 * a single-use `verificationToken` to hand to the register call.
 */
exports.verifyLoginOtp = async (req, res) => {
  try {
    const phone = otpService.normalisePhone(req.body.phone);
    if (!phone) return res.status(400).json({ success: false, error: 'Enter a valid 10-digit mobile number' });

    const existing = await resolveUserByPhone(phone);
    const purpose = existing ? 'login' : 'signup';
    const verified = await otpService.verifyOtp({ phone, code: req.body.code, purpose });

    if (!existing) {
      // Nothing is created here — the account is made by /register, which
      // needs a name, role and profile details this endpoint does not have.
      return res.json({
        success: true,
        registered: false,
        phone,
        verificationToken: verified.verificationToken,
        nextStep: 'register',
      });
    }

    if (existing.isActive === false) {
      return res.status(403).json({ success: false, error: 'Your account has been deactivated. Please contact support.' });
    }

    await existing.updateLastLogin(getClientIp(req));
    const token = generateToken(existing._id);
    const resolved = await resolveProfileForUser(existing);
    const resolvedProfileId = resolved?.profileId || existing.profileId || null;
    const resolvedProfileModel = resolved?.profileModel || existing.profileModel || null;

    if (resolved && (!existing.profileId || String(existing.profileId) !== String(resolvedProfileId))) {
      existing.profileId = resolvedProfileId;
      existing.profileModel = resolvedProfileModel;
      existing.profileCompleted = true;
      await existing.save();
    }

    res.json({
      success: true,
      registered: true,
      token,
      user: {
        id: existing._id,
        email: existing.email,
        name: existing.name,
        role: existing.role,
        phone: existing.phone,
        isVerified: existing.isVerified,
        profileCompleted: !!resolvedProfileId,
        profileId: resolvedProfileId,
        profileModel: resolvedProfileModel,
        status: existing.status,
        preferences: existing.preferences,
        organizationId: existing.organizationId || null,
        organizationRole: existing.organizationRole || null,
        pharmacyStoreIds: existing.pharmacyStoreIds || [],
        defaultPharmacyStoreId: existing.defaultPharmacyStoreId || null,
      },
      profile: resolved?.profile || null,
      nextStep: resolvedProfileId ? null : 'complete-profile',
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

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

    // Update last login
    const clientIp = getClientIp(req);
    await user.updateLastLogin(clientIp);

    // Generate JWT token
    const token = generateToken(user._id);

    // ===== NEW: Resolve profileId/profileModel by userId if missing =====
    let resolvedProfile = null;
    let resolvedProfileId = user.profileId || null;
    let resolvedProfileModel = user.profileModel || null;

    resolvedProfile = await resolveProfileForUser(user);

    if (resolvedProfile) {
      resolvedProfileId = resolvedProfile.profileId;
      resolvedProfileModel = resolvedProfile.profileModel;

      // Optional but recommended: sync User doc if not already linked
      const needsSync =
        !user.profileId ||
        !user.profileModel ||
        String(user.profileId) !== String(resolvedProfileId) ||
        user.profileModel !== resolvedProfileModel ||
        user.profileCompleted !== true;

      if (needsSync) {
        user.profileId = resolvedProfileId;
        user.profileModel = resolvedProfileModel;
        user.profileCompleted = true;
        await user.save();
      }
    }

    // Return profile payload as before (now includes resolved profile even if profileCompleted was false)
    const profile = resolvedProfile?.profile || null;

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

        // IMPORTANT: these are now always resolved if profile exists
        profileCompleted: !!resolvedProfileId,
        profileId: resolvedProfileId,
        profileModel: resolvedProfileModel,

        status: user.status,
        preferences: user.preferences,
        organizationId: user.organizationId || null,
        organizationRole: user.organizationRole || null,
        pharmacyStoreIds: user.pharmacyStoreIds || [],
        defaultPharmacyStoreId: user.defaultPharmacyStoreId || null,
        fieldRole: user.role === 'mr' ? (profile?.designation || null) : null,
        fieldEmployeeCode: user.role === 'mr' ? (profile?.employeeCode || null) : null
      },
      profile,
      nextStep: resolvedProfileId ? null : 'complete-profile'
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
        
      case 'physio':
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
        if (!profileData.licenseNumber) {
          return res.status(400).json({
            success: false,
            error: 'Pharmacy license number is required'
          });
        }

        profile = await PharmacyProfile.create({
          ...profileData,
          userId,
          pharmacyName: profileData.pharmacyName || user.name,
          licenseNumber: profileData.licenseNumber,
          email: user.email,
          phone: profileData.phone || user.phone
        });
        profileModel = 'PharmacyProfile';
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

    // Pharmacy profiles immediately get an organization + default store. This keeps
    // old one-pharmacy accounts compatible while enabling branch-level isolation.
    let pharmacyTenant = null;
    if (user.role === 'pharmacy') {
      pharmacyTenant = await provisionPharmacyTenant(user, profile);
    }
    
    // Send notification to admin for professional verification
    if (['doctor', 'physio', 'pathology'].includes(user.role)) {
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
      ...(pharmacyTenant ? { organization: pharmacyTenant.organization, defaultStore: pharmacyTenant.store } : {}),
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
        if (['doctor', 'physio', 'pathology'].includes(user.role)) {
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
      requiresVerification: ['doctor', 'physio', 'pathology'].includes(user.role) && 
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

    // This endpoint is reachable by any authenticated professional — never
    // let client input touch admin-controlled/financial/computed fields
    // (mass-assignment: without this, a doctor could PUT
    // { verificationStatus: 'approved', commissionRate: 0 } and self-approve).
    [
      'userId', 'verificationStatus', 'adminNotes', 'verifiedAt', 'verifiedBy',
      'totalEarnings', 'totalConsultations', 'totalTestsConducted', 'averageRating',
      'totalReviews', 'pendingCommission', 'paidCommission', 'commissionRate',
      'isActive'
    ].forEach((key) => delete updates[key]);

    let profile;

    switch(user.profileModel) {
      case 'DoctorProfile':
        profile = await DoctorProfile.findOneAndUpdate(
          { userId },
          { $set: updates },
          { new: true, runValidators: true }
        );
        break;
      case 'PhysiotherapistProfile':
        profile = await PhysiotherapistProfile.findOneAndUpdate(
          { userId },
          { $set: updates },
          { new: true, runValidators: true }
        );
        break;
      case 'PatientProfile': {
        // A patient edits their name here; the phone is the sign-in identity
        // (changed only with a fresh OTP) and health details go through
        // /patient/profile. The account's name is kept in step so the next
        // sign-in shows the new one.
        const name = typeof updates.name === 'string' ? updates.name.trim() : '';
        if (name.length < 2) {
          return res.status(400).json({ success: false, error: 'Name must be at least 2 characters' });
        }
        const parts = name.split(/\s+/);
        profile = await PatientProfile.findOneAndUpdate(
          { userId },
          { $set: { name, firstName: parts[0], lastName: parts.slice(1).join(' ') } },
          { new: true, runValidators: true }
        );
        await User.updateOne({ _id: userId }, { $set: { name } });
        break;
      }
      case 'PathologyProfile':
        profile = await PathologyProfile.findOneAndUpdate(
          { userId },
          { $set: updates },
          { new: true, runValidators: true }
        );
        break;
      case 'PharmacyProfile':
        profile = await PharmacyProfile.findOneAndUpdate(
          { userId },
          { $set: updates },
          { new: true, runValidators: true }
        );
        break;
      case 'MRProfile':
        // Reporting hierarchy, designation and territory assignment are managed
        // through /api/mr. Only non-hierarchy self-service fields are editable here.
        profile = await MRProfile.findOneAndUpdate(
          { userId },
          { $set: {
            ...(updates.productLine !== undefined ? { productLine: updates.productLine } : {}),
            ...(updates.notes !== undefined ? { notes: updates.notes } : {})
          } },
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
        subject: 'Reset Your Password - AadyaPlus',
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
/**
 * @desc    Save the signed-in user's app preferences (notification channels,
 *          language).
 * @route   PUT /api/auth/preferences
 * @access  Private
 */
exports.updatePreferences = async (req, res) => {
  try {
    const set = {};
    const n = req.body?.notifications || {};
    for (const channel of ['email', 'sms', 'push']) {
      if (typeof n[channel] === 'boolean') set[`preferences.notifications.${channel}`] = n[channel];
    }
    if (typeof req.body?.language === 'string' && /^[a-z]{2}$/.test(req.body.language)) {
      set['preferences.language'] = req.body.language;
    }
    const user = await User.findByIdAndUpdate(req.user.id, { $set: set }, { new: true }).select('preferences');
    res.json({ success: true, preferences: user?.preferences || {} });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Couldn’t save your preferences' });
  }
};

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