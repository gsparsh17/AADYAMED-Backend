const express = require('express');
const router = express.Router();
const medicineController = require('../controllers/medicine.controller');
const { protect, authorize } = require('../middlewares/auth');
const { resolvePharmacyTenant } = require('../middlewares/pharmacyTenant');
const { requireOrganizationRole } = require('../middlewares/organizationAccess');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));
router.use(resolvePharmacyTenant);

router.post('/', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), medicineController.createMedicine);
router.get('/', medicineController.getAllMedicines);
router.get('/search', medicineController.searchMedicines);
router.get('/low-stock', medicineController.getLowStockMedicines);
router.get('/expiring', medicineController.getExpiringMedicines);
router.get('/expired', medicineController.getExpiredMedicines);
router.get('/:id', medicineController.getMedicineById);
router.put('/:id', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), medicineController.updateMedicine);
router.delete('/:id', requireOrganizationRole('owner','admin','manager','inventory'), medicineController.deleteMedicine);
router.post('/:id/stock', requireOrganizationRole('owner','admin','manager','inventory','pharmacist'), medicineController.addStock);

module.exports = router;
