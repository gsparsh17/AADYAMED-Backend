const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');

router.use(protect);

// Generate bills
router.post('/appointment/:appointmentId', billingController.generateAppointmentBill);
router.post('/pharmacy/:pharmacySaleId', authorize('admin', 'pharmacy'), resolvePharmacyTenant, billingController.generatePharmacyBill);
router.post('/lab-test/:labTestId', billingController.generateLabTestBill);

// Billing summary
router.get('/summary', billingController.getBillingSummary);

// Refunds (admin only)
router.post('/refund', protect, (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}, billingController.processRefund);

module.exports = router;