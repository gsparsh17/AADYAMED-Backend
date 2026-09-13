const Razorpay = require('razorpay');
const crypto = require('crypto');
const Appointment = require('../models/Appointment');
const LabTest = require('../models/LabTest');
const EPharmacyOrder = require('../models/EPharmacyOrder');

const ENTITY_MODELS = {
  appointment: Appointment,
  labtest: LabTest,
  pharmacy_order: EPharmacyOrder,
};

function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID?.trim();
  const key_secret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!key_id || !key_secret) return null;
  return { client: new Razorpay({ key_id, key_secret }), key_secret };
}

function ownsEntity(user, entity) {
  if (user.role === 'admin') return true;
  return user.role === 'patient' && user.profileId && String(entity.patientId) === String(user.profileId);
}

async function loadPayableEntity(user, entityType, entityId) {
  const Model = ENTITY_MODELS[entityType];
  if (!Model) return { error: 'Unsupported payment entity type', status: 400 };
  if (!entityId) return { error: 'entityId is required', status: 400 };

  const entity = await Model.findById(entityId);
  if (!entity) return { error: 'Payment entity not found', status: 404 };
  if (!ownsEntity(user, entity)) return { error: 'Not authorized for this payment entity', status: 403 };

  const amount = Number(entity.totalAmount ?? entity.consultationFee ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'Entity has no valid payable amount', status: 400 };
  }
  if (entity.paymentStatus === 'paid') {
    return { error: 'This entity is already paid', status: 409 };
  }

  return { entity, amount };
}

exports.createPaymentOrder = async (req, res) => {
  try {
    const { entityType, entityId, currency = 'INR' } = req.body;
    const loaded = await loadPayableEntity(req.user, entityType, entityId);
    if (loaded.error) return res.status(loaded.status).json({ success: false, message: loaded.error });

    const gateway = getRazorpay();
    if (!gateway) {
      return res.status(500).json({ success: false, message: 'Payment gateway configuration error' });
    }

    // SECURITY: amount is derived from the server-side entity, never from req.body.amount.
    const amountPaise = Math.round(loaded.amount * 100);
    const order = await gateway.client.orders.create({
      amount: amountPaise,
      currency,
      receipt: `${entityType}_${String(entityId).slice(-12)}_${Date.now()}`.slice(0, 40),
      notes: {
        entityType,
        entityId: String(entityId),
        userId: String(req.user.id),
      },
    });

    loaded.entity.razorpayOrderId = order.id;
    await loaded.entity.save();

    res.json({
      success: true,
      order,
      payable: { entityType, entityId, amount: loaded.amount, currency },
    });
  } catch (error) {
    console.error('Razorpay create order error:', error);
    const errorMessage = error.error?.description || error.message || 'Razorpay order creation failed';
    res.status(500).json({ success: false, message: errorMessage });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { order_id, payment_id, signature, entityType, entityId } = req.body;
    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ success: false, message: 'Payment verification fields are required' });
    }

    const loaded = await loadPayableEntity(req.user, entityType, entityId);
    if (loaded.error && loaded.status !== 409) {
      return res.status(loaded.status).json({ success: false, message: loaded.error });
    }

    // If it is already paid, return idempotent success only for the same payment/order.
    const Model = ENTITY_MODELS[entityType];
    const entity = loaded.entity || await Model.findById(entityId);
    if (!entity || !ownsEntity(req.user, entity)) {
      return res.status(403).json({ success: false, message: 'Not authorized for this payment entity' });
    }

    if (entity.paymentStatus === 'paid') {
      const sameOrder = entity.razorpayOrderId === order_id;
      const samePayment = (entity.razorpayPaymentId || entity.paymentId) === payment_id;
      if (sameOrder && samePayment) {
        return res.json({ success: true, message: 'Payment already verified' });
      }
      return res.status(409).json({ success: false, message: 'Entity is already paid by another payment' });
    }

    if (!entity.razorpayOrderId || entity.razorpayOrderId !== order_id) {
      return res.status(400).json({ success: false, message: 'Payment order does not match this entity' });
    }

    const gateway = getRazorpay();
    if (!gateway) {
      return res.status(500).json({ success: false, message: 'Payment gateway configuration error' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', gateway.key_secret)
      .update(`${order_id}|${payment_id}`)
      .digest('hex');

    const provided = Buffer.from(String(signature));
    const expected = Buffer.from(expectedSignature);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    entity.paymentStatus = 'paid';
    entity.paymentId = payment_id;
    entity.razorpayPaymentId = payment_id;
    entity.paymentDate = new Date();
    if (entityType === 'pharmacy_order') {
      entity.orderStatus = entity.prescriptionRequired && entity.prescriptionStatus === 'pending_review'
        ? 'prescription_review'
        : 'placed';
      if (Array.isArray(entity.statusHistory)) {
        entity.statusHistory.push({ status: entity.orderStatus, note: 'Online payment verified', actorId: req.user.id, at: new Date() });
      }
    }
    await entity.save();

    await sendPaymentConfirmation(req.user.id, entityType, entityId);
    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPaymentHistory = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 20 } = req.query;
    const dateFilter = startDate && endDate ? { $gte: new Date(startDate), $lte: new Date(endDate) } : null;

    const appointmentFilter = { paymentStatus: 'paid' };
    const labFilter = { paymentStatus: 'paid' };

    if (req.user.role === 'patient') {
      appointmentFilter.patientId = req.user.profileId;
      labFilter.patientId = req.user.profileId;
    } else if (req.user.role === 'doctor') {
      appointmentFilter.doctorId = req.user.profileId;
      // Doctors do not own lab payments; keep lab list empty below.
      labFilter._id = null;
    } else if (req.user.role === 'physio') {
      appointmentFilter.physioId = req.user.profileId;
      labFilter._id = null;
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to view payment history' });
    }

    if (dateFilter) {
      appointmentFilter.paymentDate = dateFilter;
      labFilter.paymentDate = dateFilter;
    }

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [appointments, labTests] = await Promise.all([
      Appointment.find(appointmentFilter)
        .sort({ paymentDate: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .select('appointmentDate totalAmount consultationFee platformCommission professionalEarning paymentDate razorpayPaymentId'),
      LabTest.find(labFilter)
        .sort({ paymentDate: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .select('scheduledDate totalAmount paymentStatus paymentDate razorpayPaymentId'),
    ]);

    const combined = [
      ...appointments.map((a) => ({
        type: 'appointment', date: a.paymentDate, amount: a.totalAmount ?? a.consultationFee,
        reference: a.razorpayPaymentId, details: a,
      })),
      ...labTests.map((lt) => ({
        type: 'labtest', date: lt.paymentDate, amount: lt.totalAmount,
        reference: lt.razorpayPaymentId || lt.paymentId, details: lt,
      })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ success: true, payments: combined });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

async function sendPaymentConfirmation(userId, entityType, entityId) {
  // Notification integration is intentionally deferred to a later phase.
  void userId; void entityType; void entityId;
}
