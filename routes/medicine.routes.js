const express = require('express');
const router = express.Router();
const medicineController = require('../controllers/medicine.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');
const bulkUpload = require('../middlewares/medicineBulkUpload');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));

// Static template — no tenant/store context needed to download it.
router.get('/bulk-upload/template', medicineController.downloadBulkUploadTemplate);
router.get('/catalog/search', medicineController.searchMedicineCatalog);

router.use(resolvePharmacyTenant);

router.post('/', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), medicineController.createMedicine);
router.post('/bulk-upload', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), bulkUpload.single('file'), medicineController.bulkUploadMedicines);
router.get('/', medicineController.getAllMedicines);
router.get('/search', medicineController.searchMedicines);
router.get('/low-stock', medicineController.getLowStockMedicines);
router.get('/expiring', medicineController.getExpiringMedicines);
router.get('/expired', medicineController.getExpiredMedicines);
router.get('/barcode/:code', medicineController.getMedicineByBarcode);
router.get('/:id', medicineController.getMedicineById);
router.put('/:id', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), medicineController.updateMedicine);
router.delete('/:id', requireOrganizationRole('owner','admin','manager','inventory'), medicineController.deleteMedicine);
router.post('/:id/stock', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), medicineController.addStock);

module.exports = router;
