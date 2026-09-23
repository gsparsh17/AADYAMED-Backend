const Razorpay = require('razorpay');
const CounterPayment = require('../models/CounterPayment');
const PharmacySale = require('../models/PharmacySale');
const EPharmacyOrder = require('../models/EPharmacyOrder');
const { scopedFilter } = require('../utils/tenantScope');

const QR_VALIDITY_MINUTES = 30;

function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID?.trim();
  const key_secret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!key_id || !key_secret) return null;
  return new Razorpay({ key_id, key_secret });
}

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/**
 * What is still owed on a counter sale. A sale can be partly paid in cash and
 * the rest collected by QR, so the QR is raised for the balance, never for the
 * bill total.
 */
function saleOutstanding(sale) {
  const total = Number(sale.totalAmount || 0) - Number(sale.returnedAmount || 0);
  const paid = Number(sale.paidAmount || 0);
  return money(Math.max(0, total - paid));
}

async function loadTarget(req) {
  const { saleId, orderId } = req.body;
  if (!saleId && !orderId) {
    return { error: 'Provide a saleId or an orderId to collect against', status: 400 };
  }
  if (saleId && orderId) {
    return { error: 'Collect against a sale or an order, not both', status: 400 };
  }

  if (saleId) {
    const sale = await PharmacySale.findOne(scopedFilter(req, { _id: saleId }));
    if (!sale) return { error: 'Sale not found in the selected store', status: 404 };
    if (sale.paymentStatus === 'paid') return { error: 'This bill is already paid', status: 409 };
    const amount = saleOutstanding(sale);
    if (amount <= 0) return { error: 'Nothing is outstanding on this bill', status: 409 };
    return { sale, amount, label: sale.invoiceNumber || sale.saleNumber || 'Counter sale' };
  }

  const order = await EPharmacyOrder.findOne({
    _id: orderId,
    organizationId: req.tenant.organizationId,
    storeId: req.tenant.storeId
  });
  if (!order) return { error: 'Order not found in the selected store', status: 404 };
  if (order.paymentStatus === 'paid') return { error: 'This order is already paid', status: 409 };
  if (['cancelled', 'returned'].includes(order.orderStatus)) {
    return { error: 'This order is cancelled and cannot be collected against', status: 409 };
  }
  const amount = money(order.totalAmount);
  if (amount <= 0) return { error: 'Order has no payable amount', status: 400 };
  return { order, amount, label: order.orderNumber || 'Online order' };
}

/**
 * Writes the payment onto whichever record the QR was raised against.
 *
 * Idempotent: the webhook and the polling endpoint can both arrive at this for
 * the same payment, and re-running must not double-count `paidAmount`.
 */
async function applyPayment(counterPayment, { paymentId, amountPaise, vpa }) {
  if (counterPayment.status === 'paid' && counterPayment.razorpayPaymentId === paymentId) {
    return;
  }

  const rupees = money(Number(amountPaise || counterPayment.amountPaise) / 100);

  if (counterPayment.saleId) {
    const sale = await PharmacySale.findById(counterPayment.saleId);
    if (sale) {
      const total = Number(sale.totalAmount || 0) - Number(sale.returnedAmount || 0);
      sale.paidAmount = money(Number(sale.paidAmount || 0) + rupees);
      sale.balanceAmount = money(Math.max(0, total - sale.paidAmount));
      sale.paymentStatus = sale.balanceAmount <= 0 ? 'paid' : 'partial';
      sale.paymentMethod = 'upi';
      sale.paymentReference = paymentId;
      await sale.save();
    }
  } else if (counterPayment.orderId) {
    const order = await EPharmacyOrder.findById(counterPayment.orderId);
    if (order) {
      order.paymentStatus = 'paid';
      order.paymentId = paymentId;
      order.razorpayPaymentId = paymentId;
      order.paymentDate = new Date();
      if (Array.isArray(order.statusHistory)) {
        order.statusHistory.push({
          status: order.orderStatus,
          note: 'Paid at the counter by UPI QR',
          actorId: counterPayment.createdBy,
          at: new Date()
        });
      }
      await order.save();
    }
  }

  counterPayment.status = 'paid';
  counterPayment.razorpayPaymentId = paymentId;
  counterPayment.amountPaidPaise = Number(amountPaise || counterPayment.amountPaise);
  counterPayment.paidAt = counterPayment.paidAt || new Date();
  if (vpa) counterPayment.payerVpa = vpa;
  await counterPayment.save();
}

