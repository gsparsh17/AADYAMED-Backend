const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');
const upload = require('../middlewares/ePharmacyUpload');
const c = require('../controllers/ePharmacy.controller');

router.use(protect);

router.get('/stores', authorize('patient'), c.listStores);
router.get('/catalog', authorize('patient'), c.catalog);
router.get('/cart', authorize('patient'), c.getCart);
router.post('/cart/items', authorize('patient'), c.addCartItem);
router.patch('/cart/items/:medicineId', authorize('patient'), c.updateCartItem);
router.delete('/cart/items/:medicineId', authorize('patient'), c.removeCartItem);
router.delete('/cart', authorize('patient'), c.clearCart);
router.put('/cart/prescription', authorize('patient'), c.setCartPrescription);

router.get('/addresses', authorize('patient'), c.listAddresses);
router.post('/addresses', authorize('patient'), c.createAddress);
router.patch('/addresses/:id', authorize('patient'), c.updateAddress);
router.delete('/addresses/:id', authorize('patient'), c.deleteAddress);
router.post('/addresses/:id/default', authorize('patient'), c.setDefaultAddress);

router.get('/prescriptions', authorize('patient'), c.listPatientPrescriptions);
router.get('/prescription-uploads', authorize('patient'), c.listPrescriptionUploads);
router.post('/prescription-uploads', authorize('patient'), upload.single('prescription'), c.uploadPrescription);
router.get('/prescription-uploads/:id/file', c.downloadPrescriptionUpload);

router.post('/coupons/validate', authorize('patient'), c.validateCoupon);
router.post('/checkout/quote', authorize('patient'), c.checkoutQuote);
router.post('/orders', authorize('patient'), c.createOrder);
router.get('/orders', authorize('patient'), c.listPatientOrders);
router.get('/orders/:id', authorize('patient'), c.getPatientOrder);
router.post('/orders/:id/cancel', authorize('patient'), c.cancelPatientOrder);
router.post('/orders/:id/reorder', authorize('patient'), c.reorder);

router.use('/merchant', authorize('pharmacy'), resolvePharmacyTenant);
router.get('/merchant/orders', c.listMerchantOrders);
router.get('/merchant/orders/:id', c.getMerchantOrder);
router.get('/merchant/orders/:id/invoice.pdf', c.orderInvoicePdf);
router.get('/merchant/orders/:id/packing-slip.pdf', c.orderPackingSlipPdf);
router.get('/merchant/orders/:id/substitutes', c.orderSubstitutes);
router.get('/merchant/schedule-register', c.scheduleRegister);
router.post('/merchant/orders/:id/prescription', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist'), c.reviewPrescription);
router.post('/merchant/orders/:id/confirm', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist'), c.confirmMerchantOrder);
router.post('/merchant/orders/:id/status', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist'), c.updateMerchantStatus);
router.get('/merchant/rejection-reasons', c.rejectionReasons);
router.post('/merchant/orders/:id/reject', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist'), c.rejectMerchantOrder);
router.post('/merchant/orders/:id/cancel', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist'), c.cancelMerchantOrder);
router.post('/merchant/orders/:id/refund', requireOrganizationRole('owner', 'admin', 'manager'), c.retryMerchantRefund);
router.get('/merchant/settlement', c.merchantSettlement);
router.get('/merchant/coupons', c.listCoupons);
router.post('/merchant/coupons', requireOrganizationRole('owner', 'admin', 'manager'), c.createCoupon);
router.patch('/merchant/coupons/:id', requireOrganizationRole('owner', 'admin', 'manager'), c.updateCoupon);
router.post('/merchant/pause', requireOrganizationRole('owner', 'admin', 'manager', 'pharmacist'), c.setStorePause);
router.patch('/merchant/settings', requireOrganizationRole('owner', 'admin', 'manager'), c.updateOnlineSettings);

module.exports = router;
