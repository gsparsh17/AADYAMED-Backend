const Commission = require('../models/Commission');
const CommissionSettings = require('../models/CommissionSettings');
const PharmacyProfile = require('../models/PharmacyProfile');
const PharmacyStore = require('../models/PharmacyStore');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/**
 * What the platform keeps on a pharmacy order.
 *
 * Commission is charged on the **merchandise** the pharmacy actually sold —
 * subtotal less discounts — not on the order total. Charging on the total
 * would take a cut of GST the pharmacy remits to the government and of the
 * delivery fee, which is not the pharmacy's revenue at all.
 */
function commissionableAmount(order) {
  const subtotal = Number(order.subtotal || 0);
  const discounts = Number(order.medicineDiscount || 0) + Number(order.couponDiscount || 0);
  return money(Math.max(0, subtotal - discounts));
}

async function pharmacyCommissionRate() {
  const settings = await CommissionSettings.findOne().lean();
  const rate = Number(settings?.defaultPharmacyCommission);
  return Number.isFinite(rate) ? rate : 10;
}

/**
 * Records what the platform owes the pharmacy for one delivered order.
 *
 * Called when an order reaches `delivered` — the point the pharmacy has
 * actually earned the money. Idempotent: the unique sparse index on
 * `pharmacyOrderId` means a re-delivered or replayed order cannot create a
 * second commission row.
 *
 * Never throws: an order must not fail to be marked delivered because
 * settlement bookkeeping had a problem.
 */
async function settlePharmacyOrder(order, actorId) {
  try {
    const existing = await Commission.findOne({ pharmacyOrderId: order._id }).lean();
    if (existing) return existing;

    const store = await PharmacyStore.findById(order.storeId).select('pharmacyProfileId').lean();
    const profileId = store?.pharmacyProfileId
      || (await PharmacyProfile.findOne({ defaultStoreId: order.storeId }).select('_id').lean())?._id;
    if (!profileId) {
      console.error('Pharmacy settlement skipped: no pharmacy profile for store', String(order.storeId));
      return null;
    }

    const gross = commissionableAmount(order);
    const rate = await pharmacyCommissionRate();
    const platformCommission = money((gross * rate) / 100);
    const professionalEarning = money(gross - platformCommission);
    const now = new Date();

    return await Commission.create({
      pharmacyOrderId: order._id,
      storeId: order.storeId,
      professionalId: profileId,
      professionalModel: 'PharmacyProfile',
      professionalType: 'pharmacy',
      patientId: order.patientId,
      consultationFee: gross,
      platformCommission,
      professionalEarning,
      commissionRate: rate,
      finalAmount: professionalEarning,
      payoutStatus: 'pending',
      commissionCycle: {
        month: now.getUTCMonth() + 1,
        year: now.getUTCFullYear(),
        cycleNumber: `${String(now.getUTCMonth() + 1).padStart(2, '0')}${now.getUTCFullYear()}`,
      },
      calculatedAt: now,
      createdBy: actorId,
    });
  } catch (error) {
    if (error?.code === 11000) return null; // raced with another delivery write
    console.error('Pharmacy settlement failed:', error.message);
    return null;
  }
}

/**
 * The store's settlement position: what is owed, what has been paid, and the
 * individual order lines behind both.
 */
async function storeSettlementSummary(storeId, { limit = 50 } = {}) {
  const rate = await pharmacyCommissionRate();
  const [rows, lines] = await Promise.all([
    Commission.aggregate([
      { $match: { storeId, professionalType: 'pharmacy' } },
      { $group: {
        _id: '$payoutStatus',
        orders: { $sum: 1 },
        gross: { $sum: '$consultationFee' },
        commission: { $sum: '$platformCommission' },
        earning: { $sum: '$professionalEarning' },
      } },
    ]),
    Commission.find({ storeId, professionalType: 'pharmacy' })
      .populate('pharmacyOrderId', 'orderNumber totalAmount createdAt orderStatus')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  const byStatus = Object.fromEntries(rows.map((r) => [r._id || 'pending', r]));
  const pending = byStatus.pending || {};
  const paid = byStatus.paid || {};

  return {
    // The rate in force now. Individual rows carry the rate they were settled
    // at, which is what actually governs their amounts — this one only tells
    // the pharmacy what the next order will be charged.
    commissionRate: rate,
    pending: {
      orders: pending.orders || 0,
      gross: money(pending.gross),
      commission: money(pending.commission),
      payable: money(pending.earning),
    },
    paid: {
      orders: paid.orders || 0,
      gross: money(paid.gross),
      commission: money(paid.commission),
      paidOut: money(paid.earning),
    },
    lines,
  };
}

/**
 * What one order would settle at, without writing anything.
 *
 * Lets the pharmacy see the split on an order they are about to accept,
 * rather than discovering it only after delivery.
 */
async function previewOrderSettlement(order) {
  const gross = commissionableAmount(order);
  const rate = await pharmacyCommissionRate();
  const platformCommission = money((gross * rate) / 100);
  return {
    commissionableAmount: gross,
    commissionRate: rate,
    platformCommission,
    pharmacyEarning: money(gross - platformCommission),
    // Stated so the pharmacy can see why this is not simply the order total.
    excluded: {
      tax: money(order.tax),
      deliveryFee: money(order.deliveryFee),
    },
  };
}

module.exports = { settlePharmacyOrder, storeSettlementSummary, commissionableAmount, previewOrderSettlement };
