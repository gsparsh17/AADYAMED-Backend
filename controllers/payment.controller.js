const Razorpay = require('razorpay');
const crypto = require('crypto');
const Appointment = require('../models/Appointment');
const LabTest = require('../models/LabTest');
const EPharmacyOrder = require('../models/EPharmacyOrder');
const PaymentAttempt = require('../models/PaymentAttempt');
const PaymentWebhookEvent = require('../models/PaymentWebhookEvent');
const { createNotification } = require('../services/notification.service');
const CounterPayment = require('../models/CounterPayment');
const counterPaymentController = require('./counterPayment.controller');
const { notifyNewPharmacyOrder } = require('../services/pharmacyOrderAlert.service');

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

/**
 * Whether [entity] is finished in a way that can't take money any more:
 * a cancelled / declined / expired / no-show appointment, a cancelled lab
 * order, a cancelled or returned pharmacy order.
 */
function isClosedForPayment(entityType, entity) {
  if (entityType === 'appointment') return ['cancelled', 'rejected', 'no_show'].includes(entity.status);
  if (entityType === 'labtest') return entity.status === 'cancelled';
  if (entityType === 'pharmacy_order') return ['cancelled', 'returned'].includes(entity.orderStatus);
  return false;
}

/**
 * Refunds a payment that cleared for something already closed (the patient
 * was mid-checkout when it was cancelled or expired). The payment is kept on
 * record; the money goes straight back. If the refund can't be made now it
 * is flagged so support can retry it — the order is never revived.
 */
async function refundLatePayment(entityType, entity, paymentId) {
  const amount = Math.round(Number(entity.totalAmount ?? entity.consultationFee ?? 0) * 100);
  const razorpay = getRazorpay();
  const note = 'Payment received after cancellation';
  try {
    if (!razorpay || !paymentId || amount <= 0) throw new Error(razorpay ? 'Nothing to refund' : 'Razorpay is not configured');
    const refund = await razorpay.payments.refund(paymentId, {
      amount,
      notes: { entityType, entityId: String(entity._id), reason: note },
    });
    entity.paymentStatus = 'refunded';
    entity.refundId = refund.id;
    entity.refundedAt = new Date();
    if (entityType === 'pharmacy_order') {
      entity.refundAmount = Math.round(Number(refund.amount || 0)) / 100;
      entity.refundFailure = undefined;
    }
    if (entityType === 'labtest') {
      entity.refundPending = false;
      entity.refundFailureReason = undefined;
    }
    return { refunded: true };
  } catch (error) {
    const reason = error?.error?.description || error.message;
    // Keep it visibly owed: pharmacy and labs have a pending state; an
    // appointment keeps 'paid' with the reason recorded.
    if (entityType === 'pharmacy_order') {
      entity.paymentStatus = 'refund_pending';
      entity.refundFailure = reason;
    } else if (entityType === 'labtest') {
      entity.refundPending = true;
      entity.refundRequestedAt = new Date();
      entity.refundFailureReason = reason;
    } else {
      entity.cancellationReason = `${entity.cancellationReason || 'Cancelled'} — refund pending (${reason})`;
    }
    console.error(`Late-payment refund failed for ${entityType} ${entity._id}:`, reason);
    return { refunded: false, error: reason };
  }
}

