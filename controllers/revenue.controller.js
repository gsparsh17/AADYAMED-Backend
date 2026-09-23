const Salary = require('../models/Salary');
const Invoice = require('../models/Invoice');

// Calculate hospital revenue
exports.calculateHospitalRevenue = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter.invoiceDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else {
      // Default to current month if no dates provided
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      dateFilter.invoiceDate = {
        $gte: firstDayOfMonth,
        $lte: lastDayOfMonth
      };
    }

    // Calculate revenue from appointments (billing)
    const appointmentRevenue = await Invoice.aggregate([
      {
        $match: {
          ...dateFilter,
          status: 'paid',
          invoiceType: 'appointment'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalAmount' },
          appointmentCount: { $sum: 1 }
        }
      }
    ]);

    // Calculate revenue from pharmacy sales
    const pharmacyRevenue = await Invoice.aggregate([
      {
        $match: {
          ...dateFilter,
          status: 'paid',
          invoiceType: 'pharmacy'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalAmount' },
          saleCount: { $sum: 1 }
        }
      }
    ]);

    // Calculate staff salary expenses (period overlap with the requested date range)
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          period_start: { $lte: dateFilter.invoiceDate.$lte },
          period_end: { $gte: dateFilter.invoiceDate.$gte },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: '$net_amount' },
          salaryCount: { $sum: 1 }
        }
      }
    ]);

    // Calculate net revenue
    const totalAppointmentRevenue = appointmentRevenue[0]?.totalRevenue || 0;
    const totalPharmacyRevenue = pharmacyRevenue[0]?.totalRevenue || 0;
    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;

    const grossRevenue = totalAppointmentRevenue + totalPharmacyRevenue;
    const netRevenue = grossRevenue - totalSalaryExpenses;

    res.json({
      period: {
        start: dateFilter.invoiceDate?.$gte || new Date(),
        end: dateFilter.invoiceDate?.$lte || new Date()
      },
      revenue: {
        appointment: totalAppointmentRevenue,
        pharmacy: totalPharmacyRevenue,
        gross: grossRevenue,
        net: netRevenue
      },
      expenses: {
        salaries: totalSalaryExpenses
      },
      counts: {
        appointments: appointmentRevenue[0]?.appointmentCount || 0,
        pharmacySales: pharmacyRevenue[0]?.saleCount || 0,
        salariesPaid: salaryExpenses[0]?.salaryCount || 0
      },
      profitability: {
        grossMargin: grossRevenue > 0 ? ((grossRevenue - totalSalaryExpenses) / grossRevenue) * 100 : 0,
        netMargin: grossRevenue > 0 ? (netRevenue / grossRevenue) * 100 : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get daily revenue report
exports.getDailyRevenueReport = async (req, res) => {
  try {
    const { date } = req.query;
    let targetDate;

    if (date) {
      // Create a date object from the string, treating it as UTC
      targetDate = new Date(`${date}T00:00:00.000Z`);
    } else {
      // Use the current date, and then strip the time to a UTC day
      const now = new Date();
      targetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }

    const startOfDay = targetDate;
    const endOfDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000 - 1);

    const [appointmentRevenue, pharmacyRevenue, salaryExpenses] = await Promise.all([
      // Appointment revenue
      Invoice.aggregate([
        {
          $match: {
            invoiceDate: { $gte: startOfDay, $lte: endOfDay },
            status: 'paid',
            invoiceType: 'appointment'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$totalAmount' },
            count: { $sum: 1 }
          }
        }
      ]),
      // Pharmacy revenue
      Invoice.aggregate([
        {
          $match: {
            invoiceDate: { $gte: startOfDay, $lte: endOfDay },
            status: 'paid',
            invoiceType: 'pharmacy'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$totalAmount' },
            count: { $sum: 1 }
          }
        }
      ]),
      // Salary expenses paid on this day
      Salary.aggregate([
        {
          $match: {
            paid_date: { $gte: startOfDay, $lte: endOfDay },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$net_amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const result = {
      date: startOfDay.toISOString().split('T')[0],
      revenue: {
        appointment: appointmentRevenue[0]?.total || 0,
        pharmacy: pharmacyRevenue[0]?.total || 0,
        total: (appointmentRevenue[0]?.total || 0) + (pharmacyRevenue[0]?.total || 0)
      },
      expenses: {
        salaries: salaryExpenses[0]?.total || 0
      },
      net: ((appointmentRevenue[0]?.total || 0) + (pharmacyRevenue[0]?.total || 0)) - (salaryExpenses[0]?.total || 0),
      counts: {
        appointments: appointmentRevenue[0]?.count || 0,
        pharmacySales: pharmacyRevenue[0]?.count || 0,
        salariesPaid: salaryExpenses[0]?.count || 0
      }
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get monthly revenue report
exports.getMonthlyRevenueReport = async (req, res) => {
  try {
    const { year, month } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;

    const startOfMonth = new Date(targetYear, targetMonth - 1, 1);
    const endOfMonth = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

    const [revenueByDay, salaryExpenses, appointments, pharmacySales, dailyRevenueTotals] = await Promise.all([
      // Daily revenue breakdown
      Invoice.aggregate([
        {
          $match: {
            invoiceDate: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: {
              day: { $dayOfMonth: '$invoiceDate' },
              type: '$invoiceType'
            },
            total: { $sum: '$totalAmount' },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.day': 1 } }
      ]),
      // Salary expenses paid within the month
      Salary.aggregate([
        {
          $match: {
            paid_date: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$net_amount' },
            count: { $sum: 1 }
          }
        }
      ]),
      // Total appointments
      Invoice.countDocuments({
        invoiceDate: { $gte: startOfMonth, $lte: endOfMonth },
        status: 'paid',
        invoiceType: 'appointment'
      }),
      // Total pharmacy sales
      Invoice.countDocuments({
        invoiceDate: { $gte: startOfMonth, $lte: endOfMonth },
        status: 'paid',
        invoiceType: 'pharmacy'
      }),
      // Daily revenue totals for average and highest day calculation
      Invoice.aggregate([
        {
          $match: {
            invoiceDate: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$invoiceDate' } }
            },
            dailyRevenue: { $sum: '$totalAmount' }
          }
        }
      ])
    ]);

    const appointmentRevenue = await Invoice.aggregate([
      {
        $match: {
          invoiceDate: { $gte: startOfMonth, $lte: endOfMonth },
          status: 'paid',
          invoiceType: 'appointment'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalAmount' },
        }
      }
    ]);

    // Calculate revenue from pharmacy sales
    const pharmacyRevenue = await Invoice.aggregate([
      {
        $match: {
          invoiceDate: { $gte: startOfMonth, $lte: endOfMonth },
          status: 'paid',
          invoiceType: 'pharmacy'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalAmount' },
        }
      }
    ]);

    // Process daily revenue data
    const dailyBreakdown = {};
    const totalAppointmentRevenue = appointmentRevenue[0]?.totalRevenue || 0;
    const totalPharmacyRevenue = pharmacyRevenue[0]?.totalRevenue || 0;
    const businessDays = new Set();

    revenueByDay.forEach(item => {
      const day = item._id.day;
      businessDays.add(day);
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = { appointment: 0, pharmacy: 0, lab_test: 0, package: 0, other: 0, total: 0 };
      }
      const type = item._id.type;
      if (dailyBreakdown[day][type] !== undefined) dailyBreakdown[day][type] = item.total;
      dailyBreakdown[day].total += item.total;
    });

    const highestRevenueDay = [...dailyRevenueTotals].sort((a, b) => b.dailyRevenue - a.dailyRevenue)[0] || { _id: { date: '' }, dailyRevenue: 0 };
    const totalSalariesPaid = salaryExpenses[0]?.total || 0;
    const totalRevenue = Object.values(dailyBreakdown).reduce((sum, day) => sum + day.total, 0);
    const netRevenue = totalRevenue - totalSalariesPaid;

    res.json({
        appointmentRevenue: totalAppointmentRevenue,
        pharmacyRevenue: totalPharmacyRevenue,
        totalRevenue: totalRevenue,
        averageDailyRevenue: businessDays.size > 0 ? totalRevenue / businessDays.size : 0,
        highestRevenueDay: {
          amount: highestRevenueDay.dailyRevenue,
          date: highestRevenueDay._id.date,
        },
        profitMargin: totalRevenue > 0 ? (netRevenue / totalRevenue) * 100 : 0,
        totalAppointments: appointments,
        totalPharmacySales: pharmacySales,
        businessDays: businessDays.size,
        totalSalariesPaid: totalSalariesPaid,
        netRevenue: netRevenue,
        salaryExpenses: totalSalariesPaid
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
