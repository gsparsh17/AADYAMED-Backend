const express = require('express');
const router = express.Router();
const medicineController = require('../controllers/medicine.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));

router.post('/', medicineController.createMedicine);
router.get('/', medicineController.getAllMedicines);
router.get('/search', medicineController.searchMedicines);
router.get('/low-stock', medicineController.getLowStockMedicines);
router.get('/expiring', medicineController.getExpiringMedicines);
router.get('/expired', medicineController.getExpiredMedicines);
router.get('/:id', medicineController.getMedicineById);
router.put('/:id', medicineController.updateMedicine);
router.delete('/:id', medicineController.deleteMedicine);
router.post('/:id/stock', medicineController.addStock);

module.exports = router;
