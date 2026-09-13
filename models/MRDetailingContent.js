const mongoose = require('mongoose');

const mrDetailingContentSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  productName: { type: String, trim: true },
  contentType: { type: String, enum: ['url', 'pdf', 'video', 'image', 'presentation'], default: 'url' },
  url: { type: String, required: true, trim: true },
  description: String,
  tags: [{ type: String, trim: true }],
  isActive: { type: Boolean, default: true },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

mrDetailingContentSchema.index({ isActive: 1, productName: 1 });

module.exports = mongoose.model('MRDetailingContent', mrDetailingContentSchema);