async function loadPayableEntity(user, entityType, entityId) {
  const Model = ENTITY_MODELS[entityType];
  if (!Model) return { error: 'Unsupported payment entity type', status: 400 };
  if (!entityId) return { error: 'entityId is required', status: 400 };

  const entity = await Model.findById(entityId);
  if (!entity) return { error: 'Payment entity not found', status: 404 };
  if (!ownsEntity(user, entity)) return { error: 'Not authorized for this payment entity', status: 403 };

  const amount = Number(entity.totalAmount ?? entity.consultationFee ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Entity has no valid payable amount', status: 400 };
  if (entity.paymentStatus === 'paid') return { error: 'This entity is already paid', status: 409, entity, amount };
  // Nothing closed can be paid for: it used to be possible to pay for a
  // declined or cancelled appointment or pharmacy order.
  if (isClosedForPayment(entityType, entity)) {
    return { error: 'This booking is no longer active, so it can’t be paid for', status: 409 };
  }

  return { entity, amount };
}

async function markEntityPaid(attempt, paymentId) {
  const Model = ENTITY_MODELS[attempt.entityType];
  if (!Model) throw new Error('Unsupported payment entity type in payment attempt');
  const entity = await Model.findById(attempt.entityId);
  if (!entity) throw new Error('Payment entity no longer exists');

  if (entity.paymentStatus === 'paid') {
    const sameOrder = entity.razorpayOrderId === attempt.gatewayOrderId;
    const samePayment = (entity.razorpayPaymentId || entity.paymentId) === paymentId;
    if (sameOrder && samePayment) return entity;
    throw new Error('Entity is already paid by another payment');
  }

  if (entity.razorpayOrderId && entity.razorpayOrderId !== attempt.gatewayOrderId) {
    throw new Error('Entity payment order does not match payment attempt');
  }

  entity.paymentStatus = 'paid';
  entity.paymentId = paymentId;
  entity.razorpayPaymentId = paymentId;
  entity.paymentDate = new Date();

  // Cancelled while the patient was paying: record the payment, refund it,
  // and leave the order cancelled. Setting orderStatus below used to bring
  // a cancelled pharmacy order back to 'placed' and keep the money.
  if (isClosedForPayment(attempt.entityType, entity)) {
    await refundLatePayment(attempt.entityType, entity, paymentId);
    if (Array.isArray(entity.statusHistory)) {
      entity.statusHistory.push({
        status: entity.orderStatus || entity.status,
        note: 'Payment arrived after cancellation — refunded',
        at: new Date(),
      });
    }
    await entity.save();
    return entity;
  }

  if (attempt.entityType === 'pharmacy_order') {
    entity.orderStatus = entity.prescriptionRequired && entity.prescriptionStatus === 'pending_review'
      ? 'prescription_review'
      : 'placed';
    if (Array.isArray(entity.statusHistory)) {
      entity.statusHistory.push({
        status: entity.orderStatus,
        note: 'Online payment verified',
        actorId: attempt.userId,
        at: new Date(),
      });
    }
  }

  await entity.save();

  // A prepaid pharmacy order only reaches the store once payment clears, so
  // this is the moment it becomes a new order from their point of view.
  if (attempt.entityType === 'pharmacy_order') await notifyNewPharmacyOrder(entity);

  return entity;
}

async function notifyPayment(attempt) {
  try {
    await createNotification({
      userId: attempt.userId,
      title: 'Payment successful',
      message: 'Your payment has been confirmed successfully.',
      type: 'payment',
      channels: ['in_app', 'push'],
      relatedEntity: attempt.entityType,
      relatedEntityId: attempt.entityId,
      data: { entityType: attempt.entityType, entityId: String(attempt.entityId) },
      actionUrl: '/payments',
    });
  } catch (error) {
    console.error('Payment notification failed:', error.message);
  }
}

exports.createPaymentOrder = async (req, res) => {
  try {
    const { entityType, entityId, currency = 'INR' } = req.body;
    const loaded = await loadPayableEntity(req.user, entityType, entityId);
    if (loaded.error) return res.status(loaded.status).json({ success: false, message: loaded.error });

    const amountPaise = Math.round(loaded.amount * 100);
    const idempotencyKey = req.get('Idempotency-Key')?.trim();

    if (idempotencyKey) {
      const existing = await PaymentAttempt.findOne({ userId: req.user.id, idempotencyKey });
      if (existing) {
        const sameRequest = existing.entityType === entityType
          && String(existing.entityId) === String(entityId)
          && existing.amountPaise === amountPaise;
        if (!sameRequest) {
          return res.status(409).json({ success: false, message: 'Idempotency key was already used for another payment request' });
        }
        return res.json({
          success: true,
          idempotent: true,
          order: {
            id: existing.gatewayOrderId,
            amount: existing.amountPaise,
            currency: existing.currency,
          },
          payable: { entityType, entityId, amount: loaded.amount, currency: existing.currency },
          keyId: process.env.RAZORPAY_KEY_ID?.trim(),
        });
      }
    }

    const gateway = getRazorpay();
    if (!gateway) return res.status(500).json({ success: false, message: 'Payment gateway configuration error' });

    const order = await gateway.client.orders.create({
      amount: amountPaise,
      currency,
      receipt: `${entityType}_${String(entityId).slice(-12)}_${Date.now()}`.slice(0, 40),
      notes: { entityType, entityId: String(entityId), userId: String(req.user.id) },
    });

    const attempt = await PaymentAttempt.create({
      userId: req.user.id,
      entityType,
      entityId,
      amountPaise,
      currency: String(currency).toUpperCase(),
      gatewayOrderId: order.id,
      idempotencyKey: idempotencyKey || undefined,
      metadata: { receipt: order.receipt },
    });

    loaded.entity.razorpayOrderId = order.id;
    await loaded.entity.save();

    res.json({
      success: true,
      order,
      paymentAttemptId: attempt._id,
      payable: { entityType, entityId, amount: loaded.amount, currency },
      // The publishable key id (it's in every Checkout page anyway), so the
      // app doesn't need it baked in at build time.
      keyId: process.env.RAZORPAY_KEY_ID?.trim(),
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
    if (!order_id || !payment_id || !signature || !entityType || !entityId) {
      return res.status(400).json({ success: false, message: 'Payment verification fields are required' });
    }

    const attempt = await PaymentAttempt.findOne({ gatewayOrderId: order_id });
    if (!attempt) return res.status(404).json({ success: false, message: 'Payment attempt not found' });
    if (String(attempt.userId) !== String(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized for this payment attempt' });
    }
    if (attempt.entityType !== entityType || String(attempt.entityId) !== String(entityId)) {
      return res.status(400).json({ success: false, message: 'Payment attempt does not match supplied entity' });
    }

    if (attempt.status === 'captured') {
      if (attempt.gatewayPaymentId === payment_id) return res.json({ success: true, message: 'Payment already verified' });
      return res.status(409).json({ success: false, message: 'Payment attempt was already captured by another payment' });
    }

    const gateway = getRazorpay();
    if (!gateway) return res.status(500).json({ success: false, message: 'Payment gateway configuration error' });

    const expectedSignature = crypto
      .createHmac('sha256', gateway.key_secret)
      .update(`${order_id}|${payment_id}`)
      .digest('hex');

    const provided = Buffer.from(String(signature));
    const expected = Buffer.from(expectedSignature);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    await markEntityPaid(attempt, payment_id);
    attempt.gatewayPaymentId = payment_id;
    attempt.status = 'captured';
    attempt.verifiedAt = new Date();
    attempt.capturedAt = new Date();
    await attempt.save();
    await notifyPayment(attempt);

    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.handleRazorpayWebhook = async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const signature = req.get('x-razorpay-signature');
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();

  if (!webhookSecret) return res.status(503).json({ success: false, message: 'Webhook secret is not configured' });
  if (!signature) return res.status(400).json({ success: false, message: 'Missing webhook signature' });

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(String(signature));
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (_error) {
    return res.status(400).json({ success: false, message: 'Invalid webhook JSON' });
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const eventKey = req.get('x-razorpay-event-id') || payloadHash;
  let eventDoc;
  try {
    eventDoc = await PaymentWebhookEvent.create({
      eventKey,
      eventType: payload.event || 'unknown',
      payloadHash,
      status: 'processing',
    });
  } catch (error) {
    if (error?.code === 11000) return res.json({ success: true, duplicate: true });
    throw error;
  }

  try {
    const payment = payload.payload?.payment?.entity;
    const refund = payload.payload?.refund?.entity;
    const qrCode = payload.payload?.qr_code?.entity;

    // Counter QR collection. A QR payment has no Razorpay *order* id, so it
    // never matches a PaymentAttempt — it settles against CounterPayment
    // instead, through the same applyPayment() the polling endpoint uses.
    if (payload.event === 'qr_code.credited' && qrCode?.id && payment?.id) {
      const counterPayment = await CounterPayment.findOne({ qrId: qrCode.id });
      if (!counterPayment) throw new Error('Counter payment not found for credited QR');
      await counterPaymentController._applyPayment(counterPayment, {
        paymentId: payment.id,
        amountPaise: payment.amount,
        vpa: payment.vpa,
      });
      eventDoc.gatewayPaymentId = payment.id;
      eventDoc.status = 'processed';
    } else if (payload.event === 'payment.captured' && payment?.order_id) {
      const attempt = await PaymentAttempt.findOne({ gatewayOrderId: payment.order_id });
      if (!attempt) throw new Error('Payment attempt not found for captured payment');
      if (Number(payment.amount) !== Number(attempt.amountPaise)) throw new Error('Captured amount does not match payment attempt');
      if (payment.currency && String(payment.currency).toUpperCase() !== attempt.currency) throw new Error('Captured currency does not match payment attempt');

      const alreadyCaptured = attempt.status === 'captured';
      await markEntityPaid(attempt, payment.id);
      attempt.gatewayPaymentId = payment.id;
      attempt.status = 'captured';
      attempt.capturedAt = attempt.capturedAt || new Date();
      attempt.verifiedAt = attempt.verifiedAt || new Date();
      await attempt.save();
      if (!alreadyCaptured) await notifyPayment(attempt);
      eventDoc.gatewayOrderId = payment.order_id;
      eventDoc.gatewayPaymentId = payment.id;
      eventDoc.status = 'processed';
    } else if (payload.event === 'payment.failed' && payment?.order_id) {
      await PaymentAttempt.findOneAndUpdate(
        { gatewayOrderId: payment.order_id },
        {
          $set: {
            status: 'failed',
            gatewayPaymentId: payment.id,
            failureCode: payment.error_code,
            failureDescription: payment.error_description,
          },
        },
      );
      eventDoc.gatewayOrderId = payment.order_id;
      eventDoc.gatewayPaymentId = payment.id;
      eventDoc.status = 'processed';
    } else if (payload.event === 'refund.processed' && refund?.payment_id) {
      const attempt = await PaymentAttempt.findOne({ gatewayPaymentId: refund.payment_id });
      if (attempt) {
        attempt.status = 'refunded';
        attempt.refundedAt = new Date();
        await attempt.save();
        const Model = ENTITY_MODELS[attempt.entityType];
        await Model.findByIdAndUpdate(attempt.entityId, { $set: { paymentStatus: 'refunded' } });
      }
      eventDoc.gatewayPaymentId = refund.payment_id;
      eventDoc.status = 'processed';
    } else {
      eventDoc.status = 'ignored';
    }

    eventDoc.processedAt = new Date();
    await eventDoc.save();
    return res.json({ success: true });
  } catch (error) {
    eventDoc.status = 'failed';
    eventDoc.error = error.message;
    eventDoc.processedAt = new Date();
    await eventDoc.save();
    console.error('Razorpay webhook processing failed:', error);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
};

exports.getPaymentHistory = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 20 } = req.query;
    const dateFilter = startDate && endDate ? { $gte: new Date(startDate), $lte: new Date(endDate) } : null;
    const appointmentFilter = { paymentStatus: 'paid' };
    const labFilter = { paymentStatus: 'paid' };
    const pharmacyFilter = { paymentStatus: 'paid' };

    if (req.user.role === 'patient') {
      appointmentFilter.patientId = req.user.profileId;
      labFilter.patientId = req.user.profileId;
      pharmacyFilter.patientId = req.user.profileId;
    } else if (req.user.role === 'doctor') {
      appointmentFilter.doctorId = req.user.profileId;
      labFilter._id = null;
      pharmacyFilter._id = null;
    } else if (req.user.role === 'physio') {
      appointmentFilter.physioId = req.user.profileId;
      labFilter._id = null;
      pharmacyFilter._id = null;
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to view payment history' });
    }

    if (dateFilter) {
      appointmentFilter.paymentDate = dateFilter;
      labFilter.paymentDate = dateFilter;
      pharmacyFilter.paymentDate = dateFilter;
    }

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [appointments, labTests, pharmacyOrders, appointmentCount, labCount, pharmacyCount] = await Promise.all([
      Appointment.find(appointmentFilter).sort({ paymentDate: -1 }).limit(pageNumber * pageSize)
        .select('appointmentDate totalAmount consultationFee platformCommission professionalEarning paymentDate razorpayPaymentId paymentId'),
      LabTest.find(labFilter).sort({ paymentDate: -1 }).limit(pageNumber * pageSize)
        .select('scheduledDate totalAmount paymentStatus paymentDate razorpayPaymentId paymentId'),
      EPharmacyOrder.find(pharmacyFilter).sort({ paymentDate: -1 }).limit(pageNumber * pageSize)
        .select('orderNumber totalAmount paymentStatus paymentDate razorpayPaymentId paymentId orderStatus'),
      Appointment.countDocuments(appointmentFilter),
      LabTest.countDocuments(labFilter),
      EPharmacyOrder.countDocuments(pharmacyFilter),
    ]);

    const combined = [
      ...appointments.map((a) => ({ type: 'appointment', date: a.paymentDate, amount: a.totalAmount ?? a.consultationFee, reference: a.razorpayPaymentId, details: a })),
      ...labTests.map((lt) => ({ type: 'labtest', date: lt.paymentDate, amount: lt.totalAmount, reference: lt.razorpayPaymentId || lt.paymentId, details: lt })),
      ...pharmacyOrders.map((o) => ({ type: 'pharmacy_order', date: o.paymentDate, amount: o.totalAmount, reference: o.razorpayPaymentId || o.paymentId, details: o })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    const start = (pageNumber - 1) * pageSize;
    res.json({
      success: true,
      payments: combined.slice(start, start + pageSize),
      pagination: { page: pageNumber, limit: pageSize, total: appointmentCount + labCount + pharmacyCount },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// For tests.
exports._markEntityPaid = markEntityPaid;
exports._loadPayableEntity = loadPayableEntity;
