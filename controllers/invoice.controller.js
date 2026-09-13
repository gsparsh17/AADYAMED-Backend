const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');
const PharmacySale = require('../models/PharmacySale');
const LabTest = require('../models/LabTest');
const PatientProfile = require('../models/PatientProfile');
const PDFDocument = require('pdfkit');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');

exports.createInvoice = async (req, res) => {
  try {
    const { 
      invoiceType,
      appointmentId,
      pharmacySaleId,
      labTestId,
      patientId,
      items,
      discount,
      notes 
    } = req.body;
    
    // Validate based on invoice type
    let referenceId;
    let patient;
    let customerDetails = {};
    
    switch(invoiceType) {
      case 'appointment':
        const appointment = await Appointment.findById(appointmentId)
          .populate('patientId', 'name phone email address');
        if (!appointment) {
          return res.status(404).json({ message: 'Appointment not found' });
        }
        referenceId = appointmentId;
        patient = appointment.patientId;
        customerDetails = {
          customerName: patient.name,
          customerPhone: patient.phone,
          customerEmail: patient.email,
          customerAddress: patient.address
        };
        break;
        
      case 'pharmacy': {
        const pharmacySaleFilter = req.user.role === 'pharmacy'
          ? scopedFilter(req, { _id: pharmacySaleId })
          : { _id: pharmacySaleId };
        const pharmacySale = await PharmacySale.findOne(pharmacySaleFilter)
          .populate('patientId', 'name phone email address');
        if (!pharmacySale) {
          return res.status(404).json({ message: 'Pharmacy sale not found in the selected store' });
        }
        referenceId = pharmacySaleId;
        patient = pharmacySale.patientId || null;
        customerDetails = pharmacySale.patientId ? {
          customerName: pharmacySale.patientId.name,
          customerPhone: pharmacySale.patientId.phone,
          customerEmail: pharmacySale.patientId.email,
          customerAddress: pharmacySale.patientId.address
        } : {
          customerName: pharmacySale.customerName || 'Walk-in customer',
          customerPhone: pharmacySale.customerPhone,
          customerEmail: pharmacySale.customerEmail,
          customerAddress: pharmacySale.customerAddress
        };
        // Preserve the sale tenant even when an admin generates the invoice.
        customerDetails.organizationId = pharmacySale.organizationId;
        customerDetails.storeId = pharmacySale.storeId;
        break;
      }
        
      case 'lab_test':
        const labTest = await LabTest.findById(labTestId)
          .populate('patientId', 'name phone email address');
        if (!labTest) {
          return res.status(404).json({ message: 'Lab test not found' });
        }
        referenceId = labTestId;
        patient = labTest.patientId;
        break;
        
      default:
        if (!patientId) {
          return res.status(400).json({ message: 'Patient ID is required for this invoice type' });
        }
        patient = await PatientProfile.findById(patientId);
        if (!patient) {
          return res.status(404).json({ message: 'Patient not found' });
        }
        customerDetails = {
          customerName: patient.name,
          customerPhone: patient.phone,
          customerEmail: patient.userId?.email,
          customerAddress: patient.address
        };
    }
    
    // Calculate totals
    const invoiceItems = items.map(item => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      amount: item.quantity * item.unitPrice,
      taxRate: item.taxRate || 0,
      taxAmount: (item.quantity * item.unitPrice * (item.taxRate || 0)) / 100
    }));
    
    const subtotal = invoiceItems.reduce((sum, item) => sum + item.amount, 0);
    const tax = invoiceItems.reduce((sum, item) => sum + item.taxAmount, 0);
    const totalAmount = subtotal + tax - (discount || 0);
    
    const invoicePayload = {
      invoiceType,
      [invoiceType === 'appointment' ? 'appointmentId' :
       invoiceType === 'pharmacy' ? 'pharmacySaleId' :
       invoiceType === 'lab_test' ? 'labTestId' : null]: referenceId,
      patientId: patient?._id,
      ...customerDetails,
      items: invoiceItems,
      subtotal,
      discount: discount || 0,
      tax,
      totalAmount,
      amountPaid: 0,
      balanceDue: totalAmount,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      notes,
      createdBy: req.user.id
    };
    const invoice = await Invoice.create(
      invoiceType === 'pharmacy' && req.user.role === 'pharmacy'
        ? scopedPayload(req, invoicePayload)
        : invoicePayload
    );
    
    // Generate PDF
    await generateInvoicePDF(invoice);
    
    res.status(201).json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllInvoices = async (req, res) => {
  try {
    const { 
      status,
      invoiceType,
      startDate,
      endDate,
      patientId,
      page = 1,
      limit = 20 
    } = req.query;
    
    const filter = {};
    
    // Role-based filtering
    if (req.user.role === 'patient') {
      filter.patientId = req.user.profileId;
    } else if (req.user.role === 'pharmacy') {
      Object.assign(filter, scopedFilter(req, { invoiceType: 'pharmacy' }));
    } else if (req.user.role === 'admin') {
      if (patientId) filter.patientId = patientId;
    }
    // Doctors, physios, pathology can see invoices related to their services
    
    if (status) filter.status = status;
    if (invoiceType) filter.invoiceType = invoiceType;
    if (startDate && endDate) {
      filter.invoiceDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const invoices = await Invoice.find(filter)
      .populate('patientId', 'name phone')
      .populate('appointmentId', 'appointmentDate')
      .populate('pharmacySaleId', 'saleNumber')
      .populate('labTestId', 'labTestNumber')
      .sort({ invoiceDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Invoice.countDocuments(filter);
    
    // Calculate totals
    const totals = await Invoice.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$totalAmount' },
          totalPaid: { $sum: '$amountPaid' },
          totalDue: { $sum: '$balanceDue' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      invoices,
      totals: totals[0] || { totalAmount: 0, totalPaid: 0, totalDue: 0, count: 0 },
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

exports.getInvoiceById = async (req, res) => {
  try {
    const invoiceFilter = req.user.role === 'pharmacy' ? scopedFilter(req, { _id: req.params.id }) : { _id: req.params.id };
    const invoice = await Invoice.findOne(invoiceFilter)
      .populate('patientId')
      .populate('appointmentId')
      .populate('pharmacySaleId')
      .populate('labTestId')
      .populate('createdBy', 'name email');
    
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    
    // Check authorization
    if (!canViewInvoice(req, invoice)) {
      return res.status(403).json({ message: 'Not authorized to view this invoice' });
    }
    
    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updatePayment = async (req, res) => {
  try {
    const { amount, paymentMethod, paymentReference } = req.body;
    
    const invoiceFilter = req.user.role === 'pharmacy' ? scopedFilter(req, { _id: req.params.id }) : { _id: req.params.id };
    const invoice = await Invoice.findOne(invoiceFilter);
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    
    if (amount > invoice.balanceDue) {
      return res.status(400).json({ message: 'Payment amount exceeds balance due' });
    }
    
    invoice.amountPaid += amount;
    invoice.balanceDue = invoice.totalAmount - invoice.amountPaid;
    
    if (invoice.balanceDue === 0) {
      invoice.status = 'paid';
      invoice.paymentDate = new Date();
    } else if (invoice.amountPaid > 0) {
      invoice.status = 'partial';
    }
    
    invoice.paymentMethod = paymentMethod;
    invoice.paymentReference = paymentReference;
    invoice.updatedBy = req.user.id;
    
    await invoice.save();
    
    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.generateInvoicePDF = async (req, res) => {
  try {
    const invoiceFilter = req.user.role === 'pharmacy' ? scopedFilter(req, { _id: req.params.id }) : { _id: req.params.id };
    const invoice = await Invoice.findOne(invoiceFilter);
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    
    // Check authorization
    if (!canViewInvoice(req, invoice)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    // Generate PDF
    const pdfBuffer = await generateInvoicePDF(invoice);
    
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=invoice_${invoice.invoiceNumber}.pdf`,
      'Content-Length': pdfBuffer.length
    });
    
    res.send(pdfBuffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getInvoiceStats = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'month' } = req.query;
    
    const matchStage = {};
    if (startDate && endDate) {
      matchStage.invoiceDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    // Role-based filtering
    if (req.user.role === 'patient') {
      matchStage.patientId = req.user.profileId;
    } else if (req.user.role === 'pharmacy') {
      Object.assign(matchStage, scopedFilter(req, { invoiceType: 'pharmacy' }));
    }
    
    let groupStage;
    if (groupBy === 'month') {
      groupStage = {
        _id: {
          year: { $year: '$invoiceDate' },
          month: { $month: '$invoiceDate' }
        },
        totalInvoices: { $sum: 1 },
        totalAmount: { $sum: '$totalAmount' },
        totalPaid: { $sum: '$amountPaid' },
        totalDue: { $sum: '$balanceDue' }
      };
    } else if (groupBy === 'type') {
      groupStage = {
        _id: '$invoiceType',
        totalInvoices: { $sum: 1 },
        totalAmount: { $sum: '$totalAmount' },
        totalPaid: { $sum: '$amountPaid' },
        totalDue: { $sum: '$balanceDue' }
      };
    }
    
    const stats = await Invoice.aggregate([
      { $match: matchStage },
      { $group: groupStage },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    
    // Get outstanding invoices
    const outstanding = await Invoice.aggregate([
      {
        $match: {
          ...matchStage,
          status: { $in: ['sent', 'partial', 'overdue'] }
        }
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$totalAmount' },
          totalDue: { $sum: '$balanceDue' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      stats,
      outstanding: outstanding[0] || { totalAmount: 0, totalDue: 0, count: 0 }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper functions
function canViewInvoice(req, invoice) {
  const user = req.user;
  if (user.role === 'admin') return true;

  if (user.role === 'pharmacy') {
    return invoice.invoiceType === 'pharmacy' &&
      String(invoice.organizationId || '') === String(req.tenant?.organizationId || '') &&
      String(invoice.storeId || '') === String(req.tenant?.storeId || '');
  }

  if (user.role === 'patient' &&
      String(invoice.patientId?._id || invoice.patientId || '') === String(user.profileId || '')) {
    return true;
  }

  // Existing professional invoice authorization is preserved for now and will be
  // tightened with appointment ownership in the doctor/appointment phase.
  if ((user.role === 'doctor' || user.role === 'physio') && invoice.appointmentId) {
    return true;
  }

  return false;
}

async function generateInvoicePDF(invoice) {
  // Implementation for PDF generation
  return Buffer.from('PDF content would be here');
}