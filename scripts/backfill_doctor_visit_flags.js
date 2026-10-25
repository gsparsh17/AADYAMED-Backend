/**
 * Writes explicit visit-type flags onto doctor profiles created before those
 * flags existed.
 *
 * Older records have `videoCallFee` / `homeVisitFee` set but no
 * `teleconsultationEnabled` / `homeVisitEnabled`. The intended rule (see
 * getDoctorTypeEnabled) is "no flag + fee above 0 = offered", and this makes
 * that explicit so every reader — the doctor app, the patient app, search —
 * sees the same thing.
 *
 * Usage:
 *   node scripts/backfill_doctor_visit_flags.js           # dry run: lists changes
 *   node scripts/backfill_doctor_visit_flags.js --apply   # writes them
 *
 * Only fills flags that are MISSING; a flag a doctor set themselves (true or
 * false) is never changed.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('doctorprofiles');
  const docs = await col
    .find(
      {
        $or: [
          { homeVisitEnabled: { $exists: false } },
          { teleconsultationEnabled: { $exists: false } },
          { clinicConsultationEnabled: { $exists: false } },
        ],
      },
      { projection: { name: 1, homeVisitFee: 1, videoCallFee: 1, homeVisitEnabled: 1, teleconsultationEnabled: 1, clinicConsultationEnabled: 1 } },
    )
    .toArray();

  if (!docs.length) {
    console.log('Every doctor profile already has explicit visit flags.');
    return mongoose.disconnect();
  }

  for (const d of docs) {
    const set = {};
    if (d.clinicConsultationEnabled === undefined) set.clinicConsultationEnabled = true;
    if (d.homeVisitEnabled === undefined) set.homeVisitEnabled = Number(d.homeVisitFee || 0) > 0;
    if (d.teleconsultationEnabled === undefined) set.teleconsultationEnabled = Number(d.videoCallFee || 0) > 0;
    console.log(`${apply ? 'Updating' : 'Would update'} ${d.name || d._id}: ${JSON.stringify(set)}`);
    if (apply) await col.updateOne({ _id: d._id }, { $set: set });
  }
  console.log(`\n${docs.length} profile(s) ${apply ? 'updated' : 'need updating — re-run with --apply'}.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
