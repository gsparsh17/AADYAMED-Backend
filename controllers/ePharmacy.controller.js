const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const PharmacyStore = require('../models/PharmacyStore');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const PatientProfile = require('../models/PatientProfile');
const EPharmacyAddress = require('../models/EPharmacyAddress');
const EPharmacyCart = require('../models/EPharmacyCart');
const EPharmacyPrescriptionUpload = require('../models/EPharmacyPrescriptionUpload');
const EPharmacyCoupon = require('../models/EPharmacyCoupon');
const EPharmacyOrder = require('../models/EPharmacyOrder');
const PharmacySale = require('../models/PharmacySale');
const { consumeFefo, addToBatch } = require('../services/inventory.service');

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = value => String(value || '').trim().toLowerCase();

function getRazorpayClient() {
  const key_id = process.env.RAZORPAY_KEY_ID?.trim();
  const key_secret = process.env.RAZORPAY_KEY_SECRET?.trim();
  return key_id && key_secret ? new Razorpay({ key_id, key_secret }) : null;
}

async function releaseCoupon(order) {
  if (!order?.couponId) return false;
  const coupon = await EPharmacyCoupon.findOne({ _id: order.couponId, 'redemptions.orderId': order._id }).select('_id');
  if (!coupon) return false;
  await EPharmacyCoupon.updateOne(
    { _id: order.couponId, 'redemptions.orderId': order._id },
    { $pull: { redemptions: { orderId: order._id } }, $inc: { usageCount: -1 } }
  );
  // Defensive clamp for legacy/manual data.
  await EPharmacyCoupon.updateOne({ _id: order.couponId, usageCount: { $lt: 0 } }, { $set: { usageCount: 0 } });
  return true;
}

async function refundOnlinePayment(order, reason) {
  if (!order || order.paymentMethod !== 'online') return { attempted: false };
  if (order.paymentStatus === 'refunded') return { attempted: false, refunded: true };
  if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refund_pending') return { attempted: false };
  if (!order.razorpayPaymentId && !order.paymentId) {
    order.paymentStatus = 'refund_pending';
    order.refundFailure = 'Payment ID is unavailable';
    return { attempted: false, pending: true };
  }
  const gateway = getRazorpayClient();
  if (!gateway) {
    order.paymentStatus = 'refund_pending';
    order.refundFailure = 'Razorpay is not configured';
    return { attempted: false, pending: true };
  }
  try {
    const refund = await gateway.payments.refund(order.razorpayPaymentId || order.paymentId, {
      amount: Math.round(Number(order.totalAmount || 0) * 100),
      notes: { orderNumber: order.orderNumber, reason: String(reason || 'Order cancelled').slice(0, 240) }
    });
    order.paymentStatus = 'refunded';
    order.refundId = refund.id;
    order.refundAmount = money(Number(refund.amount || 0) / 100);
    order.refundedAt = new Date();
    order.refundFailure = undefined;
    return { attempted: true, refunded: true, refundId: refund.id };
  } catch (error) {
    order.paymentStatus = 'refund_pending';
    order.refundFailure = error.error?.description || error.message || 'Refund failed';
    return { attempted: true, pending: true, error: order.refundFailure };
  }
}

async function finalizeCancellation(order, reason, actorId) {
  const wasCancelled = order.orderStatus === 'cancelled';
  order.orderStatus = 'cancelled';
  order.cancellationReason = reason || order.cancellationReason || 'Order cancelled';
  order.cancelledAt = order.cancelledAt || new Date();
  order.cancelledBy = actorId || order.cancelledBy;
  if (!wasCancelled) {
    order.statusHistory.push({ status: 'cancelled', note: order.cancellationReason, actorId });
    await releaseCoupon(order);
  }
  const refund = await refundOnlinePayment(order, order.cancellationReason);
  await order.save();
  return refund;
}

function requirePatient(req) {
  if (req.user?.role !== 'patient' || !req.user.profileId) {
    const error = new Error('A patient profile is required');
    error.statusCode = 403;
    throw error;
  }
  return req.user.profileId;
}

function ecommerceSettings(store) {
  return {
    ecommerceEnabled: store.ecommerce?.enabled !== false,
    serviceablePincodes: store.ecommerce?.serviceablePincodes || [],
    minOrderAmount: Number(store.ecommerce?.minOrderAmount || 0),
    deliveryFee: Number(store.ecommerce?.deliveryFee || 0),
    freeDeliveryThreshold: Number(store.ecommerce?.freeDeliveryThreshold || 0),
    codEnabled: store.ecommerce?.codEnabled !== false,
    onlinePaymentEnabled: store.ecommerce?.onlinePaymentEnabled !== false,
    estimatedDeliveryMinutes: Number(store.ecommerce?.estimatedDeliveryMinutes || 120),
    allowReturns: store.ecommerce?.allowReturns !== false,
  };
}

function isPincodeServiceable(store, pincode) {
  const pins = ecommerceSettings(store).serviceablePincodes.filter(Boolean);
  return !pins.length || !pincode || pins.includes(String(pincode));
}

