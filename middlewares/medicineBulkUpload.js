const multer = require('multer');

const allowedExt = /\.(csv|xlsx)$/i;

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => allowedExt.test(file.originalname || '')
    ? cb(null, true)
    : cb(new Error('Only .csv or .xlsx files are allowed'))
});