exports.createQr = async (req, res) => {
  try {
    const gateway = getRazorpay();
    if (!gateway) {
      return res.status(503).json({ success: false, message: 'Razorpay is not configured on the server' });
    }

    const target = await loadTarget(req);
    if (target.error) return res.status(target.status).json({ success: false, message: target.error });

    // Reuse a live QR for the same bill rather than stacking several QRs the
    // customer could each pay.
    const existing = await CounterPayment.findOne({
      organizationId: req.tenant.organizationId,
      storeId: req.tenant.storeId,
      status: 'created',
      ...(target.sale ? { saleId: target.sale._id } : { orderId: target.order._id }),
      amountPaise: toPaise(target.amount),
      closeBy: { $gt: new Date() }
    });
    if (existing) return res.json({ success: true, counterPayment: existing, reused: true });

    const closeBy = new Date(Date.now() + QR_VALIDITY_MINUTES * 60 * 1000);
    const qr = await gateway.qrCode.create({
      type: 'upi_qr',
      name: String(target.label).slice(0, 40),
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: toPaise(target.amount),
      description: `Payment for ${target.label}`,
      close_by: Math.floor(closeBy.getTime() / 1000),
      notes: {
        storeId: String(req.tenant.storeId),
        ...(target.sale ? { saleId: String(target.sale._id) } : { orderId: String(target.order._id) })
      }
    });

    const counterPayment = await CounterPayment.create({
      organizationId: req.tenant.organizationId,
      storeId: req.tenant.storeId,
      saleId: target.sale?._id,
      orderId: target.order?._id,
      amountPaise: toPaise(target.amount),
      qrId: qr.id,
      qrImageUrl: qr.image_url,
      shortUrl: qr.short_url,
      closeBy,
      createdBy: req.user._id
    });

    res.status(201).json({ success: true, counterPayment });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.error?.description || error.message });
  }
};

/**
 * Status of one QR.
 *
 * This reconciles against Razorpay on every call rather than trusting the
 * local row, because the webhook is the *other* way this gets settled and it
 * is only active once RAZORPAY_WEBHOOK_SECRET is configured. Polling has to
 * stand on its own, otherwise a correctly-paid QR would sit "created" forever
 * on any install without webhooks.
 */
exports.getQrStatus = async (req, res) => {
  try {
    const counterPayment = await CounterPayment.findOne({
      _id: req.params.id,
      organizationId: req.tenant.organizationId,
      storeId: req.tenant.storeId
    });
    if (!counterPayment) return res.status(404).json({ success: false, message: 'Payment request not found' });

    if (counterPayment.status === 'created') {
      const gateway = getRazorpay();
      if (gateway) {
        try {
          const payments = await gateway.qrCode.fetchAllPayments(counterPayment.qrId, { count: 10 });
          const captured = (payments?.items || []).find(
            (p) => p.status === 'captured' || p.status === 'authorized'
          );
          if (captured) {
            await applyPayment(counterPayment, {
              paymentId: captured.id,
              amountPaise: captured.amount,
              vpa: captured.vpa || captured.acquirer_data?.upi_transaction_id
            });
          } else if (counterPayment.closeBy && counterPayment.closeBy < new Date()) {
            counterPayment.status = 'expired';
            await counterPayment.save();
          }
        } catch (pollError) {
          // A failed reconcile must not break the poll the till is running —
          // report the row as it stands and let the next tick try again.
          console.error('QR reconcile failed:', pollError.message);
        }
      }
    }

    res.json({ success: true, counterPayment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.closeQr = async (req, res) => {
  try {
    const counterPayment = await CounterPayment.findOne({
      _id: req.params.id,
      organizationId: req.tenant.organizationId,
      storeId: req.tenant.storeId
    });
    if (!counterPayment) return res.status(404).json({ success: false, message: 'Payment request not found' });
    if (counterPayment.status === 'paid') {
      return res.status(409).json({ success: false, message: 'This QR has already been paid' });
    }

    const gateway = getRazorpay();
    if (gateway) {
      try {
        await gateway.qrCode.close(counterPayment.qrId);
      } catch (closeError) {
        // Already closed or expired at Razorpay's end is not a failure here.
        console.error('QR close failed:', closeError.message);
      }
    }

    counterPayment.status = 'closed';
    counterPayment.closedBy = req.user._id;
    counterPayment.closedAt = new Date();
    await counterPayment.save();
    res.json({ success: true, counterPayment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Every QR raised against one bill or order, newest first. */
exports.listForEntity = async (req, res) => {
  try {
    const { saleId, orderId } = req.query;
    if (!saleId && !orderId) {
      return res.status(400).json({ success: false, message: 'Provide saleId or orderId' });
    }
    const payments = await CounterPayment.find({
      organizationId: req.tenant.organizationId,
      storeId: req.tenant.storeId,
      ...(saleId ? { saleId } : { orderId })
    }).sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, counterPayments: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Shared with the Razorpay webhook handler so `qr_code.credited` settles
// through exactly the same code path as polling does.
exports._applyPayment = applyPayment;
exports._getRazorpay = getRazorpay;
