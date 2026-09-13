const PharmacyProfile = require('../models/PharmacyProfile');
const PharmacyStore = require('../models/PharmacyStore');
const User = require('../models/User');
const { provisionPharmacyTenant } = require('../services/pharmacyTenant.service');

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const sanitizeProfilePayload = (body = {}) => {
  const payload = { ...body };
  ['userId', 'organizationId', 'organization_id', 'defaultStoreId', 'default_store_id', 'verifiedBy', 'verifiedAt'].forEach(key => delete payload[key]);
  return payload;
};

exports.createPharmacyProfile = async (req, res) => {
  try {
    const existingProfile = await PharmacyProfile.findOne({ userId: req.user.id });
    if (existingProfile) return res.status(400).json({ success: false, error: 'Profile already exists' });

    const profile = await PharmacyProfile.create({
      userId: req.user.id,
      ...sanitizeProfilePayload(req.body)
    });

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profileCompleted: true, profileId: profile._id, profileModel: 'PharmacyProfile' },
      { new: true }
    );
    const tenant = await provisionPharmacyTenant(user, profile);

    res.status(201).json({
      success: true,
      message: 'Pharmacy profile created successfully',
      profile: tenant.profile,
      organization: tenant.organization,
      defaultStore: tenant.store
    });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, error: 'License number already exists' });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.getPharmacyProfile = async (req, res) => {
  try {
    const profile = await PharmacyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });
    const tenant = await provisionPharmacyTenant(req.user, profile);
    res.json({ success: true, pharmacy: tenant.profile, organization: tenant.organization, defaultStore: tenant.store });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.updatePharmacyProfile = async (req, res) => {
  try {
    const profile = await PharmacyProfile.findOneAndUpdate(
      { userId: req.user.id },
      { $set: sanitizeProfilePayload(req.body) },
      { new: true, runValidators: true }
    );
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const tenant = await provisionPharmacyTenant(req.user, profile);
    await PharmacyStore.findOneAndUpdate(
      { _id: tenant.store._id, organizationId: tenant.organization._id },
      {
        $set: {
          name: profile.pharmacyName,
          licenseNumber: profile.licenseNumber,
          email: profile.email || req.user.email,
          phone: profile.phone || req.user.phone,
          address: profile.address || {},
          operatingHours: profile.operatingHours,
          updatedBy: req.user._id
        }
      },
      { runValidators: true }
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
      pharmacy: profile,
      organization: tenant.organization,
      defaultStore: await PharmacyStore.findById(tenant.store._id)
    });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, error: 'License number already exists' });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.getPharmacies = async (req, res) => {
  try {
    const { city, lat, lng, radius = 25, deliveryAvailable, minRating, page = 1, limit = 20 } = req.query;
    const filter = { verificationStatus: 'approved' };
    if (city) filter['address.city'] = { $regex: city, $options: 'i' };
    if (deliveryAvailable === 'true') filter.deliveryAvailable = true;
    if (minRating) filter.averageRating = { $gte: parseFloat(minRating) };

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const total = await PharmacyProfile.countDocuments(filter);
    let pharmacies = await PharmacyProfile.find(filter)
      .select('pharmacyName phone email address operatingHours deliveryAvailable deliveryRadius minimumOrderAmount deliveryCharge paymentMethods averageRating totalReviews totalOrders organizationId defaultStoreId')
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize);

    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      pharmacies = pharmacies.map(pharmacy => {
        const pharmacyLoc = pharmacy.address?.location?.coordinates;
        if (pharmacyLoc && pharmacyLoc.length === 2) {
          const distance = calculateDistance(userLat, userLng, pharmacyLoc[1], pharmacyLoc[0]);
          return { ...pharmacy.toObject(), distance };
        }
        return pharmacy;
      });
      if (radius) pharmacies = pharmacies.filter(p => !p.distance || p.distance <= parseFloat(radius));
      pharmacies.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
    }

    res.json({
      success: true,
      count: pharmacies.length,
      pharmacies,
      pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) }
    });
  } catch (error) {
    console.error('Error fetching pharmacies:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pharmacies' });
  }
};

exports.getPharmacyById = async (req, res) => {
  try {
    const pharmacy = await PharmacyProfile.findById(req.params.id).select('-__v');
    if (!pharmacy) return res.status(404).json({ success: false, error: 'Pharmacy not found' });
    const stores = pharmacy.organizationId
      ? await PharmacyStore.find({ organizationId: pharmacy.organizationId, status: 'active' }).select('name code address phone email isDefault')
      : [];
    res.json({ success: true, pharmacy, stores });
  } catch (error) {
    console.error('Error fetching pharmacy:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pharmacy' });
  }
};

exports.getPharmaciesByCity = async (req, res) => {
  try {
    const { city } = req.params;
    const { lat, lng, radius = 25 } = req.query;
    const filter = { verificationStatus: 'approved', 'address.city': { $regex: city, $options: 'i' } };
    let pharmacies = await PharmacyProfile.find(filter)
      .select('pharmacyName phone email address operatingHours deliveryAvailable deliveryRadius averageRating totalReviews organizationId defaultStoreId');

    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      pharmacies = pharmacies.map(pharmacy => {
        const pharmacyLoc = pharmacy.address?.location?.coordinates;
        if (pharmacyLoc && pharmacyLoc.length === 2) {
          const distance = calculateDistance(userLat, userLng, pharmacyLoc[1], pharmacyLoc[0]);
          return { ...pharmacy.toObject(), distance };
        }
        return pharmacy;
      });
      if (radius) pharmacies = pharmacies.filter(p => !p.distance || p.distance <= parseFloat(radius));
      pharmacies.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
    }

    res.json({ success: true, city, count: pharmacies.length, pharmacies });
  } catch (error) {
    console.error('Error fetching pharmacies by city:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pharmacies' });
  }
};
