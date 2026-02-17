const LabTest = require('../models/LabTest');
const PathologyProfile = require('../models/PathologyProfile');
const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');

exports.createLabTest = async (req, res) => {
  try {
    const {
      prescriptionId,
      pathologyId,
      tests,
      scheduledDate,
      scheduledTime,
      type,
      collectionAddress
    } = req.body;
    
    const patientId = req.user.profileId;
    
    // Validate prescription
    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found' });
    }
    
    // Validate pathology
    const pathology = await PathologyProfile.findById(pathologyId);
    if (!pathology || pathology.verificationStatus !== 'approved') {
      return res.status(400).json({ message: 'Invalid pathology lab' });
    }
    
    // Check test availability
    const unavailableTests = [];
    for (const test of tests) {
      const service = pathology.services.find(s => s.testCode === test.testCode);
      if (!service) {
        unavailableTests.push(test.testCode);
      }
    }
    
    if (unavailableTests.length > 0) {
      return res.status(400).json({ 
        message: 'Some tests not available at selected lab',
        unavailableTests 
      });
    }
    
    // Calculate total amount
    let totalAmount = 0;
    const testDetails = tests.map(test => {
      const service = pathology.services.find(s => s.testCode === test.testCode);
      totalAmount += service.price;
      return {
        testCode: test.testCode,
        testName: service.testName,
        price: service.price,
        status: 'pending'
      };
    });
    
    // Add home collection charges if applicable
    if (type === 'home_collection' && pathology.homeCollectionAvailable) {
      totalAmount += pathology.homeCollectionCharges || 0;
    }
    
    const labTest = await LabTest.create({
      prescriptionId,
      patientId,
      pathologyId,
      doctorId: prescription.doctorId || prescription.physioId,
      tests: testDetails,
      scheduledDate,
      scheduledTime,
      type,
      collectionAddress: type === 'home_collection' ? collectionAddress : undefined,
      totalAmount,
      status: 'requested'
    });
    
    res.status(201).json({ success: true, labTest });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getLabTests = async (req, res) => {
  try {
    const { 
      status, 
      type, 
      startDate, 
      endDate,
      page = 1, 
      limit = 10 
    } = req.query;
    
    const filter = {};
    
    // Role-based filtering
    switch(req.user.role) {
      case 'patient':
        filter.patientId = req.user.profileId;
        break;
      case 'pathology':
        filter.pathologyId = req.user.profileId;
        break;
      case 'doctor':
      case 'physio':
        filter.doctorId = req.user.profileId;
        break;
      case 'admin':
        // Admin can see all
        break;
    }
    
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.scheduledDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const labTests = await LabTest.find(filter)
      .sort({ scheduledDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('patientId', 'name phone')
      .populate('pathologyId', 'labName phone address')
      .populate('doctorId', 'name')
      .populate('prescriptionId', 'prescriptionNumber');
    
    const total = await LabTest.countDocuments(filter);
    
    res.json({
      success: true,
      labTests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateTestStatus = async (req, res) => {
  try {
    const { status, testCode, results, reportUrl } = req.body;
    
    const labTest = await LabTest.findById(req.params.id);
    if (!labTest) {
      return res.status(404).json({ message: 'Lab test not found' });
    }
    
    // Authorization check
    if (!canUpdateTestStatus(req.user, labTest)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    if (testCode) {
      // Update specific test
      const test = labTest.tests.find(t => t.testCode === testCode);
      if (test) {
        test.status = status;
        if (status === 'completed') {
          test.completedAt = new Date();
        }
      }
    } else {
      // Update all tests
      labTest.status = status;
      
      if (status === 'sample_collected') {
        labTest.sample = {
          collectionTime: new Date(),
          collectedBy: req.user.name || 'Staff'
        };
      } else if (status === 'completed') {
        labTest.results = results;
        labTest.reportUrl = reportUrl;
        labTest.reportGeneratedAt = new Date();
      }
    }
    
    await labTest.save();
    
    // Send notifications based on status
    await sendLabTestNotifications(labTest, status);
    
    res.json({ success: true, labTest });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.uploadReport = async (req, res) => {
  try {
    const { reportUrl } = req.body;
    
    const labTest = await LabTest.findById(req.params.id);
    if (!labTest) {
      return res.status(404).json({ message: 'Lab test not found' });
    }
    
    if (req.user.role !== 'pathology' || 
        labTest.pathologyId.toString() !== req.user.profileId) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    labTest.reportUrl = reportUrl;
    labTest.reportGeneratedAt = new Date();
    labTest.status = 'completed';
    
    await labTest.save();
    
    res.json({ success: true, labTest });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper functions
function canUpdateTestStatus(user, labTest) {
  if (user.role === 'admin') return true;
  
  if (user.role === 'pathology' && 
      labTest.pathologyId.toString() === user.profileId) {
    return true;
  }
  
  return false;
}

async function sendLabTestNotifications(labTest, status) {
  // Implementation for sending notifications
}