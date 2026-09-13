const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const tenantController = require('../controllers/tenant.controller');

router.use(protect);
router.use(authorize('pharmacy'));

router.get('/context', tenantController.getContext);
router.get('/organization', tenantController.getOrganization);
router.put('/organization', tenantController.updateOrganization);
router.get('/stores', tenantController.listStores);
router.post('/stores', tenantController.createStore);
router.put('/stores/:id', tenantController.updateStore);
router.post('/stores/:id/select', tenantController.selectDefaultStore);

module.exports = router;
