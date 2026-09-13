const express = require('express');
const router = express.Router();
const controller = require('../controllers/stockTransfer.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect, authorize('admin', 'pharmacy'), resolvePharmacyTenant);
router.get('/', controller.listTransfers);
router.get('/:id', controller.getTransfer);
router.post('/', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), controller.createTransfer);
router.post('/:id/approve', requireOrganizationRole('owner','admin','manager','inventory'), controller.approveTransfer);
router.post('/:id/dispatch', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), controller.dispatchTransfer);
router.post('/:id/receive', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), controller.receiveTransfer);
router.post('/:id/cancel', requireOrganizationRole('owner','admin','manager','inventory'), controller.cancelTransfer);
module.exports = router;
