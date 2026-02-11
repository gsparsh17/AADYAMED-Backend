const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  // Basic Information
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  
  // Role Management
  role: {
    type: String,
    enum: ['admin', 'doctor', 'physiotherapist', 'patient', 'pathology', 'pharmacy'],
    required: [true, 'Role is required'],
    default: 'patient'
  },
  
  // Basic Profile Info (collected during registration)
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    match: [/^[0-9]{10}$/, 'Please enter a valid 10-digit phone number']
  },
  
  // Account Status
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  profileCompleted: {
    type: Boolean,
    default: false
  },
  
  profileId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'profileModel'

  },
  profileModel: {
    type: String,
    enum: ['DoctorProfile', 'PhysiotherapistProfile', 'PatientProfile', 'PathologyProfile', 'Pharmacy', null],
    default: null
  },
  
  // Verification Tokens
  emailVerificationToken: String,
  emailVerificationExpires: Date,
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  
  // Device & Session Management
  deviceToken: String,
  lastLogin: Date,
  lastIp: String,
  loginCount: {
    type: Number,
    default: 0
  },
  
  // Preferences
  preferences: {
    language: {
      type: String,
      default: 'en'
    },
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'light'
    },
    notifications: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      push: { type: Boolean, default: true }
    }
  },
  
  // Metadata
  registrationSource: {
    type: String,
    enum: ['web', 'mobile', 'admin'],
    default: 'web'
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ createdAt: -1 });

// Hash password before saving
userSchema.pre('save', async function(next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Update last login timestamp
userSchema.methods.updateLastLogin = function(ipAddress) {
  this.lastLogin = new Date();
  this.lastIp = ipAddress;
  this.loginCount += 1;
  return this.save();
};

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate password reset token
userSchema.methods.createPasswordResetToken = function() {
  const resetToken = crypto.randomBytes(32).toString('hex');
  
  this.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
    
  this.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes
  
  return resetToken;
};

// Generate email verification token
userSchema.methods.createEmailVerificationToken = function() {
  const verificationToken = crypto.randomBytes(32).toString('hex');
  
  this.emailVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');
    
  this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  
  return verificationToken;
};

// Virtual for user status
userSchema.virtual('status').get(function() {
  if (!this.isActive) return 'inactive';
  if (!this.isVerified) return 'unverified';
  if (!this.profileCompleted) return 'profile_incomplete';
  return 'active';
});

// Method to deactivate account
userSchema.methods.deactivate = function() {
  this.isActive = false;
  return this.save();
};

// Method to activate account
userSchema.methods.activate = function() {
  this.isActive = true;
  return this.save();
};

// Static method to find by email (with password for login)
userSchema.statics.findByEmail = function(email, includePassword = false) {
  const query = this.findOne({ email });
  if (includePassword) {
    return query.select('+password');
  }
  return query;
};

const User = mongoose.model('User', userSchema);

module.exports = User;