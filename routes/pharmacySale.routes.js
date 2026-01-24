const express = require('express');
const router = express.Router();
const pharmacySaleController = require('../controllers/pharmacySale.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);

// Different access levels
router.post('/', authorize('admin', 'pharmacy', 'doctor', 'physiotherapist'), pharmacySaleController.createSale);
router.get('/', authorize('admin', 'pharmacy'), pharmacySaleController.getAllSales);
router.get('/report', authorize('admin', 'pharmacy'), pharmacySaleController.getSalesReport);
router.get('/:id', authorize('admin', 'pharmacy'), pharmacySaleController.getSaleById);
router.post('/:id/dispense', authorize('admin', 'pharmacy'), pharmacySaleController.dispenseSale);

module.exports = router;