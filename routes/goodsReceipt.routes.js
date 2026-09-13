const express = require('express');
const router = express.Router();
const controller = require('../controllers/goodsReceipt.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');

router.use(protect, authorize('admin', 'pharmacy'), resolvePharmacyTenant);
router.get('/', controller.listGoodsReceipts);
router.get('/:id', controller.getGoodsReceipt);
module.exports = router;
