const express = require('express');
const router = express.Router();
const stockAdjustmentController = require('../controllers/stockAdjustment.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));

router.get('/', stockAdjustmentController.getAllAdjustments);
router.get('/stats', stockAdjustmentController.getAdjustmentStats);
router.post('/', stockAdjustmentController.createAdjustment);

module.exports = router;