function linePrice(medicine, quantity) {
  const qty = Math.max(1, Number(quantity) || 1);
  const unitPrice = money(medicine.sellingPrice || 0);
  const listedAmount = money(unitPrice * qty);
  const discountPct = Math.min(100, Math.max(0, Number(medicine.discount || 0)));
  const medicineDiscount = money(listedAmount * discountPct / 100);
  const discountedGross = money(listedAmount - medicineDiscount);
  const taxRate = Math.max(0, Number(medicine.taxRate || 0));
  const includesTax = medicine.priceIncludesTax !== false;
  const taxableAmount = taxRate > 0 && includesTax
    ? money(discountedGross / (1 + taxRate / 100))
    : discountedGross;
  const taxAmount = taxRate > 0
    ? (includesTax ? money(discountedGross - taxableAmount) : money(taxableAmount * taxRate / 100))
    : 0;
  return {
    unitPrice, listedAmount, medicineDiscount, taxableAmount, taxRate, taxAmount,
    totalAmount: money(taxableAmount + taxAmount)
  };
}

async function getStore(storeId) {
  if (!mongoose.isValidObjectId(storeId)) return null;
  return PharmacyStore.findOne({ _id: storeId, status: 'active', 'ecommerce.enabled': { $ne: false } });
}

async function resolveCoupon({ code, store, patientId, merchandiseTotal }) {
  if (!code) return { coupon: null, discount: 0 };
  const now = new Date();
  const coupon = await EPharmacyCoupon.findOne({
    storeId: store._id,
    code: String(code).trim().toUpperCase(),
    isActive: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] },
    ]
  });
  if (!coupon) {
    const error = new Error('Coupon is invalid or expired');
    error.statusCode = 400;
    throw error;
  }
  if (merchandiseTotal < Number(coupon.minOrderAmount || 0)) {
    const error = new Error(`Coupon requires a minimum order of ₹${coupon.minOrderAmount}`);
    error.statusCode = 400;
    throw error;
  }
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
    const error = new Error('Coupon usage limit has been reached');
    error.statusCode = 400;
    throw error;
  }
  const patientUses = (coupon.redemptions || []).filter(r => String(r.patientId) === String(patientId)).length;
  if (patientUses >= Number(coupon.perUserLimit || 1)) {
    const error = new Error('You have already used this coupon the maximum number of times');
    error.statusCode = 400;
    throw error;
  }
  let discount = coupon.discountType === 'percent'
    ? money(merchandiseTotal * Number(coupon.value || 0) / 100)
    : money(coupon.value || 0);
  if (coupon.maxDiscount) discount = Math.min(discount, Number(coupon.maxDiscount));
  discount = Math.min(discount, merchandiseTotal);
  return { coupon, discount: money(discount) };
}

async function validateRx({ patientId, medicines, prescriptionId, prescriptionUploadId }) {
  const rxMedicines = medicines.filter(m => m.prescriptionRequired);
  if (!rxMedicines.length) return { required: false, status: 'not_required', prescription: null, upload: null };

  if (prescriptionId) {
    const prescription = await Prescription.findOne({
      _id: prescriptionId,
      patientId,
      status: 'issued',
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gte: new Date() } }]
    });
    if (!prescription) {
      const error = new Error('Selected prescription is not valid for this patient');
      error.statusCode = 400;
      throw error;
    }
    const rxNames = new Set((prescription.medicines || []).flatMap(m => [norm(m.medicineName), norm(m.genericName)]).filter(Boolean));
    const missing = rxMedicines.filter(m => !rxNames.has(norm(m.medicineName)) && !rxNames.has(norm(m.genericName)));
    if (missing.length) {
      const error = new Error(`Prescription does not contain: ${missing.map(m => m.medicineName).join(', ')}`);
      error.statusCode = 400;
      throw error;
    }
    return { required: true, status: 'approved', prescription, upload: null };
  }

  if (prescriptionUploadId) {
    const upload = await EPharmacyPrescriptionUpload.findOne({ _id: prescriptionUploadId, patientId });
    if (!upload) {
      const error = new Error('Uploaded prescription was not found');
      error.statusCode = 400;
      throw error;
    }
    return { required: true, status: upload.status === 'approved' ? 'approved' : upload.status === 'rejected' ? 'rejected' : 'pending_review', prescription: null, upload };
  }

  const error = new Error('A valid prescription is required for one or more medicines');
  error.statusCode = 400;
  throw error;
}

