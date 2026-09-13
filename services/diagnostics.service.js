const PathologyProfile = require('../models/PathologyProfile');

const pad2 = n => String(n).padStart(2, '0');
const dateKey = d => {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
};

const startOfDay = value => {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
};

function timeToMinutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

function bookingDateTime(date, time) {
  const day = startOfDay(date);
  const mins = timeToMinutes(time);
  if (Number.isNaN(day.getTime()) || mins === null) return null;
  day.setMinutes(mins);
  return day;
}

function mapAvailableSlots(profile, dayValue) {
  const day = startOfDay(dayValue);
  const slotDay = (profile.testSlots || []).find(s => dateKey(s.date) === dateKey(day));
  if (!slotDay) return [];
  const now = new Date();
  const minNoticeHours = Number(profile.bookingSettings?.minimumNoticeHours || 0);
  return (slotDay.timeSlots || []).map(slot => {
    const capacity = Number(slot.maxCapacity || 0);
    const booked = Number(slot.bookedCount || 0);
    const start = bookingDateTime(day, slot.startTime);
    const noticeOk = !start || start.getTime() >= now.getTime() + minNoticeHours * 3600000;
    return {
      startTime: slot.startTime,
      endTime: slot.endTime,
      maxCapacity: capacity,
      bookedCount: booked,
      availableCapacity: Math.max(0, capacity - booked),
      isAvailable: slot.isAvailable !== false && booked < capacity && noticeOk,
    };
  });
}

function buildCatalogSelection(profile, testCodes = [], packageCodes = [], collectionType = 'lab_visit') {
  const services = (profile.services || []).filter(s => s.isActive !== false);
  const packages = (profile.packages || []).filter(p => p.isActive !== false);
  const serviceByCode = new Map(services.map(s => [String(s.testCode || '').trim().toLowerCase(), s]));
  const packageByCode = new Map(packages.map(p => [String(p.packageCode || '').trim().toLowerCase(), p]));

  const normalizedTestCodes = [...new Set((testCodes || []).map(v => String(v).trim()).filter(Boolean))];
  const normalizedPackageCodes = [...new Set((packageCodes || []).map(v => String(v).trim()).filter(Boolean))];
  if (!normalizedTestCodes.length && !normalizedPackageCodes.length) throw new Error('Select at least one test or package');

  const selectedTests = [];
  const selectedPackages = [];
  const seenTestCodes = new Set();
  let subtotal = 0;

  for (const code of normalizedPackageCodes) {
    const pkg = packageByCode.get(code.toLowerCase());
    if (!pkg) throw new Error(`Package ${code} is not available at this lab`);
    subtotal += Number(pkg.price || 0);
    selectedPackages.push({
      packageCode: pkg.packageCode,
      packageName: pkg.packageName,
      price: Number(pkg.price || 0),
      testCodes: pkg.testCodes || [],
    });

    for (const testCode of pkg.testCodes || []) {
      const svc = serviceByCode.get(String(testCode).toLowerCase());
      if (!svc) throw new Error(`Package ${pkg.packageName} contains unavailable test ${testCode}`);
      if (collectionType === 'home_collection' && svc.homeCollectionEligible === false) {
        throw new Error(`${svc.testName} is not eligible for home collection`);
      }
      const key = String(svc.testCode || svc.testName).toLowerCase();
      if (seenTestCodes.has(key)) continue;
      seenTestCodes.add(key);
      selectedTests.push({
        testCode: svc.testCode,
        testName: svc.testName,
        category: svc.category,
        price: 0,
        includedInPackage: true,
        sourcePackageCode: pkg.packageCode,
        sampleType: svc.sampleType,
        fastingRequired: svc.fastingRequired === true,
        reportTime: svc.reportTime,
        status: 'pending',
      });
    }
  }

  for (const code of normalizedTestCodes) {
    const svc = serviceByCode.get(code.toLowerCase());
    if (!svc) throw new Error(`Test ${code} is not available at this lab`);
    if (collectionType === 'home_collection' && svc.homeCollectionEligible === false) {
      throw new Error(`${svc.testName} is not eligible for home collection`);
    }
    const key = String(svc.testCode || svc.testName).toLowerCase();
    if (seenTestCodes.has(key)) continue;
    seenTestCodes.add(key);
    const price = Number(svc.price || 0);
    subtotal += price;
    selectedTests.push({
      testCode: svc.testCode,
      testName: svc.testName,
      category: svc.category,
      price,
      includedInPackage: false,
      sampleType: svc.sampleType,
      fastingRequired: svc.fastingRequired === true,
      reportTime: svc.reportTime,
      status: 'pending',
    });
  }

  const fastingTests = selectedTests.filter(t => t.fastingRequired);
  const fastingHours = Math.max(0, ...fastingTests.map(t => Number(serviceByCode.get(String(t.testCode).toLowerCase())?.fastingHours || 0)));
  const expectedReportHours = Math.max(0, ...selectedTests.map(t => Number(t.reportTime || 0)));

  return {
    tests: selectedTests,
    packages: selectedPackages,
    subtotal,
    fastingRequired: fastingTests.length > 0,
    fastingHours,
    expectedReportHours,
  };
}

