const Appointment = require('../models/Appointment');
const Invoice = require('../models/Invoice');
const Commission = require('../models/Commission');
const CommissionSettings = require('../models/CommissionSettings');

exports.generateAppointmentBill = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    
    const appointment = await Appointment.findById(appointmentId)
      .populate('patientId', 'name phone email address')
      .populate('doctorId', 'name specialization consultationFee')
      .populate('physioId', 'name specialization consultationFee homeVisitFee');
    
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    
    // Check if invoice already exists
    const existingInvoice = await Invoice.findOne({ appointmentId });
    if (existingInvoice) {
      return res.json({ success: true, invoice: existingInvoice });
    }
    
    const professional = appointment.professionalType === 'doctor' 
      ? appointment.doctorId 
      : appointment.physioId;
    
    const consultationFee = appointment.consultationFee;
    const homeVisitCharges = appointment.type === 'home' ? professional.homeVisitFee || 0 : 0;
    
    // Get commission settings
    const settings = await CommissionSettings.getSettings();
    const commissionRate = appointment.professionalType === 'doctor' 
      ? settings.defaultDoctorCommission 
      : settings.defaultPhysioCommission;
    
    const platformCommission = (consultationFee * commissionRate) / 100;
    const professionalEarning = consultationFee - platformCommission;
    
    // Create invoice items
    const items = [
      {
        description: `Consultation Fee - ${appointment.professionalType === 'doctor' ? 'Dr.' : ''} ${professional.name}`,
        quantity: 1,
        unitPrice: consultationFee,
        amount: consultationFee,
        taxRate: settings.taxRate || 0,
        taxAmount: (consultationFee * (settings.taxRate || 0)) / 100
      }
    ];
    
    if (homeVisitCharges > 0) {
      items.push({
        description: 'Home Visit Charges',
        quantity: 1,
        unitPrice: homeVisitCharges,
        amount: homeVisitCharges,
        taxRate: settings.taxRate || 0,
        taxAmount: (homeVisitCharges * (settings.taxRate || 0)) / 100
      });
    }
    
    const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
    const tax = items.reduce((sum, item) => sum + item.taxAmount, 0);
    const totalAmount = subtotal + tax;
    
    // Create invoice
    const invoice = await Invoice.create({
      invoiceType: 'appointment',
      appointmentId,
      patientId: appointment.patientId._id,
      customerName: appointment.patientId.name,
      customerPhone: appointment.patientId.phone,
      customerEmail: appointment.patientId.email,
      customerAddress: appointment.patientId.address,
      items,
      subtotal,
      tax,
      totalAmount,
      amountPaid: appointment.paymentStatus === 'paid' ? totalAmount : 0,
      balanceDue: appointment.paymentStatus === 'paid' ? 0 : totalAmount,
      status: appointment.paymentStatus === 'paid' ? 'paid' : 'sent',
      paymentMethod: appointment.paymentStatus === 'paid' ? appointment.paymentMethod : undefined,
      commissionIncluded: true,
      commissionAmount: platformCommission,
      createdBy: req.user.id
    });
    
    // Update appointment with invoice
    appointment.invoiceId = invoice._id;
    await appointment.save();
    
    // Create commission record if not exists
    const existingCommission = await Commission.findOne({ appointmentId });
    if (!existingCommission) {
      await Commission.create({
        appointmentId,
        professionalId: appointment.professionalType === 'doctor' ? appointment.doctorId : appointment.physioId,
        professionalType: appointment.professionalType,
        patientId: appointment.patientId._id,
        consultationFee,
        platformCommission,
        professionalEarning,
        commissionRate,
        commissionCycle: {
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          cycleNumber: `${(new Date().getMonth() + 1).toString().padStart(2, '0')}${new Date().getFullYear()}`
        }
      });
    }
    
    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.generatePharmacyBill = async (req, res) => {
  try {
    const { pharmacySaleId } = req.params;
    
    const pharmacySale = await PharmacySale.findById(pharmacySaleId)
      .populate('patientId', 'name phone email address');
    
    if (!pharmacySale) {
      return res.status(404).json({ message: 'Pharmacy sale not found' });
    }
    
    // Check if invoice already exists
    const existingInvoice = await Invoice.findOne({ pharmacySaleId });
    if (existingInvoice) {
      return res.json({ success: true, invoice: existingInvoice });
    }
    
    // Create invoice items from sale items
    const items = pharmacySale.items.map(item => ({
      description: item.medicineName,
      quantity: item.quantity,
      unitPrice: item.sellingPrice,
      amount: item.quantity * item.sellingPrice,
      taxRate: item.taxRate || 0,
      taxAmount: (item.quantity * item.sellingPrice * (item.taxRate || 0)) / 100
    }));
    
    const subtotal = pharmacySale.subtotal;
    const tax = pharmacySale.tax;
    const totalAmount = pharmacySale.totalAmount;
    
    const customerDetails = pharmacySale.patientId ? {
      customerName: pharmacySale.patientId.name,
      customerPhone: pharmacySale.patientId.phone,
      customerEmail: pharmacySale.patientId.email,
      customerAddress: pharmacySale.patientId.address
    } : {
      customerName: pharmacySale.customerName,
      customerPhone: pharmacySale.customerPhone,
      customerEmail: pharmacySale.customerEmail,
      customerAddress: pharmacySale.customerAddress
    };
    
    // Create invoice
    const invoice = await Invoice.create({
      invoiceType: 'pharmacy',
      pharmacySaleId,
      patientId: pharmacySale.patientId?._id,
      ...customerDetails,
      items,
      subtotal,
      discount: pharmacySale.discount || 0,
      tax,
      totalAmount,
      amountPaid: pharmacySale.paymentStatus === 'paid' ? totalAmount : 0,
      balanceDue: pharmacySale.paymentStatus === 'paid' ? 0 : totalAmount,
      status: pharmacySale.paymentStatus === 'paid' ? 'paid' : 'sent',
      paymentMethod: pharmacySale.paymentStatus === 'paid' ? pharmacySale.paymentMethod : undefined,
      createdBy: req.user.id
    });
    
    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.generateLabTestBill = async (req, res) => {
  try {
    const { labTestId } = req.params;
    
    const labTest = await LabTest.findById(labTestId)
      .populate('patientId', 'name phone email address')
      .populate('pathologyId', 'labName');
    
    if (!labTest) {
      return res.status(404).json({ message: 'Lab test not found' });
    }
    
    // Check if invoice already exists
    const existingInvoice = await Invoice.findOne({ labTestId });
    if (existingInvoice) {
      return res.json({ success: true, invoice: existingInvoice });
    }
    
    // Create invoice items from lab tests
    const items = labTest.tests.map(test => ({
      description: test.testName,
      quantity: 1,
      unitPrice: test.price,
      amount: test.price,
      taxRate: 0, // Medical tests might be tax-free
      taxAmount: 0
    }));
    
    const subtotal = labTest.totalAmount;
    const totalAmount = labTest.totalAmount;
    
    // Create invoice
    const invoice = await Invoice.create({
      invoiceType: 'lab_test',
      labTestId,
      patientId: labTest.patientId._id,
      customerName: labTest.patientId.name,
      customerPhone: labTest.patientId.phone,
      customerEmail: labTest.patientId.email,
      customerAddress: labTest.patientId.address,
      items,
      subtotal,
      totalAmount,
      amountPaid: labTest.paymentStatus === 'paid' ? totalAmount : 0,
      balanceDue: labTest.paymentStatus === 'paid' ? 0 : totalAmount,
      status: labTest.paymentStatus === 'paid' ? 'paid' : 'sent',
      paymentMethod: labTest.paymentStatus === 'paid' ? labTest.paymentMethod : undefined,
      createdBy: req.user.id
    });
    
    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getBillingSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
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
    }
    
    const summary = await Invoice.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$invoiceType',
          totalInvoices: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' },
          totalPaid: { $sum: '$amountPaid' },
          totalDue: { $sum: '$balanceDue' },
          averageInvoice: { $avg: '$totalAmount' }
        }
      }
    ]);
    
    // Get daily revenue for chart
    const dailyRevenue = await Invoice.aggregate([
      { 
        $match: { 
          ...matchStage,
          status: 'paid'
        } 
      },
      {
        $group: {
          _id: {
            year: { $year: '$invoiceDate' },
            month: { $month: '$invoiceDate' },
            day: { $dayOfMonth: '$invoiceDate' }
          },
          totalRevenue: { $sum: '$totalAmount' },
          invoiceCount: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      { $limit: 30 }
    ]);
    
    res.json({ 
      success: true, 
      summary, 
      dailyRevenue 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.processRefund = async (req, res) => {
  try {
    const { invoiceId, refundAmount, reason } = req.body;
    
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    
    if (refundAmount > invoice.amountPaid) {
      return res.status(400).json({ message: 'Refund amount exceeds paid amount' });
    }
    
    // Update invoice
    invoice.amountPaid -= refundAmount;
    invoice.balanceDue += refundAmount;
    invoice.status = 'refunded';
    invoice.notes = `${invoice.notes || ''}\nRefund processed: ${refundAmount} - Reason: ${reason}`;
    invoice.updatedBy = req.user.id;
    
    await invoice.save();
    
    // Handle commission reversal if applicable
    if (invoice.commissionIncluded && invoice.commissionAmount > 0) {
      await reverseCommission(invoice);
    }
    
    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper function
async function reverseCommission(invoice) {
  if (invoice.appointmentId) {
    const commission = await Commission.findOne({ appointmentId: invoice.appointmentId });
    if (commission) {
      // Mark commission as refunded or adjust
      commission.payoutStatus = 'cancelled';
      commission.notes = `Commission reversed due to invoice refund: ${invoice.invoiceNumber}`;
      await commission.save();
    }
  }
}