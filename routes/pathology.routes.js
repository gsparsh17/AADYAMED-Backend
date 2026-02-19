const express = require('express');
const router = express.Router();

const pathologyController = require('../controllers/pathology.controller');

// adjust middleware names to your project
const { protect } = require('../middlewares/auth');
const { authorize } = require('../middlewares/auth');

// ===================== PUBLIC (patients) =====================
router.get('/', pathologyController.getAllLabs);
router.get('/search/tests', pathologyController.searchTests);
router.get('/:id', pathologyController.getLabById);
router.get('/:id/test-slots', pathologyController.getPublicTestSlots);

// booking (patient/admin)
router.post('/:id/book', protect, authorize('patient', 'admin'), pathologyController.bookTestSlot);

// ===================== PATHOLOGY (/me) =====================
router.post('/me/profile', protect, authorize('pathology'), pathologyController.createProfile);
router.get('/me/profile', protect, authorize('pathology'), pathologyController.getProfile);
router.put('/me/profile', protect, authorize('pathology'), pathologyController.updateProfile);

router.get('/me/test-slots', protect, authorize('pathology'), pathologyController.getTestSlots);
router.put('/me/test-slots', protect, authorize('pathology'), pathologyController.updateTestSlots);
router.post('/me/test-slots/bulk', protect, authorize('pathology'), pathologyController.bulkUpdateTestSlots);

router.get('/me/tests', protect, authorize('pathology'), pathologyController.getLabTests);
router.get('/me/tests/:id', protect, authorize('pathology'), pathologyController.getLabTestById);
router.patch('/me/tests/:id/status', protect, authorize('pathology'), pathologyController.updateTestStatus);
router.post('/me/tests/:id/report', protect, authorize('pathology'), pathologyController.uploadReport);

router.get('/me/dashboard', protect, authorize('pathology'), pathologyController.getDashboardStats);

// ✅ NEW: pathology appointments endpoints (the ones you requested)
router.get(
  '/appointments',
  protect,
  authorize('pathology'),
  pathologyController.getMyAppointments
);

router.get(
  '/appointments/:id',
  protect,
  authorize('pathology'),
  pathologyController.getAppointmentByIdForPathology
);

router.patch(
  '/appointments/:id/status',
  protect,
  authorize('pathology'),
  pathologyController.updateAppointmentStatusForPathology
);

// ===================== ADMIN =====================
router.put('/:id/admin', protect, authorize('admin'), pathologyController.updateLabByAdmin);
router.delete('/:id/admin', protect, authorize('admin'), pathologyController.deleteLabByAdmin);

module.exports = router;