async function priceCart({ patientId, storeId, rawItems, couponCode, addressId, paymentMethod }) {
  const store = await getStore(storeId);
  if (!store) {
    const error = new Error('Selected pharmacy is unavailable for online ordering');
    error.statusCode = 404;
    throw error;
  }
  const settings = ecommerceSettings(store);
  if (paymentMethod === 'cod' && !settings.codEnabled) {
    const error = new Error('Cash on delivery is not enabled for this pharmacy');
    error.statusCode = 400;
    throw error;
  }
  if (paymentMethod === 'online' && !settings.onlinePaymentEnabled) {
    const error = new Error('Online payment is not enabled for this pharmacy');
    error.statusCode = 400;
    throw error;
  }
  const requested = (rawItems || []).filter(i => i.medicineId && Number(i.quantity) > 0);
  if (!requested.length) {
    const error = new Error('Cart is empty');
    error.statusCode = 400;
    throw error;
  }
  const ids = requested.map(i => i.medicineId);
  const medicines = await Medicine.find({ _id: { $in: ids }, storeId: store._id, organizationId: store.organizationId, isActive: true });
  const byId = new Map(medicines.map(m => [String(m._id), m]));
  const lines = [];
  let subtotal = 0; let medicineDiscount = 0; let tax = 0; let merchandiseTotal = 0;
  for (const requestedItem of requested) {
    const medicine = byId.get(String(requestedItem.medicineId));
    if (!medicine) {
      const error = new Error('One or more medicines are no longer available from this pharmacy');
      error.statusCode = 409;
      throw error;
    }
    const qty = Math.min(99, Math.max(1, Number(requestedItem.quantity)));
    if (Number(medicine.quantity || 0) < qty) {
      const error = new Error(`${medicine.medicineName} has only ${medicine.quantity || 0} unit(s) available`);
      error.statusCode = 409;
      throw error;
    }
    const price = linePrice(medicine, qty);
    subtotal = money(subtotal + price.taxableAmount);
    medicineDiscount = money(medicineDiscount + price.medicineDiscount);
    tax = money(tax + price.taxAmount);
    merchandiseTotal = money(merchandiseTotal + price.totalAmount);
    lines.push({
      medicine,
      snapshot: {
        medicineId: medicine._id,
        medicineName: medicine.medicineName,
        genericName: medicine.genericName,
        quantity: qty,
        unit: medicine.unit,
        hsnCode: medicine.hsnCode,
        prescriptionRequired: !!medicine.prescriptionRequired,
        ...price
      }
    });
  }
  if (merchandiseTotal < settings.minOrderAmount) {
    const error = new Error(`Minimum online order is ₹${settings.minOrderAmount}`);
    error.statusCode = 400;
    throw error;
  }
  let address = null;
  if (addressId) {
    address = await EPharmacyAddress.findOne({ _id: addressId, patientId });
    if (!address) {
      const error = new Error('Delivery address not found');
      error.statusCode = 404;
      throw error;
    }
    if (!isPincodeServiceable(store, address.pincode)) {
      const error = new Error('This pharmacy does not deliver to the selected pincode');
      error.statusCode = 400;
      throw error;
    }
  }
  const { coupon, discount: couponDiscount } = await resolveCoupon({ code: couponCode, store, patientId, merchandiseTotal });
  const deliveryFee = settings.freeDeliveryThreshold > 0 && merchandiseTotal >= settings.freeDeliveryThreshold
    ? 0 : settings.deliveryFee;
  const totalAmount = money(Math.max(0, merchandiseTotal - couponDiscount + deliveryFee));
  return { store, settings, lines, subtotal, medicineDiscount, tax, merchandiseTotal, coupon, couponDiscount, deliveryFee, totalAmount, address };
}

async function hydratedCart(patientId) {
  const cart = await EPharmacyCart.findOne({ patientId }).lean();
  if (!cart || !cart.storeId) return { cart: cart || { items: [] }, store: null, items: [], totals: { itemCount: 0, merchandiseTotal: 0 } };
  const store = await getStore(cart.storeId);
  const ids = (cart.items || []).map(i => i.medicineId);
  const meds = await Medicine.find({ _id: { $in: ids }, storeId: cart.storeId, isActive: true }).lean();
  const map = new Map(meds.map(m => [String(m._id), m]));
  let merchandiseTotal = 0;
  const items = (cart.items || []).map(i => {
    const medicine = map.get(String(i.medicineId));
    if (!medicine) return null;
    const price = linePrice(medicine, i.quantity);
    merchandiseTotal = money(merchandiseTotal + price.totalAmount);
    return { ...i, medicine, ...price, available: Number(medicine.quantity || 0) >= Number(i.quantity || 0) };
  }).filter(Boolean);
  return { cart, store, items, totals: { itemCount: items.reduce((s, i) => s + Number(i.quantity || 0), 0), merchandiseTotal } };
}

