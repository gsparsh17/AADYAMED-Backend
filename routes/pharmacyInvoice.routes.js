const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');
const {
  createInvoiceAndHandleStock,
  downloadInvoicePDF,
  getAllPharmacyInvoices,
  getPharmacyInvoiceById,
  getMonthlyRevenue
} = require('../controllers/pharmacyInvoiceController');

router.use(protect, authorize('admin', 'pharmacy'), resolvePharmacyTenant);

router.get('/stats/monthly-revenue', getMonthlyRevenue);
router.get('/', getAllPharmacyInvoices);
router.post('/from-prescription', requireOrganizationRole('owner','admin','manager','pharmacist','cashier'), createInvoiceAndHandleStock);
router.get('/:id/download', downloadInvoicePDF);
router.get('/:id', getPharmacyInvoiceById);

module.exports = router;
