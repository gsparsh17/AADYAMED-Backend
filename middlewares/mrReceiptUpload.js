const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadDir = path.join(__dirname, '..', 'uploads', 'mr-receipts');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`);
  }
});

const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
module.exports = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowed.has(file.mimetype)) return cb(null, true);
    const error = new Error('Receipts must be a PDF, JPG, PNG or WEBP file');
    error.statusCode = 400;
    cb(error);
  }
});
