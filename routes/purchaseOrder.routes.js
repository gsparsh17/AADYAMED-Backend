const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrder.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));

router.post('/', purchaseOrderController.createPurchaseOrder);
router.get('/', purchaseOrderController.getAllPurchaseOrders);
router.get('/stats', purchaseOrderController.getPurchaseOrderStats);
router.post('/:id/approve', purchaseOrderController.approvePurchaseOrder);
router.post('/:id/receive', purchaseOrderController.receivePurchaseOrder);

module.exports = router;