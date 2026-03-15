const PharmacyProfile = require('../models/PharmacyProfile');
const User = require('../models/User');

// Helper function to calculate distance between coordinates
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

exports.createPharmacyProfile = async (req, res) => {
  try {
    const existingProfile = await PharmacyProfile.findOne({ userId: req.user.id });
    if (existingProfile) {
      return res.status(400).json({
        success: false,
        error: 'Profile already exists'
      });
    }

    const profileData = {
      userId: req.user.id,
      ...req.body
    };

    const profile = await PharmacyProfile.create(profileData);

    // Update user's profileCompleted status
    await User.findByIdAndUpdate(req.user.id, {
      profileCompleted: true,
      profileId: profile._id
    });

    res.status(201).json({
      success: true,
      message: 'Pharmacy profile created successfully',
      profile
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'License number already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.getPharmacyProfile = async (req, res) => {
  try {
    const profile = await PharmacyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    res.json({
      success: true,
      pharmacy: profile
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.updatePharmacyProfile = async (req, res) => {
  try {
    const profile = await PharmacyProfile.findOneAndUpdate(
      { userId: req.user.id },
      req.body,
      { new: true, runValidators: true }
    );

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      pharmacy: profile
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'License number already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get all approved pharmacies with optional location filtering
exports.getPharmacies = async (req, res) => {
  try {
    const { 
      city, 
      lat, 
      lng, 
      radius = 25, 
      deliveryAvailable,
      minRating,
      page = 1, 
      limit = 20 
    } = req.query;

    const filter = { verificationStatus: 'approved' };

    if (city) {
      filter['address.city'] = { $regex: city, $options: 'i' };
    }

    if (deliveryAvailable === 'true') {
      filter.deliveryAvailable = true;
    }

    if (minRating) {
      filter.averageRating = { $gte: parseFloat(minRating) };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let pharmacies = await PharmacyProfile.find(filter)
      .select('pharmacyName phone email address operatingHours deliveryAvailable deliveryRadius minimumOrderAmount deliveryCharge paymentMethods averageRating totalReviews totalOrders')
      .skip(skip)
      .limit(parseInt(limit));

    // If user location is provided, calculate distances
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      
      pharmacies = pharmacies.map(pharmacy => {
        const pharmacyLoc = pharmacy.address?.location?.coordinates;
        if (pharmacyLoc && pharmacyLoc.length === 2) {
          const distance = calculateDistance(
            userLat,
            userLng,
            pharmacyLoc[1], // latitude
            pharmacyLoc[0]  // longitude
          );
          return { ...pharmacy.toObject(), distance };
        }
        return pharmacy;
      });

      // Filter by radius
      if (radius) {
        pharmacies = pharmacies.filter(p => !p.distance || p.distance <= parseFloat(radius));
      }

      // Sort by distance
      pharmacies.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
    }

    const total = pharmacies.length;

    res.json({
      success: true,
      count: pharmacies.length,
      pharmacies,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching pharmacies:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pharmacies'
    });
  }
};

// Get pharmacy by ID
exports.getPharmacyById = async (req, res) => {
  try {
    const pharmacy = await PharmacyProfile.findById(req.params.id)
      .select('-__v');

    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }

    res.json({
      success: true,
      pharmacy
    });
  } catch (error) {
    console.error('Error fetching pharmacy:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pharmacy'
    });
  }
};

// Get pharmacies by city
exports.getPharmaciesByCity = async (req, res) => {
  try {
    const { city } = req.params;
    const { lat, lng, radius = 25 } = req.query;

    const filter = { 
      verificationStatus: 'approved',
      'address.city': { $regex: city, $options: 'i' }
    };

    let pharmacies = await PharmacyProfile.find(filter)
      .select('pharmacyName phone email address operatingHours deliveryAvailable deliveryRadius averageRating totalReviews');

    // If user location is provided, calculate distances
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      
      pharmacies = pharmacies.map(pharmacy => {
        const pharmacyLoc = pharmacy.address?.location?.coordinates;
        if (pharmacyLoc && pharmacyLoc.length === 2) {
          const distance = calculateDistance(
            userLat,
            userLng,
            pharmacyLoc[1],
            pharmacyLoc[0]
          );
          return { ...pharmacy.toObject(), distance };
        }
        return pharmacy;
      });

      // Filter by radius
      if (radius) {
        pharmacies = pharmacies.filter(p => !p.distance || p.distance <= parseFloat(radius));
      }

      // Sort by distance
      pharmacies.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
    }

    res.json({
      success: true,
      city,
      count: pharmacies.length,
      pharmacies
    });
  } catch (error) {
    console.error('Error fetching pharmacies by city:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pharmacies'
    });
  }
};