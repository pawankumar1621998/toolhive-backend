'use strict';

const { Router }        = require('express');
const dashboardController = require('../controllers/dashboardController');
const { authenticate }  = require('../middleware/auth');

const router = Router();

router.use(authenticate);

router.get('/overview',          dashboardController.getOverview);
router.get('/files',             dashboardController.getFileHistory);
router.get('/downloads',         dashboardController.getDownloadHistory);
router.get('/activity',          dashboardController.getActivity);
router.get('/usage',             dashboardController.getUsageStats);

module.exports = router;
