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

// Public routes
router.get('/all', getPharmacies);
router.get('/city/:city', getPharmaciesByCity);
router.get('/:id', getPharmacyById);

// Protected pharmacy routes
router.use(protect);
router.use(authorize('pharmacy'));

router.route('/profile')
  .post(createPharmacyProfile)
  .get(getPharmacyProfile)
  .put(updatePharmacyProfile);

module.exports = router;