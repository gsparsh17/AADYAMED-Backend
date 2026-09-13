const express = require('express');
const router = express.Router();
const controller = require('../controllers/inventory.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');

router.use(protect, authorize('admin', 'pharmacy'), resolvePharmacyTenant);
router.get('/dashboard', controller.getDashboard);
router.get('/valuation', controller.getValuation);
router.get('/ledger', controller.getLedger);
router.get('/profit-loss', controller.getProfitLoss);
module.exports = router;
