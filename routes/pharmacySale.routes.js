const express = require('express');
const router = express.Router();
const pharmacySaleController = require('../controllers/pharmacySale.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));
router.use(resolvePharmacyTenant);

router.post('/', requireOrganizationRole('owner','admin','manager','pharmacist','cashier'), pharmacySaleController.createSale);
router.get('/', pharmacySaleController.getAllSales);
router.get('/report', pharmacySaleController.getSalesReport);
router.get('/stats/today', pharmacySaleController.getTodaySalesStats);
router.get('/:id/invoice', pharmacySaleController.downloadSaleInvoice);
router.get('/:id', pharmacySaleController.getSaleById);
router.post('/:id/dispense', requireOrganizationRole('owner','admin','manager','pharmacist','cashier'), pharmacySaleController.dispenseSale);

module.exports = router;