exports.listStores = async (req, res) => {
  try {
    requirePatient(req);
    const { city, pincode, q } = req.query;
    const filter = { status: 'active', 'ecommerce.enabled': { $ne: false } };
    if (city) filter['address.city'] = new RegExp(String(city), 'i');
    if (q) filter.name = new RegExp(String(q), 'i');
    const stores = await PharmacyStore.find(filter).sort({ isDefault: -1, name: 1 }).lean();
    const filtered = pincode ? stores.filter(s => isPincodeServiceable(s, pincode)) : stores;
    res.json({ success: true, stores: filtered.map(s => ({ ...s, ecommerce: ecommerceSettings(s), serviceable: isPincodeServiceable(s, pincode) })) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.catalog = async (req, res) => {
  try {
    requirePatient(req);
    const store = await getStore(req.query.storeId);
    if (!store) return res.status(404).json({ success: false, message: 'Pharmacy store not found' });
    const { q, category, rx, page = 1, limit = 24 } = req.query;
    const filter = { storeId: store._id, organizationId: store.organizationId, isActive: true, quantity: { $gt: 0 } };
    if (category && category !== 'all') filter.category = category;
    if (rx === 'required') filter.prescriptionRequired = true;
    if (rx === 'otc') filter.prescriptionRequired = false;
    if (q) filter.$or = [
      { medicineName: new RegExp(String(q), 'i') },
      { genericName: new RegExp(String(q), 'i') },
      { brandName: new RegExp(String(q), 'i') },
      { composition: new RegExp(String(q), 'i') }
    ];
    const pageNum = Math.max(1, Number(page) || 1); const pageSize = Math.min(100, Math.max(1, Number(limit) || 24));
    const [rows, total] = await Promise.all([
      Medicine.find(filter).sort({ medicineName: 1 }).skip((pageNum - 1) * pageSize).limit(pageSize).lean(),
      Medicine.countDocuments(filter)
    ]);
    res.json({ success: true, store, products: rows.map(m => ({ ...m, finalUnitPrice: linePrice(m, 1).totalAmount })), pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.getCart = async (req, res) => {
  try { res.json({ success: true, ...(await hydratedCart(requirePatient(req))) }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.addCartItem = async (req, res) => {
  try {
    const patientId = requirePatient(req); const { storeId, medicineId, quantity = 1 } = req.body;
    const store = await getStore(storeId); if (!store) return res.status(404).json({ success: false, message: 'Pharmacy store unavailable' });
    const medicine = await Medicine.findOne({ _id: medicineId, storeId: store._id, organizationId: store.organizationId, isActive: true });
    if (!medicine) return res.status(404).json({ success: false, message: 'Medicine unavailable' });
    let cart = await EPharmacyCart.findOne({ patientId });
    if (!cart) cart = new EPharmacyCart({ patientId, storeId: store._id, organizationId: store.organizationId, items: [] });
    if (cart.storeId && String(cart.storeId) !== String(store._id) && cart.items.length) {
      return res.status(409).json({ success: false, code: 'CART_STORE_CONFLICT', message: 'Your cart contains medicines from another pharmacy. Clear it before switching stores.' });
    }
    cart.storeId = store._id; cart.organizationId = store.organizationId;
    const item = cart.items.find(i => String(i.medicineId) === String(medicine._id));
    const targetQty = item ? Number(item.quantity) + Number(quantity || 1) : Number(quantity || 1);
    if (targetQty > Number(medicine.quantity || 0)) return res.status(409).json({ success: false, message: `Only ${medicine.quantity} unit(s) available` });
    if (item) item.quantity = Math.min(99, Math.max(1, targetQty)); else cart.items.push({ medicineId: medicine._id, quantity: Math.min(99, Math.max(1, targetQty)) });
    await cart.save(); res.json({ success: true, ...(await hydratedCart(patientId)) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.updateCartItem = async (req, res) => {
  try {
    const patientId = requirePatient(req); const qty = Number(req.body.quantity);
    const cart = await EPharmacyCart.findOne({ patientId }); if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });
    const item = cart.items.find(i => String(i.medicineId) === String(req.params.medicineId)); if (!item) return res.status(404).json({ success: false, message: 'Cart item not found' });
    if (qty <= 0) cart.items = cart.items.filter(i => String(i.medicineId) !== String(req.params.medicineId));
    else {
      const medicine = await Medicine.findOne({ _id: item.medicineId, storeId: cart.storeId, isActive: true });
      if (!medicine || qty > medicine.quantity) return res.status(409).json({ success: false, message: `Only ${medicine?.quantity || 0} unit(s) available` });
      item.quantity = Math.min(99, qty);
    }
    await cart.save(); res.json({ success: true, ...(await hydratedCart(patientId)) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.removeCartItem = async (req, res) => {
  try { const patientId = requirePatient(req); await EPharmacyCart.updateOne({ patientId }, { $pull: { items: { medicineId: req.params.medicineId } } }); res.json({ success: true, ...(await hydratedCart(patientId)) }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};
exports.clearCart = async (req, res) => { try { const patientId = requirePatient(req); await EPharmacyCart.findOneAndUpdate({ patientId }, { $set: { items: [], prescriptionId: null, prescriptionUploadId: null } }); res.json({ success: true }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.setCartPrescription = async (req, res) => { try { const patientId = requirePatient(req); const cart = await EPharmacyCart.findOneAndUpdate({ patientId }, { $set: { prescriptionId: req.body.prescriptionId || null, prescriptionUploadId: req.body.prescriptionUploadId || null } }, { new: true, upsert: true }); res.json({ success: true, cart }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };

exports.listAddresses = async (req, res) => { try { const patientId = requirePatient(req); res.json({ success: true, addresses: await EPharmacyAddress.find({ patientId }).sort({ isDefault: -1, createdAt: -1 }) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, message: e.message }); } };
exports.createAddress = async (req, res) => {
  try {
    const patientId = requirePatient(req); const count = await EPharmacyAddress.countDocuments({ patientId });
    if (req.body.isDefault || count === 0) await EPharmacyAddress.updateMany({ patientId }, { $set: { isDefault: false } });
    const address = await EPharmacyAddress.create({ ...req.body, patientId, isDefault: req.body.isDefault || count === 0 });
    res.status(201).json({ success: true, address });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
exports.updateAddress = async (req, res) => { try { const patientId = requirePatient(req); if (req.body.isDefault) await EPharmacyAddress.updateMany({ patientId }, { $set: { isDefault: false } }); const address = await EPharmacyAddress.findOneAndUpdate({ _id: req.params.id, patientId }, req.body, { new: true, runValidators: true }); if (!address) return res.status(404).json({ success: false, message: 'Address not found' }); res.json({ success: true, address }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } };
exports.deleteAddress = async (req, res) => { try { const patientId = requirePatient(req); const address = await EPharmacyAddress.findOneAndDelete({ _id: req.params.id, patientId }); if (!address) return res.status(404).json({ success: false, message: 'Address not found' }); if (address.isDefault) { const next = await EPharmacyAddress.findOne({ patientId }).sort({ createdAt: -1 }); if (next) { next.isDefault = true; await next.save(); } } res.json({ success: true }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.setDefaultAddress = async (req, res) => { try { const patientId = requirePatient(req); const address = await EPharmacyAddress.findOne({ _id: req.params.id, patientId }); if (!address) return res.status(404).json({ success: false, message: 'Address not found' }); await EPharmacyAddress.updateMany({ patientId }, { $set: { isDefault: false } }); address.isDefault = true; await address.save(); res.json({ success: true, address }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };

exports.listPatientPrescriptions = async (req, res) => { try { const patientId = requirePatient(req); const prescriptions = await Prescription.find({ patientId, status: 'issued', $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gte: new Date() } }] }).select('prescriptionNumber medicines issuedAt expiresAt doctorId physioId').sort({ issuedAt: -1 }).lean(); res.json({ success: true, prescriptions }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.uploadPrescription = async (req, res) => { try { const patientId = requirePatient(req); if (!req.file) return res.status(400).json({ success: false, message: 'Prescription file is required' }); const upload = await EPharmacyPrescriptionUpload.create({ patientId, originalName: req.file.originalname, storedName: req.file.filename, mimeType: req.file.mimetype, size: req.file.size, filePath: req.file.path }); res.status(201).json({ success: true, upload }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } };
exports.listPrescriptionUploads = async (req, res) => { try { const patientId = requirePatient(req); res.json({ success: true, uploads: await EPharmacyPrescriptionUpload.find({ patientId }).sort({ createdAt: -1 }).select('-filePath') }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.downloadPrescriptionUpload = async (req, res) => {
  try {
    const upload = await EPharmacyPrescriptionUpload.findById(req.params.id); if (!upload) return res.status(404).json({ success: false, message: 'Prescription not found' });
    let allowed = req.user.role === 'patient' && String(upload.patientId) === String(req.user.profileId);
    if (req.user.role === 'pharmacy' && !allowed) {
      const storeIds = (req.user.pharmacyStoreIds || []).map(String);
      allowed = !!(await EPharmacyOrder.exists({ prescriptionUploadId: upload._id, storeId: { $in: storeIds } }));
    }
    if (req.user.role === 'admin') allowed = true;
    if (!allowed) return res.status(403).json({ success: false, message: 'Not authorized' });
    const resolved = path.resolve(upload.filePath); if (!fs.existsSync(resolved)) return res.status(404).json({ success: false, message: 'Prescription file missing from storage' });
    res.type(upload.mimeType); res.setHeader('Content-Disposition', `inline; filename="${String(upload.originalName).replace(/"/g, '')}"`); res.sendFile(resolved);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.validateCoupon = async (req, res) => { try { const patientId = requirePatient(req); const store = await getStore(req.body.storeId); if (!store) return res.status(404).json({ success: false, message: 'Pharmacy not found' }); const result = await resolveCoupon({ code: req.body.code, store, patientId, merchandiseTotal: Number(req.body.subtotal || 0) }); res.json({ success: true, coupon: result.coupon, discount: result.discount }); } catch (e) { res.status(e.statusCode || 400).json({ success: false, message: e.message }); } };
exports.checkoutQuote = async (req, res) => {
  try {
    const patientId = requirePatient(req); const cart = await EPharmacyCart.findOne({ patientId }); if (!cart) return res.status(400).json({ success: false, message: 'Cart is empty' });
    const priced = await priceCart({ patientId, storeId: cart.storeId, rawItems: cart.items, couponCode: req.body.couponCode, addressId: req.body.addressId, paymentMethod: req.body.paymentMethod || 'cod' });
    const rx = await validateRx({ patientId, medicines: priced.lines.map(l => l.medicine), prescriptionId: req.body.prescriptionId || cart.prescriptionId, prescriptionUploadId: req.body.prescriptionUploadId || cart.prescriptionUploadId });
    res.json({ success: true, quote: { store: priced.store, items: priced.lines.map(l => l.snapshot), subtotal: priced.subtotal, medicineDiscount: priced.medicineDiscount, tax: priced.tax, couponDiscount: priced.couponDiscount, deliveryFee: priced.deliveryFee, totalAmount: priced.totalAmount, prescriptionStatus: rx.status, prescriptionRequired: rx.required } });
  } catch (e) { res.status(e.statusCode || 400).json({ success: false, message: e.message }); }
};

exports.createOrder = async (req, res) => {
  try {
    const patientId = requirePatient(req); const cart = await EPharmacyCart.findOne({ patientId }); if (!cart) return res.status(400).json({ success: false, message: 'Cart is empty' });
    const paymentMethod = req.body.paymentMethod || 'cod';
    const priced = await priceCart({ patientId, storeId: cart.storeId, rawItems: cart.items, couponCode: req.body.couponCode, addressId: req.body.addressId, paymentMethod });
    if (!priced.address) return res.status(400).json({ success: false, message: 'Delivery address is required' });
    const prescriptionId = req.body.prescriptionId || cart.prescriptionId; const prescriptionUploadId = req.body.prescriptionUploadId || cart.prescriptionUploadId;
    const rx = await validateRx({ patientId, medicines: priced.lines.map(l => l.medicine), prescriptionId, prescriptionUploadId });
    if (rx.status === 'rejected') return res.status(400).json({ success: false, message: 'The selected prescription upload was rejected' });
    const initialStatus = paymentMethod === 'online' ? 'payment_pending' : (rx.status === 'pending_review' ? 'prescription_review' : 'placed');
    const a = priced.address;
    const order = await EPharmacyOrder.create({
      organizationId: priced.store.organizationId, storeId: priced.store._id, patientId,
      items: priced.lines.map(l => l.snapshot),
      deliveryAddress: { addressId: a._id, label: a.label, contactName: a.contactName, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, state: a.state, pincode: a.pincode, country: a.country },
      deliveryInstructions: req.body.deliveryInstructions,
      prescriptionRequired: rx.required, prescriptionId: rx.prescription?._id, prescriptionUploadId: rx.upload?._id,
      prescriptionStatus: rx.status,
      couponId: priced.coupon?._id, couponCode: priced.coupon?.code,
      subtotal: priced.subtotal, medicineDiscount: priced.medicineDiscount, couponDiscount: priced.couponDiscount, tax: priced.tax, deliveryFee: priced.deliveryFee, totalAmount: priced.totalAmount,
      paymentMethod, paymentStatus: 'pending', orderStatus: initialStatus,
      tracking: { estimatedDeliveryAt: new Date(Date.now() + priced.settings.estimatedDeliveryMinutes * 60000) },
      statusHistory: [{ status: initialStatus, note: 'Order created', actorId: req.user.id }], createdBy: req.user.id
    });
    if (priced.coupon) await EPharmacyCoupon.updateOne({ _id: priced.coupon._id }, { $inc: { usageCount: 1 }, $push: { redemptions: { patientId, orderId: order._id, redeemedAt: new Date() } } });
    await EPharmacyCart.findOneAndUpdate({ patientId }, { $set: { items: [], prescriptionId: null, prescriptionUploadId: null } });
    res.status(201).json({ success: true, order });
  } catch (e) { res.status(e.statusCode || 400).json({ success: false, message: e.message }); }
};

exports.listPatientOrders = async (req, res) => { try { const patientId = requirePatient(req); const orders = await EPharmacyOrder.find({ patientId }).populate('storeId', 'name address phone').sort({ createdAt: -1 }).lean(); res.json({ success: true, orders }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.getPatientOrder = async (req, res) => { try { const patientId = requirePatient(req); const order = await EPharmacyOrder.findOne({ _id: req.params.id, patientId }).populate('storeId', 'name address phone').populate('prescriptionId', 'prescriptionNumber issuedAt').lean(); if (!order) return res.status(404).json({ success: false, message: 'Order not found' }); res.json({ success: true, order }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.cancelPatientOrder = async (req, res) => {
  try {
    const patientId = requirePatient(req); const order = await EPharmacyOrder.findOne({ _id: req.params.id, patientId }); if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['payment_pending', 'prescription_review', 'placed', 'cancelled'].includes(order.orderStatus)) return res.status(409).json({ success: false, message: 'This order can no longer be cancelled by the patient' });
    const refund = await finalizeCancellation(order, req.body.reason || 'Cancelled by patient', req.user.id);
    res.json({ success: true, order, refund });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
exports.reorder = async (req, res) => {
  try {
    const patientId = requirePatient(req); const order = await EPharmacyOrder.findOne({ _id: req.params.id, patientId }); if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const store = await getStore(order.storeId); if (!store) return res.status(409).json({ success: false, message: 'Original pharmacy is unavailable' });
    const meds = await Medicine.find({ _id: { $in: order.items.map(i => i.medicineId) }, storeId: order.storeId, isActive: true }); const map = new Map(meds.map(m => [String(m._id), m]));
    const items = order.items.filter(i => map.get(String(i.medicineId))?.quantity > 0).map(i => ({ medicineId: i.medicineId, quantity: Math.min(i.quantity, map.get(String(i.medicineId)).quantity) }));
    const cart = await EPharmacyCart.findOneAndUpdate({ patientId }, { $set: { organizationId: order.organizationId, storeId: order.storeId, items, prescriptionId: null, prescriptionUploadId: null } }, { upsert: true, new: true }); res.json({ success: true, cart, unavailableCount: order.items.length - items.length });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.listMerchantOrders = async (req, res) => {
  try {
    const { status, prescriptionStatus, q, page = 1, limit = 30 } = req.query;
    const filter = { organizationId: req.tenant.organizationId, storeId: req.tenant.storeId };
    if (status) filter.orderStatus = status; if (prescriptionStatus) filter.prescriptionStatus = prescriptionStatus; if (q) filter.orderNumber = new RegExp(String(q), 'i');
    const p = Math.max(1, Number(page) || 1), l = Math.min(100, Math.max(1, Number(limit) || 30));
    const [orders, total] = await Promise.all([EPharmacyOrder.find(filter).populate('patientId', 'name phone email').sort({ createdAt: -1 }).skip((p - 1) * l).limit(l), EPharmacyOrder.countDocuments(filter)]);
    res.json({ success: true, orders, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
exports.getMerchantOrder = async (req, res) => { try { const order = await EPharmacyOrder.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }).populate('patientId', 'name phone email').populate('prescriptionId'); if (!order) return res.status(404).json({ success: false, message: 'Order not found' }); res.json({ success: true, order }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.reviewPrescription = async (req, res) => {
  try {
    const order = await EPharmacyOrder.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }); if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.prescriptionRequired) return res.status(400).json({ success: false, message: 'This order does not require a prescription' });
    const decision = req.body.decision === 'approved' ? 'approved' : 'rejected'; order.prescriptionStatus = decision; order.prescriptionReviewNotes = req.body.notes;
    if (order.prescriptionUploadId) await EPharmacyPrescriptionUpload.updateOne({ _id: order.prescriptionUploadId }, { $set: { status: decision, reviewedBy: req.user.id, reviewedAt: new Date(), reviewNotes: req.body.notes } });
    if (decision === 'rejected') {
      order.prescriptionReviewNotes = req.body.notes;
      order.statusHistory.push({ status: order.orderStatus, note: `Prescription rejected${req.body.notes ? `: ${req.body.notes}` : ''}`, actorId: req.user.id });
      const refund = await finalizeCancellation(order, req.body.notes || 'Prescription rejected', req.user.id);
      return res.json({ success: true, order, refund });
    }
    if (order.orderStatus === 'prescription_review') order.orderStatus = 'placed';
    order.statusHistory.push({ status: order.orderStatus, note: `Prescription approved${req.body.notes ? `: ${req.body.notes}` : ''}`, actorId: req.user.id }); await order.save(); res.json({ success: true, order });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.confirmMerchantOrder = async (req, res) => {
  try {
    const order = await EPharmacyOrder.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }).populate('patientId', 'name phone email');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.fulfillmentSaleId) return res.json({ success: true, order, message: 'Order already confirmed' });
    if (!['placed'].includes(order.orderStatus)) return res.status(409).json({ success: false, message: 'Order is not ready for confirmation' });
    if (order.prescriptionRequired && order.prescriptionStatus !== 'approved') return res.status(409).json({ success: false, message: 'Prescription must be approved first' });
    if (order.paymentMethod === 'online' && order.paymentStatus !== 'paid') return res.status(409).json({ success: false, message: 'Online payment is not complete' });
    const scope = { organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }; const completed = []; let cogs = 0;
    try {
      for (const item of order.items) {
        const result = await consumeFefo({ scope, medicineId: item.medicineId, quantity: item.quantity, actorId: req.user.id, reason: `Online order ${order.orderNumber}`, referenceType: 'online_order', referenceId: order._id });
        item.batchAllocations = result.allocations.map(a => ({ batchId: a.batchId, quantity: a.quantity, purchasePrice: a.purchasePrice })); completed.push({ item, allocations: result.allocations }); cogs = money(cogs + result.allocations.reduce((s, a) => s + Number(a.purchasePrice || 0) * Number(a.quantity || 0), 0));
      }
      const patient = order.patientId || {};
      const sale = await PharmacySale.create({
        organizationId: order.organizationId, storeId: order.storeId, customerType: 'online', patientId: patient._id, prescriptionId: order.prescriptionId,
        customerName: patient.name || order.deliveryAddress.contactName, customerPhone: patient.phone || order.deliveryAddress.phone, customerEmail: patient.email, customerAddress: [order.deliveryAddress.line1, order.deliveryAddress.line2, order.deliveryAddress.city, order.deliveryAddress.state, order.deliveryAddress.pincode].filter(Boolean).join(', '),
        items: order.items.map(i => ({ medicineId: i.medicineId, batchId: i.batchAllocations?.[0]?.batchId, batchAllocations: i.batchAllocations, medicineName: i.medicineName, genericName: i.genericName, quantity: i.quantity, unit: i.unit, sellingPrice: i.unitPrice, discount: i.medicineDiscount, taxRate: i.taxRate, priceIncludesTax: true, hsnCode: i.hsnCode, taxableAmount: i.taxableAmount, taxAmount: i.taxAmount, totalAmount: i.totalAmount, costAmount: money((i.batchAllocations || []).reduce((s, a) => s + Number(a.purchasePrice || 0) * Number(a.quantity || 0), 0)) })),
        prescriptionRequired: order.prescriptionRequired, subtotal: order.subtotal, discount: money(order.medicineDiscount + order.couponDiscount), tax: order.tax, totalAmount: order.totalAmount, paidAmount: order.paymentStatus === 'paid' ? order.totalAmount : 0, balanceAmount: order.paymentStatus === 'paid' ? 0 : order.totalAmount, paymentMethod: order.paymentMethod === 'online' ? 'online' : 'cash', paymentReference: order.razorpayPaymentId, paymentStatus: order.paymentStatus === 'paid' ? 'paid' : 'pending', costOfGoods: cogs, grossProfit: money(order.subtotal - cogs), status: 'dispensed', invoiceNumber: `INV-${order.orderNumber}`, dispensedBy: req.user.id, dispensedAt: new Date(), deliveryInstructions: order.deliveryInstructions, createdBy: req.user.id
      });
      order.fulfillmentSaleId = sale._id; order.orderStatus = 'confirmed'; order.statusHistory.push({ status: 'confirmed', note: 'Accepted by pharmacy and stock allocated', actorId: req.user.id }); await order.save(); res.json({ success: true, order, sale });
    } catch (error) {
      for (const done of completed.reverse()) for (const allocation of done.allocations) await addToBatch({ scope, medicineId: done.item.medicineId, batchId: allocation.batchId, quantity: allocation.quantity, actorId: req.user.id, adjustmentType: 'addition', reason: `Rollback online order ${order.orderNumber}`, referenceType: 'online_order', referenceId: order._id }).catch(err => console.error('Online order rollback failed', err));
      throw error;
    }
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, message: e.message }); }
};

const nextStatuses = { confirmed: ['packing', 'cancelled'], packing: ['ready_to_ship', 'cancelled'], ready_to_ship: ['shipped', 'cancelled'], shipped: ['out_for_delivery'], out_for_delivery: ['delivered'] };
exports.updateMerchantStatus = async (req, res) => {
  try {
    const order = await EPharmacyOrder.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }); if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const target = req.body.status; if (!(nextStatuses[order.orderStatus] || []).includes(target)) return res.status(409).json({ success: false, message: `Cannot move order from ${order.orderStatus} to ${target}` });
    if (target === 'cancelled') return exports.cancelMerchantOrder(req, res);
    order.orderStatus = target; order.statusHistory.push({ status: target, note: req.body.note, actorId: req.user.id });
    if (req.body.tracking) order.tracking = { ...order.tracking.toObject?.() || order.tracking, ...req.body.tracking };
    if (target === 'shipped') order.tracking.shippedAt = new Date(); if (target === 'out_for_delivery') order.tracking.outForDeliveryAt = new Date();
    if (target === 'delivered') { order.tracking.deliveredAt = new Date(); if (order.paymentMethod === 'cod') { order.paymentStatus = 'paid'; order.paymentDate = new Date(); if (order.fulfillmentSaleId) await PharmacySale.updateOne({ _id: order.fulfillmentSaleId }, { $set: { paymentStatus: 'paid', paidAmount: order.totalAmount, balanceAmount: 0 } }); } }
    await order.save(); res.json({ success: true, order });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.cancelMerchantOrder = async (req, res) => {
  try {
    const order = await EPharmacyOrder.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }); if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (['shipped', 'out_for_delivery', 'delivered', 'returned', 'cancelled'].includes(order.orderStatus)) return res.status(409).json({ success: false, message: 'Order can no longer be cancelled from this state' });
    if (order.fulfillmentSaleId) {
      const scope = { organizationId: req.tenant.organizationId, storeId: req.tenant.storeId };
      for (const item of order.items) for (const a of item.batchAllocations || []) await addToBatch({ scope, medicineId: item.medicineId, batchId: a.batchId, quantity: a.quantity, actorId: req.user.id, adjustmentType: 'return', reason: `Cancelled online order ${order.orderNumber}`, referenceType: 'online_order', referenceId: order._id });
      await PharmacySale.updateOne({ _id: order.fulfillmentSaleId }, { $set: { status: 'cancelled' } });
    }
    const refund = await finalizeCancellation(order, req.body.reason || 'Cancelled by pharmacy', req.user.id);
    res.json({ success: true, order, refund });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, message: e.message }); }
};

exports.retryMerchantRefund = async (req, res) => {
  try {
    const order = await EPharmacyOrder.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, storeId: req.tenant.storeId });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.orderStatus !== 'cancelled') return res.status(409).json({ success: false, message: 'Only cancelled orders can be refunded here' });
    const refund = await refundOnlinePayment(order, order.cancellationReason || 'Cancelled order refund retry');
    await order.save();
    res.json({ success: true, order, refund });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.listCoupons = async (req, res) => { try { res.json({ success: true, coupons: await EPharmacyCoupon.find({ organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }).sort({ createdAt: -1 }) }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
exports.createCoupon = async (req, res) => { try { const coupon = await EPharmacyCoupon.create({ ...req.body, code: String(req.body.code || '').toUpperCase(), organizationId: req.tenant.organizationId, storeId: req.tenant.storeId, createdBy: req.user.id, updatedBy: req.user.id }); res.status(201).json({ success: true, coupon }); } catch (e) { res.status(400).json({ success: false, message: e.code === 11000 ? 'Coupon code already exists for this store' : e.message }); } };
exports.updateCoupon = async (req, res) => { try { const coupon = await EPharmacyCoupon.findOneAndUpdate({ _id: req.params.id, organizationId: req.tenant.organizationId, storeId: req.tenant.storeId }, { ...req.body, updatedBy: req.user.id }, { new: true, runValidators: true }); if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' }); res.json({ success: true, coupon }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } };
exports.updateOnlineSettings = async (req, res) => { try { const allowed = ['enabled', 'serviceablePincodes', 'minOrderAmount', 'deliveryFee', 'freeDeliveryThreshold', 'codEnabled', 'onlinePaymentEnabled', 'estimatedDeliveryMinutes', 'allowReturns']; const set = {}; for (const key of allowed) if (Object.prototype.hasOwnProperty.call(req.body, key)) set[`ecommerce.${key}`] = req.body[key]; const store = await PharmacyStore.findOneAndUpdate({ _id: req.tenant.storeId, organizationId: req.tenant.organizationId }, { $set: set }, { new: true, runValidators: true }); res.json({ success: true, store }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } };

module.exports._helpers = { linePrice, ecommerceSettings };
