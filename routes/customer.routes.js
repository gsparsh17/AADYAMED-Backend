const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('admin', 'pharmacy'));

router.post('/', customerController.createCustomer);
router.get('/', customerController.getAllCustomers);
router.get('/stats/summary', customerController.getCustomerStatistics);
router.get('/:id', customerController.getCustomerById);
router.put('/:id', customerController.updateCustomer);
router.delete('/:id', customerController.deleteCustomer);

module.exports = router;
