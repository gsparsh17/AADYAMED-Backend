const Razorpay = require('razorpay');
const Appointment = require('../models/Appointment');
const LabTest = require('../models/LabTest');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

exports.createPaymentOrder = async (req, res) => {
  try {
    const { amount, currency = 'INR', entityType, entityId, notes } = req.body;
    
    const options = {
      amount: amount * 100, // Razorpay expects amount in paise
      currency,
      receipt: `receipt_${Date.now()}`,
      notes: {
        entityType,
        entityId,
        userId: req.user.id,
        ...notes
      }
    };
    
    const order = await razorpay.orders.create(options);
    
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { order_id, payment_id, signature, entityType, entityId } = req.body;
    
    // Verify signature
    const body = order_id + '|' + payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');
    
    if (expectedSignature !== signature) {
      return res.status(400).json({ message: 'Invalid payment signature' });
    }
    
    // Update entity based on type
    if (entityType === 'appointment') {
      await Appointment.findByIdAndUpdate(entityId, {
        paymentStatus: 'paid',
        razorpayOrderId: order_id,
        razorpayPaymentId: payment_id,
        paymentDate: new Date()
      });
    } else if (entityType === 'labtest') {
      await LabTest.findByIdAndUpdate(entityId, {
        paymentStatus: 'paid',
        paymentId: payment_id
      });
    }
    
    // Send payment confirmation
    await sendPaymentConfirmation(req.user.id, entityType, entityId);
    
    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPaymentHistory = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 20 } = req.query;
    
    const filter = {
      $or: [
        { patientId: req.user.profileId },
        { [req.user.role === 'doctor' ? 'doctorId' : 'physioId']: req.user.profileId }
      ],
      paymentStatus: 'paid'
    };
    
    if (startDate && endDate) {
      filter.paymentDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    // Get payments from appointments
    const appointments = await Appointment.find(filter)
      .sort({ paymentDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select('appointmentDate consultationFee platformCommission professionalEarning paymentDate razorpayPaymentId');
    
    // Get payments from lab tests
    const labTests = await LabTest.find({
      patientId: req.user.profileId,
      paymentStatus: 'paid',
      ...(startDate && endDate ? {
        createdAt: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      } : {})
    })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit))
    .select('scheduledDate totalAmount paymentStatus createdAt');
    
    const combined = [...appointments.map(a => ({
      type: 'appointment',
      date: a.paymentDate,
      amount: a.consultationFee,
      reference: a.razorpayPaymentId,
      details: a
    })), ...labTests.map(lt => ({
      type: 'labtest',
      date: lt.createdAt,
      amount: lt.totalAmount,
      reference: lt._id,
      details: lt
    }))].sort((a, b) => b.date - a.date);
    
    res.json({ success: true, payments: combined });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper function
async function sendPaymentConfirmation(userId, entityType, entityId) {
  // Implementation for sending payment confirmation
}