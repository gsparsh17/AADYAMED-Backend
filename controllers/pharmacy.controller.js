// controllers/pharmacy.controller.js (UPDATED)

const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');

const normalizeEmail = (v) => (v ? String(v).trim().toLowerCase() : '');
const normalizePhone = (v) => (v ? String(v).replace(/\D/g, '').slice(-10) : '');

exports.createPharmacy = async (req, res) => {
  try {
    const { name, licenseNumber, email, phone, address, password } = req.body || {};

    const cleanEmail = normalizeEmail(email);
    const cleanPhone = normalizePhone(phone);

    if (!name?.trim()) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!licenseNumber?.trim()) {
      return res.status(400).json({ success: false, error: 'licenseNumber is required' });
    }
    if (!cleanEmail) {
      return res.status(400).json({ success: false, error: 'email is required' });
    }

    // Prevent duplicates early (friendlier than relying only on mongoose unique error)
    const existingPharmacy = await Pharmacy.findOne({
      $or: [{ licenseNumber: licenseNumber.trim() }, { email: cleanEmail }]
    });

    if (existingPharmacy) {
      return res.status(409).json({
        success: false,
        error: 'Pharmacy already exists with this licenseNumber or email'
      });
    }

    // If you are also creating a user, ensure email isn't already used by another user
    if (password) {
      const existingUser = await User.findOne({ email: cleanEmail });
      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: 'User already exists with this email'
        });
      }
    }

    const pharmacy = await Pharmacy.create({
      name: name.trim(),
      licenseNumber: licenseNumber.trim(),
      email: cleanEmail,
      phone: cleanPhone,
      address: address || ''
      // status default: 'Active'
      // registeredAt default handled by schema
    });

    let createdUser = null;

    // OPTIONAL: create login user for pharmacy
    if (password) {
      createdUser = await User.create({
        name: name.trim(),
        email: cleanEmail,
        phone: cleanPhone,
        role: 'pharmacy',
        password
      });
    }

    const user = await User.findById(req.user.id);
    user.profileId=pharmacy._id;
    user.save();

    return res.status(201).json({
      success: true,
      message: 'Pharmacy created',
      pharmacyId: pharmacy._id,
      userId: createdUser?._id || null
    });
  } catch (err) {
    // Handle mongoose duplicate key errors nicely
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(409).json({
        success: false,
        error: `Duplicate ${field}. Please use a different ${field}.`
      });
    }

    return res.status(400).json({ success: false, error: err.message });
  }
};

exports.getAllPharmacies = async (req, res) => {
  try {
    // Only active pharmacies (your old behavior)
    const pharmacies = await Pharmacy.find({ status: 'Active' }).sort({ registeredAt: -1 });

    return res.json({
      success: true,
      pharmacies,
      count: pharmacies.length
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.getPharmacyById = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findById(req.params.id);

    if (!pharmacy) {
      return res.status(404).json({ success: false, error: 'Pharmacy not found' });
    }

    return res.json({ success: true, pharmacy });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.updatePharmacy = async (req, res) => {
  try {
    const updates = { ...(req.body || {}) };

    if (updates.email) updates.email = normalizeEmail(updates.email);
    if (updates.phone) updates.phone = normalizePhone(updates.phone);
    if (updates.name) updates.name = String(updates.name).trim();
    if (updates.licenseNumber) updates.licenseNumber = String(updates.licenseNumber).trim();

    // Find existing pharmacy
    const pharmacy = await Pharmacy.findById(req.params.id);
    if (!pharmacy) {
      return res.status(404).json({ success: false, error: 'Pharmacy not found' });
    }

    // If license/email is being changed, prevent duplicates
    if (updates.email || updates.licenseNumber) {
      const conflict = await Pharmacy.findOne({
        _id: { $ne: pharmacy._id },
        $or: [
          updates.email ? { email: updates.email } : null,
          updates.licenseNumber ? { licenseNumber: updates.licenseNumber } : null
        ].filter(Boolean)
      });

      if (conflict) {
        return res.status(409).json({
          success: false,
          error: 'Another pharmacy already uses this email or licenseNumber'
        });
      }
    }

    const updatedPharmacy = await Pharmacy.findByIdAndUpdate(
      pharmacy._id,
      updates,
      { new: true, runValidators: true }
    );

    // Keep User (role: pharmacy) in sync by email (best effort)
    // If your User model links by pharmacyId, switch to that instead.
    if (updates.email || updates.phone || updates.name) {
      await User.findOneAndUpdate(
        { role: 'pharmacy', email: pharmacy.email }, // match old email
        {
          ...(updates.email ? { email: updates.email } : {}),
          ...(updates.phone ? { phone: updates.phone } : {}),
          ...(updates.name ? { name: updates.name } : {})
        },
        { new: true }
      );
    }

    return res.json({
      success: true,
      message: 'Pharmacy updated successfully',
      pharmacy: updatedPharmacy
    });
  } catch (err) {
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(409).json({
        success: false,
        error: `Duplicate ${field}. Please use a different ${field}.`
      });
    }

    return res.status(400).json({ success: false, error: err.message });
  }
};

exports.deletePharmacy = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findById(req.params.id);
    if (!pharmacy) {
      return res.status(404).json({ success: false, error: 'Pharmacy not found' });
    }

    // Soft delete (your schema supports status)
    const updated = await Pharmacy.findByIdAndUpdate(
      pharmacy._id,
      { status: 'Inactive' },
      { new: true }
    );

    // Best effort: also deactivate / restrict the user account (if you have such flags)
    // If your User schema has "isActive" or similar, uncomment and use it.
    // await User.findOneAndUpdate({ role: 'pharmacy', email: pharmacy.email }, { isActive: false });

    return res.json({
      success: true,
      message: 'Pharmacy deactivated successfully',
      pharmacy: updated
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
