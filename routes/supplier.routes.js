const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplier.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));
router.use(resolvePharmacyTenant);

router.post('/', requireOrganizationRole('owner','admin','manager','inventory'), supplierController.createSupplier);
router.get('/', supplierController.getAllSuppliers);
router.get('/:id', supplierController.getSupplierById);
router.put('/:id', requireOrganizationRole('owner','admin','manager','inventory'), supplierController.updateSupplier);
router.delete('/:id', requireOrganizationRole('owner','admin','manager'), supplierController.deleteSupplier);

module.exports = router;