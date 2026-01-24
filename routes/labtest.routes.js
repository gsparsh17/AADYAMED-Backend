const express = require('express');
const router = express.Router();
const labTestController = require('../controllers/labtest.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.post('/', labTestController.createLabTest);
router.get('/', labTestController.getLabTests);
router.put('/:id/status', labTestController.updateTestStatus);
router.put('/:id/upload-report', labTestController.uploadReport);

module.exports = router;