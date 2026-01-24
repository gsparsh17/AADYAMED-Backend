const express = require('express');
const router = express.Router();
const pathologyController = require('../controllers/pathology.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('pathology'));

// Profile
router.get('/profile', pathologyController.getProfile);
router.put('/profile', pathologyController.updateProfile);

// Test Slots
router.get('/test-slots', pathologyController.getTestSlots);
router.put('/test-slots', pathologyController.updateTestSlots);

// Lab Tests
router.get('/lab-tests', pathologyController.getLabTests);

// Dashboard
router.get('/dashboard', pathologyController.getDashboardStats);

module.exports = router;