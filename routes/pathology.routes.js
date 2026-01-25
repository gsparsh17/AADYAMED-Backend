const express = require('express');
const router = express.Router();
const pathologyController = require('../controllers/pathology.controller');
const { protect, authorize } = require('../middlewares/auth');

// ========== PROTECTED ROUTES (Pathology only) ==========
router.use(protect, authorize('pathology'));

// Profile Management
router.get('/profile', pathologyController.getProfile);
router.put('/profile', pathologyController.updateProfile);

// Test Slots Management
router.get('/test-slots', pathologyController.getTestSlots);
router.put('/test-slots', pathologyController.updateTestSlots);
router.post('/test-slots/bulk', pathologyController.bulkUpdateTestSlots);

// Lab Tests Management
router.get('/lab-tests', pathologyController.getLabTests);
router.get('/lab-tests/:id', pathologyController.getLabTestById);
router.put('/lab-tests/:id/status', pathologyController.updateTestStatus);
router.post('/lab-tests/:id/upload-report', pathologyController.uploadReport);

// Dashboard
router.get('/dashboard', pathologyController.getDashboardStats);

module.exports = router;