const express = require('express');
const router = express.Router();
const controller = require('../controllers/diagnostics.controller');
const labOps = require('../controllers/labOps.controller');
const { protect, authorize } = require('../middlewares/auth');
const reportUpload = require('../middlewares/labReportUpload');

// Public discovery/catalog
router.get('/labs', controller.listLabs);
router.get('/search', controller.searchCatalog);
router.get('/labs/:id', controller.getLab);
router.get('/labs/:id/slots', controller.getSlots);

// Patient diagnostic marketplace/orders
router.post('/orders', protect, authorize('patient'), controller.createOrder);
router.get('/orders', protect, authorize('patient'), controller.listPatientOrders);
router.get('/orders/:id', protect, authorize('patient'), controller.getPatientOrder);
router.post('/orders/:id/reschedule', protect, authorize('patient'), controller.rescheduleOrder);
router.post('/orders/:id/cancel', protect, authorize('patient'), controller.cancelOrder);

// Reports are also available to the ordering patient, owning lab, ordering doctor, or admin.
router.get('/orders/:id/report', protect, authorize('patient', 'pathology', 'doctor', 'admin'), controller.downloadReport);

// Pathology operations
router.get('/merchant/dashboard', protect, authorize('pathology'), controller.merchantDashboard);
router.get('/merchant/orders', protect, authorize('pathology'), controller.merchantOrders);
router.get('/merchant/orders/:id', protect, authorize('pathology'), controller.merchantOrder);
router.post('/merchant/orders/:id/assign', protect, authorize('pathology'), controller.assignCollector);
router.post('/merchant/orders/:id/collection-status', protect, authorize('pathology'), controller.updateCollectionStatus);
router.post('/merchant/orders/:id/status', protect, authorize('pathology'), controller.updateOrderStatus);
router.post('/merchant/orders/:id/payment', protect, authorize('pathology'), controller.recordOfflinePayment);
router.post('/merchant/orders/:id/report', protect, authorize('pathology'), reportUpload.single('report'), controller.uploadReport);

router.post('/merchant/orders/:id/results', protect, authorize('pathology'), labOps.saveResults);
router.post('/merchant/orders/:id/release', protect, authorize('pathology'), labOps.releaseReport);
router.get('/merchant/earnings', protect, authorize('pathology'), labOps.earnings);
router.get('/merchant/schedule', protect, authorize('pathology'), labOps.getSchedule);
router.put('/merchant/schedule', protect, authorize('pathology'), labOps.putSchedule);
router.post('/merchant/schedule/holidays', protect, authorize('pathology'), labOps.setHoliday);
router.get('/merchant/catalog/library', protect, authorize('pathology'), labOps.getLibrary);
router.post('/merchant/catalog/import', protect, authorize('pathology'), labOps.importLibrary);

router.get('/merchant/staff', protect, authorize('pathology'), controller.listStaff);
router.post('/merchant/staff', protect, authorize('pathology'), controller.createStaff);
router.patch('/merchant/staff/:id', protect, authorize('pathology'), controller.updateStaff);
router.delete('/merchant/staff/:id', protect, authorize('pathology'), controller.deleteStaff);

router.get('/merchant/catalog', protect, authorize('pathology'), controller.getMerchantCatalog);
router.post('/merchant/catalog/tests', protect, authorize('pathology'), controller.createCatalogTest);
router.patch('/merchant/catalog/tests/:id', protect, authorize('pathology'), controller.updateCatalogTest);
router.delete('/merchant/catalog/tests/:id', protect, authorize('pathology'), controller.deleteCatalogTest);
router.post('/merchant/catalog/packages', protect, authorize('pathology'), controller.createPackage);
router.patch('/merchant/catalog/packages/:id', protect, authorize('pathology'), controller.updatePackage);
router.delete('/merchant/catalog/packages/:id', protect, authorize('pathology'), controller.deletePackage);

module.exports = router;