async function reserveSlot({ pathologyId, date, startTime, endTime, session }) {
  const profile = await PathologyProfile.findById(pathologyId).session(session || null);
  if (!profile) throw new Error('Lab not found');
  if (profile.verificationStatus !== 'approved') throw new Error('Lab is not approved for bookings');

  const day = startOfDay(date);
  if (Number.isNaN(day.getTime())) throw new Error('Invalid booking date');
  const maxAdvanceDays = Number(profile.bookingSettings?.advanceBookingDays || 30);
  if (day < startOfDay(new Date())) throw new Error('Cannot book a past date');
  if (day.getTime() > startOfDay(Date.now() + maxAdvanceDays * 86400000).getTime()) {
    throw new Error(`Bookings are available up to ${maxAdvanceDays} days in advance`);
  }

  const holidays = (profile.operatingHours?.holidays || []).map(dateKey);
  if (holidays.includes(dateKey(day))) throw new Error('Lab is closed on the selected date');

  const slotDay = (profile.testSlots || []).find(s => dateKey(s.date) === dateKey(day));
  if (!slotDay) throw new Error('No collection slots configured for this date');
  const slot = (slotDay.timeSlots || []).find(s => s.startTime === startTime && s.endTime === endTime);
  if (!slot) throw new Error('Selected collection slot does not exist');

  const start = bookingDateTime(day, startTime);
  const minNoticeHours = Number(profile.bookingSettings?.minimumNoticeHours || 0);
  if (start && start.getTime() < Date.now() + minNoticeHours * 3600000) {
    throw new Error(`This lab requires at least ${minNoticeHours} hours booking notice`);
  }

  const max = Number(slot.maxCapacity || 0);
  const booked = Number(slot.bookedCount || 0);
  if (slot.isAvailable === false || max <= 0 || booked >= max) throw new Error('Selected collection slot is full');
  slot.bookedCount = booked + 1;
  if (slot.bookedCount >= max) slot.isAvailable = false;
  profile.markModified('testSlots');
  await profile.save(session ? { session } : undefined);
  return profile;
}

async function releaseSlot({ pathologyId, date, startTime, endTime, session }) {
  const profile = await PathologyProfile.findById(pathologyId).session(session || null);
  if (!profile) return;
  const slotDay = (profile.testSlots || []).find(s => dateKey(s.date) === dateKey(date));
  if (!slotDay) return;
  const slot = (slotDay.timeSlots || []).find(s => s.startTime === startTime && s.endTime === endTime);
  if (!slot) return;
  slot.bookedCount = Math.max(0, Number(slot.bookedCount || 0) - 1);
  if (slot.bookedCount < Number(slot.maxCapacity || 0)) slot.isAvailable = true;
  profile.markModified('testSlots');
  await profile.save(session ? { session } : undefined);
}

module.exports = {
  dateKey,
  startOfDay,
  bookingDateTime,
  mapAvailableSlots,
  buildCatalogSelection,
  reserveSlot,
  releaseSlot,
};
