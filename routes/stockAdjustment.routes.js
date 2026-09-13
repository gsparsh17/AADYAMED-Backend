const express = require('express');
const router = express.Router();
const stockAdjustmentController = require('../controllers/stockAdjustment.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));
router.use(resolvePharmacyTenant);

router.get('/', stockAdjustmentController.getAllAdjustments);
router.get('/stats', stockAdjustmentController.getAdjustmentStats);
router.post('/', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), stockAdjustmentController.createAdjustment);

module.exports = router;