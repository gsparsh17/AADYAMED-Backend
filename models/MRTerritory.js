const mongoose = require('mongoose');

const mrTerritorySchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  headquarters: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  pincodes: [{ type: String, trim: true }],
  managerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

mrTerritorySchema.index({ code: 1 }, { unique: true });
mrTerritorySchema.index({ state: 1, city: 1, isActive: 1 });

module.exports = mongoose.model('MRTerritory', mrTerritorySchema);
