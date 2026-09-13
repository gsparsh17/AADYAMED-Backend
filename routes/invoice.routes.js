const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoice.controller');
const { protect } = require('../middlewares/auth');
const { resolvePharmacyTenantIfApplicable } = require('../middlewares/pharmacyTenant');

router.use(protect);
router.use(resolvePharmacyTenantIfApplicable);

// Create invoices
router.post('/', invoiceController.createInvoice);

// Get invoices
router.get('/', invoiceController.getAllInvoices);
router.get('/stats', invoiceController.getInvoiceStats);
router.get('/:id', invoiceController.getInvoiceById);
router.get('/:id/pdf', invoiceController.generateInvoicePDF);

// Update payment
router.put('/:id/payment', invoiceController.updatePayment);

module.exports = router;