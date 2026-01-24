const express = require('express');
const router = express.Router();
const batchController = require('../controllers/batch.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
router.use(authorize('admin', 'pharmacy'));

router.get('/', batchController.getAllBatches);
router.put('/:id', batchController.updateBatch);
router.post('/:id/adjust', batchController.adjustBatchQuantity);

module.exports = router;