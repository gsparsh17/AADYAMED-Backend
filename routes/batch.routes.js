const express = require('express');
const router = express.Router();
const batchController = require('../controllers/batch.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));
router.use(resolvePharmacyTenant);

router.post('/', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), batchController.createBatch);
router.get('/', batchController.getAllBatches);
router.get('/medicine/:medicineId', batchController.getBatchesByMedicine);
router.put('/:id', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), batchController.updateBatch);
router.post('/:id/adjust', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), batchController.adjustBatchQuantity);

module.exports = router;
