const express = require('express');
const router = express.Router();
const commissionController = require('../controllers/commission.controller');
const { protect, authorize } = require('../middlewares/auth');

// ========== PROTECTED ROUTES ==========
router.use(protect);

// Get commissions (admin and professionals)
router.get('/', commissionController.getCommissions);

// Get commission report (admin and professionals)
router.get('/report', commissionController.getCommissionReport);

// Get commission cycles (admin only)
router.get('/cycles', authorize('admin'), commissionController.getCommissionCycles);

// Get commission summary (admin only)
router.get('/summary', authorize('admin'), commissionController.getCommissionSummary);

// Process payout (admin only)
router.post('/payout', authorize('admin'), commissionController.processPayout);

// Generate payout report (admin only)
router.post('/payout/generate-report', authorize('admin'), commissionController.generatePayoutReport);

// Mark payout as paid (admin only)
router.post('/payout/:payoutId/mark-paid', authorize('admin'), commissionController.markPayoutAsPaid);

module.exports = router;