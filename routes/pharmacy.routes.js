const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  createPharmacyProfile,
  getPharmacyProfile,
  updatePharmacyProfile,
  getPharmacies,
  getPharmacyById,
  getPharmaciesByCity
} = require('../controllers/pharmacy.controller');

// Protected pharmacy profile routes must be registered before the public /:id route.
router.route('/profile')
  .post(protect, authorize('pharmacy'), createPharmacyProfile)
  .get(protect, authorize('pharmacy'), getPharmacyProfile)
  .put(protect, authorize('pharmacy'), updatePharmacyProfile);

// Public pharmacy discovery routes
router.get('/all', getPharmacies);
router.get('/city/:city', getPharmaciesByCity);
router.get('/:id', getPharmacyById);

module.exports = router;
