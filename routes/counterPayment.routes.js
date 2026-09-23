const express = require('express');
const router = express.Router();
const controller = require('../controllers/counterPayment.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));
router.use(resolvePharmacyTenant);

// Raising and closing a collection is a till action, so cashiers are included.
router.post('/qr', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist', 'cashier'), controller.createQr);
router.get('/', controller.listForEntity);
router.get('/:id', controller.getQrStatus);
router.post('/:id/close', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist', 'cashier'), controller.closeQr);

module.exports = router;
