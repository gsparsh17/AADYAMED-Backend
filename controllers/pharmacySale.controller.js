const PharmacySale = require('../models/PharmacySale');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Prescription = require('../models/Prescription');
const PatientProfile = require('../models/PatientProfile');
const StockAdjustment = require('../models/StockAdjustment');

exports.createSale = async (req, res) => {
  try {
    const { 
      customerType, 
      patientId, 
      prescriptionId, 
      items, 
      paymentMethod,
      notes 
    } = req.body;
    
    let customerDetails = {};
    
    // Validate patient if provided
    if (patientId) {
      const patient = await PatientProfile.findById(patientId);
      if (!patient) {
        return res.status(404).json({ message: 'Patient not found' });
      }
      customerDetails = {
        customerName: patient.name,
        customerPhone: patient.phone,
        customerEmail: patient.userId.email,
        customerAddress: patient.address
      };
    } else {
      customerDetails = {
        customerName: req.body.customerName,
        customerPhone: req.body.customerPhone,
        customerEmail: req.body.customerEmail,
        customerAddress: req.body.customerAddress
      };
    }
    
    // Validate prescription if provided
    let prescriptionDetails = {};
    if (prescriptionId) {
      const prescription = await Prescription.findById(prescriptionId);
      if (!prescription) {
        return res.status(404).json({ message: 'Prescription not found' });
      }
      prescriptionDetails = {
        prescriptionRequired: true,
        prescriptionNumber: prescription.prescriptionNumber,
        prescribingDoctor: prescription.doctorId?.name || prescription.physioId?.name
      };
      
      // Check if already fully dispensed
      if (prescription.pharmacyStatus === 'fully_dispensed') {
        return res.status(400).json({ message: 'Prescription already fully dispensed' });
      }
    }
    
    // Validate items and check stock
    let subtotal = 0;
    const validatedItems = [];
    
    for (const item of items) {
      const medicine = await Medicine.findById(item.medicineId);
      if (!medicine || !medicine.isActive) {
        return res.status(400).json({ message: `Medicine ${item.medicineId} not available` });
      }
      
      if (medicine.quantity < item.quantity) {
        return res.status(400).json({ 
          message: `Insufficient stock for ${medicine.medicineName}. Available: ${medicine.quantity}` 
        });
      }
      
      // Check prescription requirement
      if (medicine.prescriptionRequired && !prescriptionId) {
        return res.status(400).json({ 
          message: `Prescription required for ${medicine.medicineName}` 
        });
      }
      
      const itemTotal = item.quantity * medicine.sellingPrice;
      subtotal += itemTotal;
      
      validatedItems.push({
        medicineId: medicine._id,
        medicineName: medicine.medicineName,
        genericName: medicine.genericName,
        quantity: item.quantity,
        unit: medicine.unit,
        sellingPrice: medicine.sellingPrice,
        taxRate: medicine.taxRate,
        totalAmount: itemTotal
      });
    }
    
    const tax = validatedItems.reduce((sum, item) => 
      sum + (item.totalAmount * item.taxRate / 100), 0);
    const totalAmount = subtotal + tax;
    
    const sale = await PharmacySale.create({
      customerType,
      patientId: patientId || undefined,
      prescriptionId: prescriptionId || undefined,
      ...customerDetails,
      ...prescriptionDetails,
      items: validatedItems,
      subtotal,
      tax,
      totalAmount,
      paidAmount: totalAmount, // Assume full payment for now
      balanceAmount: 0,
      paymentMethod,
      paymentStatus: 'paid',
      status: 'draft',
      notes,
      createdBy: req.user.id
    });
    
    res.status(201).json({ success: true, sale });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.dispenseSale = async (req, res) => {
  try {
    const sale = await PharmacySale.findById(req.params.id);
    
    if (!sale) {
      return res.status(404).json({ message: 'Sale not found' });
    }
    
    if (sale.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft sales can be dispensed' });
    }
    
    // Process each item
    for (const item of sale.items) {
      const medicine = await Medicine.findById(item.medicineId);
      if (!medicine) continue;
      
      // Find batches (FIFO - First In First Out)
      const batches = await MedicineBatch.find({
        medicineId: medicine._id,
        isActive: true,
        isExpired: false,
        availableQuantity: { $gt: 0 }
      }).sort({ expiryDate: 1 });
      
      let remainingQty = item.quantity;
      
      for (const batch of batches) {
        if (remainingQty <= 0) break;
        
        const deductQty = Math.min(remainingQty, batch.availableQuantity);
        
        // Update batch
        batch.availableQuantity -= deductQty;
        if (batch.availableQuantity === 0) {
          batch.isActive = false;
        }
        await batch.save();
        
        // Update item with batch info
        item.batchId = batch._id;
        
        // Record stock adjustment
        await StockAdjustment.create({
          medicineId: medicine._id,
          batchId: batch._id,
          previousQuantity: batch.availableQuantity + deductQty,
          adjustmentQuantity: -deductQty,
          newQuantity: batch.availableQuantity,
          adjustmentType: 'deduction',
          reason: 'Pharmacy sale',
          referenceType: 'sale',
          referenceId: sale._id,
          adjustedBy: req.user.id
        });
        
        remainingQty -= deductQty;
      }
      
      if (remainingQty > 0) {
        return res.status(400).json({ 
          message: `Insufficient stock for ${medicine.medicineName}` 
        });
      }
      
      // Update medicine total quantity
      medicine.quantity -= item.quantity;
      await medicine.save();
    }
    
    // Update sale status
    sale.status = 'dispensed';
    sale.dispensedBy = req.user.id;
    sale.dispensedAt = new Date();
    await sale.save();
    
    // Update prescription if linked
    if (sale.prescriptionId) {
      await updatePrescriptionDispense(sale);
    }
    
    res.json({ success: true, sale });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllSales = async (req, res) => {
  try {
    const { 
      status, 
      customerType,
      startDate,
      endDate,
      patientId,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (customerType) filter.customerType = customerType;
    if (patientId) filter.patientId = patientId;
    if (startDate && endDate) {
      filter.saleDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const sales = await PharmacySale.find(filter)
      .populate('patientId', 'name phone')
      .populate('prescriptionId', 'prescriptionNumber')
      .populate('createdBy', 'name email')
      .sort({ saleDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await PharmacySale.countDocuments(filter);
    
    // Calculate totals
    const totals = await PharmacySale.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$totalAmount' },
          totalTax: { $sum: '$tax' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      sales,
      totals: totals[0] || { totalSales: 0, totalTax: 0, count: 0 },
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

exports.getSaleById = async (req, res) => {
  try {
    const sale = await PharmacySale.findById(req.params.id)
      .populate('patientId')
      .populate('prescriptionId')
      .populate('createdBy', 'name email')
      .populate('dispensedBy', 'name email');
    
    if (!sale) {
      return res.status(404).json({ message: 'Sale not found' });
    }
    
    // Get batch details for items
    const itemsWithBatch = [];
    for (const item of sale.items) {
      if (item.batchId) {
        const batch = await MedicineBatch.findById(item.batchId);
        itemsWithBatch.push({ ...item.toObject(), batchDetails: batch });
      } else {
        itemsWithBatch.push(item);
      }
    }
    
    sale.items = itemsWithBatch;
    
    res.json({ success: true, sale });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getSalesReport = async (req, res) => {
  try {
    const { groupBy = 'day', startDate, endDate } = req.query;
    
    const matchStage = { status: 'dispensed' };
    if (startDate && endDate) {
      matchStage.saleDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    let groupStage;
    if (groupBy === 'day') {
      groupStage = {
        _id: {
          year: { $year: '$saleDate' },
          month: { $month: '$saleDate' },
          day: { $dayOfMonth: '$saleDate' }
        },
        totalSales: { $sum: '$totalAmount' },
        totalItems: { $sum: { $size: '$items' } },
        count: { $sum: 1 }
      };
    } else if (groupBy === 'month') {
      groupStage = {
        _id: {
          year: { $year: '$saleDate' },
          month: { $month: '$saleDate' }
        },
        totalSales: { $sum: '$totalAmount' },
        totalItems: { $sum: { $size: '$items' } },
        count: { $sum: 1 }
      };
    } else if (groupBy === 'medicine') {
      groupStage = {
        _id: '$items.medicineId',
        medicineName: { $first: '$items.medicineName' },
        totalQuantity: { $sum: '$items.quantity' },
        totalAmount: { $sum: { $multiply: ['$items.quantity', '$items.sellingPrice'] } },
        count: { $sum: 1 }
      };
    }
    
    const report = await PharmacySale.aggregate([
      { $match: matchStage },
      { $unwind: '$items' },
      { $group: groupStage },
      { $sort: { totalSales: -1 } },
      { $limit: 20 }
    ]);
    
    // Get top customers
    const topCustomers = await PharmacySale.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$customerPhone',
          customerName: { $first: '$customerName' },
          totalSpent: { $sum: '$totalAmount' },
          totalVisits: { $sum: 1 }
        }
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({ success: true, report, topCustomers });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper function to update prescription dispense status
async function updatePrescriptionDispense(sale) {
  const prescription = await Prescription.findById(sale.prescriptionId);
  if (!prescription) return;
  
  const dispensedItems = sale.items.map(item => ({
    medicineId: item.medicineId,
    batchId: item.batchId,
    quantity: item.quantity,
    unit: item.unit,
    dispensedAt: sale.dispensedAt,
    dispensedBy: sale.dispensedBy,
    pharmacySaleId: sale._id
  }));
  
  prescription.dispensedItems = prescription.dispensedItems.concat(dispensedItems);
  
  // Check if all prescribed medicines are dispensed
  const prescribedMedicines = prescription.medicines || [];
  const dispensedCount = prescription.dispensedItems.length;
  
  if (dispensedCount === 0) {
    prescription.pharmacyStatus = 'not_dispensed';
  } else if (dispensedCount < prescribedMedicines.length) {
    prescription.pharmacyStatus = 'partially_dispensed';
  } else {
    prescription.pharmacyStatus = 'fully_dispensed';
  }
  
  await prescription.save();
}