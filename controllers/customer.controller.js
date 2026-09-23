const Customer = require('../models/Customer');
const Sale = require('../models/PharmacySale');
const Invoice = require('../models/Invoice');

// Create customer (without purchase logic)
exports.createCustomer = async (req, res) => {
  try {
    const {
      name, phone, email, address, customer_type,
      patient_id, date_of_birth, gender, blood_group,
      allergies, medical_conditions, contact_preferences,
      notes
    } = req.body;

    // Check if customer already exists
    const existingCustomer = await Customer.findOne({ 
      $or: [{ phone }, { email }] 
    });

    if (existingCustomer) {
      return res.status(400).json({ 
        error: 'Customer with this phone or email already exists' 
      });
    }

    const customer = new Customer({
      name,
      phone,
      email,
      address,
      customer_type,
      patient_id: patient_id || null,
      date_of_birth,
      gender,
      blood_group,
      allergies: allergies || [],
      medical_conditions: medical_conditions || [],
      contact_preferences: contact_preferences || {
        sms: true,
        email: false,
        whatsapp: true
      },
      notes,
      created_by: req.user._id
    });

    await customer.save();
    res.status(201).json({ 
      message: 'Customer created successfully', 
      customer 
    });

  } catch (err) {
    console.error("Error in createCustomer:", err);
    
    if (err.code === 11000) {
      return res.status(400).json({ 
        error: 'Phone number or email already exists' 
      });
    }
    
    res.status(500).json({ 
      error: 'An internal server error occurred.' 
    });
  }
};

// Get all customers with optional filters
exports.getAllCustomers = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      search, 
      customer_type, 
      is_active 
    } = req.query;

    const filter = {};
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (customer_type) filter.customer_type = customer_type;
    if (is_active !== undefined) filter.is_active = is_active === 'true';

    const customers = await Customer.find(filter)
      .populate('patient_id', 'firstName lastName patientId')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Customer.countDocuments(filter);

    res.status(200).json({
      customers,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get customer by ID with sales and invoice history
exports.getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await Customer.findById(id)
      .populate('patient_id', 'firstName lastName patientId dateOfBirth gender');

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get customer's sales history
    const sales = await Sale.find({ 
      $or: [
        { patientId: customer.patient_id },
        { customerPhone: customer.phone }
      ]
    })
    .populate('items.medicine_id', 'name strength')
    .sort({ saleDate: -1 })
    .limit(10);

    // Get customer's invoice history
    const invoices = await Invoice.find({
      $or: [
        { patientId: customer.patient_id },
        { customerPhone: customer.phone }
      ]
    })
    .sort({ invoiceDate: -1 })
    .limit(10);

    // Calculate total spent
    const totalSpent = sales.reduce((total, sale) => total + sale.totalAmount, 0);

    res.status(200).json({
      customer,
      sales_history: sales,
      invoice_history: invoices,
      total_spent: totalSpent,
      total_orders: sales.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update customer
exports.updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const customer = await Customer.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.status(200).json({ 
      message: 'Customer updated successfully', 
      customer 
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ 
        error: 'Phone number or email already exists' 
      });
    }
    res.status(500).json({ error: err.message });
  }
};

// Delete customer (soft delete)
exports.deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await Customer.findByIdAndUpdate(
      id,
      { $set: { is_active: false } },
      { new: true }
    );

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.status(200).json({ 
      message: 'Customer deactivated successfully' 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get customer statistics
exports.getCustomerStatistics = async (req, res) => {
  try {
    const totalCustomers = await Customer.countDocuments({ is_active: true });
    const customersByType = await Customer.aggregate([
      { $match: { is_active: true } },
      { $group: { _id: '$customer_type', count: { $sum: 1 } } }
    ]);

    const recentCustomers = await Customer.find({ is_active: true })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('patient_id', 'firstName lastName');

    res.status(200).json({
      total_customers: totalCustomers,
      customers_by_type: customersByType,
      recent_customers: recentCustomers
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};