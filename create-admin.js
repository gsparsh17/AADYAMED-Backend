// scripts/create-admin.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Import User model (adjust path as needed)
const User = require('./models/User');

// Connect to database function (similar to your connectDB pattern)
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ DB Connection Failed:', error.message);
    process.exit(1);
  }
};

// Admin user data
const adminData = {
  email: 'admin@aadyaplus.com',
  password: 'Admin@123', // Change this to your desired password
  role: 'admin',
  name: 'System Administrator',
  phone: '9999999999',
  isVerified: true,
  isActive: true,
  profileCompleted: true,
  profileId: null,
  profileModel: null,
  preferences: {
    language: 'en',
    theme: 'light',
    notifications: {
      email: true,
      sms: true,
      push: true
    }
  },
  registrationSource: 'admin'
};

// Create admin user
const createAdmin = async () => {
  try {
    // 1. Connect to database
    await connectDB();
    
    // 2. Check if admin already exists
    const existingAdmin = await User.findOne({ 
      email: adminData.email,
      role: 'admin'
    });
    
    if (existingAdmin) {
      console.log('⚠️ Admin user already exists with email:', adminData.email);
      console.log('Admin details:', {
        id: existingAdmin._id,
        email: existingAdmin.email,
        name: existingAdmin.name,
        role: existingAdmin.role
      });
      
      // Optional: Update existing admin password
      const shouldUpdate = process.argv.includes('--update');
      if (shouldUpdate) {
        existingAdmin.password = adminData.password;
        await existingAdmin.save();
        console.log('✅ Admin password updated successfully');
      }
      
      await mongoose.connection.close();
      console.log('📡 Database connection closed');
      return;
    }
    
    // 3. Create new admin user (password will be auto-hashed by the model's pre-save hook)
    const admin = await User.create(adminData);
    
    console.log('✅ Admin user created successfully!');
    console.log('\n📋 Admin Details:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`ID:       ${admin._id}`);
    console.log(`Email:    ${admin.email}`);
    console.log(`Password: ${adminData.password} (change after first login)`);
    console.log(`Name:     ${admin.name}`);
    console.log(`Role:     ${admin.role}`);
    console.log(`Phone:    ${admin.phone}`);
    console.log(`Verified: ${admin.isVerified ? 'Yes' : 'No'}`);
    console.log(`Active:   ${admin.isActive ? 'Yes' : 'No'}`);
    console.log(`Created:  ${admin.createdAt}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log('🔑 Login Credentials:');
    console.log(`   Email:    ${admin.email}`);
    console.log(`   Password: ${adminData.password}`);
    console.log('\n⚠️  IMPORTANT: Change this password after first login!\n');
    
  } catch (error) {
    console.error('❌ Error creating admin user:', error.message);
    
    // Handle specific MongoDB errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      console.error(`⚠️  Duplicate key error: ${field} already exists`);
    } else if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      console.error('Validation errors:', errors.join(', '));
    }
    
  } finally {
    // 4. Close database connection
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log('📡 Database connection closed');
    }
    
    process.exit(0);
  }
};

// Check if script is run directly
if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  // Help command
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🔧 Admin User Creation Script
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage: node scripts/create-admin.js [options]

Options:
  --help, -h     Show this help message
  --update       Update existing admin password
  --email=<email> Set custom admin email
  --password=<pwd> Set custom password
  --name=<name>   Set custom admin name

Examples:
  node scripts/create-admin.js
  node scripts/create-admin.js --update
  node scripts/create-admin.js --email=superadmin@aadyaplus.com --password=SecurePass123
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
    process.exit(0);
  }
  
  // Customize admin data from command line arguments
  args.forEach(arg => {
    if (arg.startsWith('--email=')) {
      adminData.email = arg.split('=')[1];
    }
    if (arg.startsWith('--password=')) {
      adminData.password = arg.split('=')[1];
    }
    if (arg.startsWith('--name=')) {
      adminData.name = arg.split('=')[1];
    }
    if (arg.startsWith('--phone=')) {
      adminData.phone = arg.split('=')[1];
    }
  });
  
  // Run the script
  createAdmin();
}

// Export for use in other scripts
module.exports = { createAdmin, adminData };

// Create admin user
// use your_database_name;

// db.users.insertOne({
//   email: "admin@aadyaplus.com",
//   password: "$2a$12$K8L5X5X5X5X5X5X5X5X5Xu5X5X5X5X5X5X5X5X5X5X5X5X5X5X5", // Replace with actual hash
//   role: "admin",
//   name: "System Administrator",
//   phone: "9999999999",
//   isVerified: true,
//   isActive: true,
//   profileCompleted: true,
//   profileId: null,
//   profileModel: null,
//   preferences: {
//     language: "en",
//     theme: "light",
//     notifications: {
//       email: true,
//       sms: true,
//       push: true
//     }
//   },
//   registrationSource: "admin",
//   loginCount: 0,
//   createdAt: new Date(),
//   updatedAt: new Date()
// });