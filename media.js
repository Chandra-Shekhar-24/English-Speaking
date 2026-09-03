// ============================================================
// media.js — file attachment uploads for Friend Chat
//
// Uses Cloudinary (free tier: 25GB storage/bandwidth) as the actual
// file store, since Render's own disk is wiped on every redeploy and
// isn't a real option for user-uploaded files (see README's caveat
// about english-passport-data.json). Every uploaded file is tagged
// with an expiry timestamp; a background job (see scheduleCleanup
// below) actually deletes the file from Cloudinary — not just from
// the UI — ~24 hours after it was sent.
//
// Requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,
// CLOUDINARY_API_SECRET in the environment. Without them, uploads are
// rejected with a clear error instead of silently failing.
// ============================================================
const cloudinary = require('cloudinary').v2;

const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB per file

const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // Video
  'video/mp4', 'video/webm', 'video/quicktime',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain'
]);

let configured = false;
function isConfigured() {
  if (configured) return true;
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
      secure: true
    });
    configured = true;
    return true;
  }
  return false;
}

function categoryFor(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function validateFile(file) {
  if (!file) return 'No file provided';
  if (file.size > MAX_FILE_SIZE_BYTES) return `File too large (max ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB)`;
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) return `File type "${file.mimetype}" is not supported`;
  return null;
}

// Uploads a buffer (from multer's memory storage) to Cloudinary and
// returns the metadata the chat message will carry.
function uploadBuffer(file) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(new Error('File uploads are not configured on this server (missing Cloudinary credentials).'));
    }
    const category = categoryFor(file.mimetype);
    // Cloudinary's `image`/`video` resource types get thumbnails,
    // transformations, and inline preview; everything else (pdf, doc,
    // etc.) goes in as `raw` so it's stored as-is and downloadable.
    const resourceType = category === 'file' ? 'raw' : category;
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        folder: 'english-passport-chat',
        // Belt-and-suspenders: also ask Cloudinary to expire the asset
        // itself via a signed delete token isn't available on free
        // plans, so the real deletion is done by our own cleanup job
        // (see scheduleCleanup) — this context tag just makes it easy
        // to spot stray files by hand in the Cloudinary dashboard too.
        context: `expires_at=${new Date(Date.now() + ATTACHMENT_TTL_MS).toISOString()}`
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          resourceType,
          type: category,
          filename: file.originalname,
          size: file.size,
          mimeType: file.mimetype,
          expiresAt: Date.now() + ATTACHMENT_TTL_MS,
          deleted: false
        });
      }
    );
    stream.end(file.buffer);
  });
}

async function deleteFromCloudinary(publicId, resourceType) {
  if (!isConfigured()) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'image' });
  } catch (e) {
    console.error('⚠️  Cloudinary delete failed for', publicId, ':', e.message);
  }
}

// ------------------------------------------------------------
// Background cleanup: every CLEANUP_INTERVAL_MS, ask the chat store
// (db.js) for attachments whose expiry has passed, actually delete
// each one from Cloudinary, then tell the store to mark it expired
// (clears the URL but keeps filename/type so the UI can render an
// "Attachment expired" bubble instead of a broken image).
// ------------------------------------------------------------
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

function scheduleCleanup(db) {
  async function runCleanup() {
    let expired = [];
    try {
      expired = db.getExpiredAttachments(Date.now());
    } catch (e) {
      console.error('⚠️  Attachment cleanup: could not read expired list:', e.message);
      return;
    }
    if (!expired.length) return;
    console.log(`🧹 Cleaning up ${expired.length} expired attachment(s)...`);
    for (const item of expired) {
      await deleteFromCloudinary(item.attachment.publicId, item.attachment.resourceType);
      db.markAttachmentExpired(item.messageId);
    }
    console.log(`🧹 Attachment cleanup done.`);
  }
  // Run once shortly after boot (catches anything that expired while
  // the server was down/redeploying), then on the regular interval.
  setTimeout(runCleanup, 30 * 1000);
  const timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  ATTACHMENT_TTL_MS,
  MAX_FILE_SIZE_BYTES,
  validateFile,
  uploadBuffer,
  scheduleCleanup,
  isConfigured
};
