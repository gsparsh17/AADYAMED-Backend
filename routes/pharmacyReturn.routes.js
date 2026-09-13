const express = require('express');
const router = express.Router();
const controller = require('../controllers/pharmacyReturn.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect, authorize('admin', 'pharmacy'), resolvePharmacyTenant);
router.get('/', controller.listReturns);
router.get('/:id', controller.getReturnById);
router.post('/', requireOrganizationRole('owner','admin','manager','pharmacist','cashier'), controller.createReturn);
module.exports = router;
