const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrder.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));
router.use(resolvePharmacyTenant);

router.post('/', requireOrganizationRole('owner','admin','manager','inventory'), purchaseOrderController.createPurchaseOrder);
router.get('/', purchaseOrderController.getAllPurchaseOrders);
router.get('/stats', purchaseOrderController.getPurchaseOrderStats);
router.get('/:id/grns', purchaseOrderController.getPurchaseOrderGrns);
router.get('/:id', purchaseOrderController.getPurchaseOrderById);
router.post('/:id/approve', requireOrganizationRole('owner','admin','manager'), purchaseOrderController.approvePurchaseOrder);
router.post('/:id/order', requireOrganizationRole('owner','admin','manager','inventory'), purchaseOrderController.markPurchaseOrderOrdered);
router.post('/:id/cancel', requireOrganizationRole('owner','admin','manager'), purchaseOrderController.cancelPurchaseOrder);
router.post('/:id/payment', requireOrganizationRole('owner','admin','manager'), purchaseOrderController.recordPurchasePayment);
router.post('/:id/receive', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), purchaseOrderController.receivePurchaseOrder);

module.exports = router;
