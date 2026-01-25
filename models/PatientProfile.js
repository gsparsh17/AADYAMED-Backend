const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema({
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  
  // Patient identification
  patientId: {
    type: String,
    unique: true,
    index: true
  },
  
  // Personal information
  name: {
    type: String,
    required: [true, 'Patient name is required'],
    trim: true
  },
  salutation: {
    type: String,
    enum: ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.', 'Prof.', 'Baby', 'Master'],
    default: 'Mr.'
  },
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true
  },
  middleName: {
    type: String,
    trim: true
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    match: [/^[0-9]{10}$/, 'Please enter a valid 10-digit phone number']
  },
  alternatePhone: {
    type: String
  },
  
  // Demographics
  gender: {
    type: String,
    enum: ['male', 'female', 'other', 'prefer_not_to_say'],
    required: [true, 'Gender is required']
  },
  dateOfBirth: {
    type: Date,
    required: [true, 'Date of birth is required']
  },
  age: {
    type: Number,
    min: 0,
    max: 120
  },
  
  // Address
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    country: {
      type: String,
      default: 'India'
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0]
      }
    }
  },
  
  // Medical information
  bloodGroup: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown', ''],
    default: 'Unknown'
  },
  height: {
    type: Number, // in cm
    min: 0,
    max: 300
  },
  weight: {
    type: Number, // in kg
    min: 0,
    max: 300
  },
  bmi: {
    type: Number,
    min: 0,
    max: 100
  },
  
  // Medical records
  medicalHistory: [{
    condition: {
      type: String,
      required: true
    },
    diagnosedDate: Date,
    status: {
      type: String,
      enum: ['active', 'resolved', 'chronic', 'in_treatment'],
      default: 'active'
    },
    severity: {
      type: String,
      enum: ['mild', 'moderate', 'severe']
    },
    notes: String,
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  allergies: [{
    allergen: {
      type: String,
      required: true
    },
    reaction: String,
    severity: {
      type: String,
      enum: ['mild', 'moderate', 'severe', 'life_threatening'],
      default: 'mild'
    },
    firstObserved: Date,
    notes: String,
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  currentMedications: [{
    medicineName: {
      type: String,
      required: true
    },
    dosage: String,
    frequency: String,
    prescribedBy: String,
    startDate: Date,
    endDate: Date,
    purpose: String,
    notes: String,
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  chronicConditions: [{
    condition: String,
    diagnosedDate: Date,
    currentStatus: String,
    managingDoctor: String,
    lastCheckup: Date,
    notes: String,
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Emergency contact
  emergencyContact: {
    name: String,
    relationship: String,
    phone: String,
    email: String,
    address: String
  },
  
  // Insurance
  insuranceProvider: String,
  insurancePolicyNumber: String,
  insuranceValidity: Date,
  
  // Government IDs
  aadhaarNumber: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v) return true; // Allow empty
        return /^\d{12}$/.test(v);
      },
      message: 'Aadhaar number must be 12 digits'
    }
  },
  panNumber: String,
  
  // Preferences
  preferences: {
    consultationType: {
      type: String,
      enum: ['clinic', 'home', 'video'],
      default: 'clinic'
    },
    preferredLanguage: {
      type: String,
      default: 'English'
    },
    notificationPreferences: {
      email: {
        type: Boolean,
        default: true
      },
      sms: {
        type: Boolean,
        default: true
      },
      push: {
        type: Boolean,
        default: true
      }
    },
    reminderPreferences: {
      appointmentReminders: {
        type: Boolean,
        default: true
      },
      medicationReminders: {
        type: Boolean,
        default: false
      }
    }
  },
  
  // Images
  profileImage: String,
  medicalDocuments: [{
    documentType: String,
    documentUrl: String,
    uploadedAt: Date,
    uploadedBy: mongoose.Schema.Types.ObjectId
  }],
  
  // Statistics
  totalAppointments: {
    type: Number,
    default: 0
  },
  totalPrescriptions: {
    type: Number,
    default: 0
  },
  totalLabTests: {
    type: Number,
    default: 0
  },
  lastConsultation: Date,
  
  // Timestamps
  registeredAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: Date
  
}, {
  timestamps: true
});

// Generate structured patient ID for referral platform
function generatePatientId(firstName, lastName, phone) {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  
  // Format: PAT-NAMEPHONE-DDMMYY-RAND
  const namePart = (firstName.substring(0, 3) + lastName.substring(0, 1)).toUpperCase();
  const phonePart = phone.slice(-4);
  
  return `PAT-${namePart}${phonePart}-${day}${month}${year}-${random}`;
}

// Calculate age from dateOfBirth
patientSchema.methods.calculateAge = function() {
  if (!this.dateOfBirth) return null;
  
  const today = new Date();
  const birthDate = new Date(this.dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  
  return age;
};

// Calculate BMI
patientSchema.methods.calculateBMI = function() {
  if (!this.height || !this.weight) return null;
  
  const heightInMeters = this.height / 100;
  return this.weight / (heightInMeters * heightInMeters);
};

// Pre-save middleware
patientSchema.pre('save', async function(next) {
  try {
    // Calculate age if dateOfBirth is set
    if (this.dateOfBirth && !this.age) {
      this.age = this.calculateAge();
    }
    
    // Calculate BMI if height and weight are set
    if (this.height && this.weight && !this.bmi) {
      this.bmi = this.calculateBMI();
    }
    
    // Update timestamp
    this.updatedAt = new Date();
    
    // Generate patient ID if not exists
    if (!this.patientId) {
      // Check for existing patient with same details
      const existingPatient = await this.constructor.findOne({
        firstName: this.firstName,
        lastName: this.lastName,
        phone: this.phone
      });
      
      if (existingPatient && existingPatient._id.toString() !== this._id.toString()) {
        // Use existing patient ID
        this.patientId = existingPatient.patientId;
      } else {
        // Generate new patient ID with retry logic
        let patientId;
        let attempts = 0;
        const maxAttempts = 5;
        
        do {
          patientId = generatePatientId(
            this.firstName,
            this.lastName,
            this.phone
          );
          attempts++;
          
          const exists = await this.constructor.findOne({ patientId });
          if (!exists) break;
          
          if (attempts >= maxAttempts) {
            throw new Error('Could not generate unique patient ID');
          }
        } while (true);
        
        this.patientId = patientId;
      }
    }
    
    // Set full name
    if (this.firstName && this.lastName && !this.name) {
      this.name = `${this.firstName} ${this.lastName}`.trim();
    }
    
    next();
  } catch (error) {
    next(error);
  }
});

// Virtual for formatted age
patientSchema.virtual('formattedAge').get(function() {
  if (!this.age) return null;
  
  if (this.age < 1) {
    // Calculate months
    const birthDate = new Date(this.dateOfBirth);
    const today = new Date();
    const months = (today.getFullYear() - birthDate.getFullYear()) * 12 + 
                   (today.getMonth() - birthDate.getMonth());
    return `${months} month${months !== 1 ? 's' : ''}`;
  }
  
  return `${this.age} year${this.age !== 1 ? 's' : ''}`;
});

// Virtual for address string
patientSchema.virtual('fullAddress').get(function() {
  if (!this.address) return '';
  
  const parts = [];
  if (this.address.street) parts.push(this.address.street);
  if (this.address.city) parts.push(this.address.city);
  if (this.address.state) parts.push(this.address.state);
  if (this.address.pincode) parts.push(this.address.pincode);
  
  return parts.join(', ');
});

// Method to add medical record
patientSchema.methods.addMedicalRecord = function(recordType, data, addedBy) {
  const record = {
    ...data,
    addedBy: addedBy || this.userId,
    addedAt: new Date()
  };
  
  switch(recordType) {
    case 'medicalHistory':
      this.medicalHistory.push(record);
      break;
    case 'allergy':
      this.allergies.push(record);
      break;
    case 'medication':
      this.currentMedications.push(record);
      break;
    case 'condition':
      this.chronicConditions.push(record);
      break;
    default:
      throw new Error(`Invalid record type: ${recordType}`);
  }
  
  return this.save();
};

// Method to update appointment statistics
patientSchema.methods.updateAppointmentStats = function() {
  return this.model('Appointment').countDocuments({ patientId: this._id })
    .then(count => {
      this.totalAppointments = count;
      return this.model('Appointment').findOne(
        { patientId: this._id, status: 'completed' },
        { appointmentDate: 1 },
        { sort: { appointmentDate: -1 } }
      ).then(latest => {
        this.lastConsultation = latest ? latest.appointmentDate : null;
        return this.save();
      });
    });
};

// Create indexes
patientSchema.index({ patientId: 1 });
patientSchema.index({ userId: 1 });
patientSchema.index({ phone: 1 });
patientSchema.index({ email: 1 });
patientSchema.index({ 'address.location': '2dsphere' });
patientSchema.index({ name: 'text', phone: 'text', email: 'text' });

const PatientProfile = mongoose.model('PatientProfile', patientSchema);

module.exports = PatientProfile;