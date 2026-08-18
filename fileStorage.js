// fileStorage.js — Filesystem-based storage for avatars, item photos, the
// school logo, procurement bills, purchase-log bills, and petty cash
// receipts.
//
// Why filesystem instead of MySQL LONGBLOB: on cPanel (and shared hosting
// generally), serving static files is dramatically cheaper than round-
// tripping every image through Node + a MySQL query — the web server layer
// can cache, set long-lived headers, and use range requests without ever
// touching the app process or the database connection pool. It also keeps
// the database small and fast to back up, and avoids the class of bug where
// a large BLOB column bloats every SELECT * unless carefully excluded.
//
// Layout (relative to this file's directory):
//   uploads/avatars/{userId}.{ext}            — public, served statically
//   uploads/items/{itemId}.{ext}               — public, served statically
//   uploads/logo/school-logo.{ext}              — public, served statically
//   uploads/private/bills/{procurementId}.{ext}          — auth required
//   uploads/private/purchase-logs/{purchaseLogId}.{ext}  — auth required, permanent
//   uploads/private/petty-receipts/{expenseId}.{ext}     — auth required
//
// "Public" here only means "servable without a DB round trip" — there is
// no sensitive data in an avatar, item photo, or school logo. Bills and
// receipts are financial documents, so those stay behind the same
// requireAuth checks the routes already had.
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'uploads');

const DIRS = {
  avatars:      path.join(ROOT, 'avatars'),
  items:        path.join(ROOT, 'items'),
  logo:         path.join(ROOT, 'logo'),
  bills:        path.join(ROOT, 'private', 'bills'),
  purchaseLogs: path.join(ROOT, 'private', 'purchase-logs'),
  pettyReceipts:path.join(ROOT, 'private', 'petty-receipts'),
  scrapBills:   path.join(ROOT, 'private', 'scrap-bills')
};

function ensureDirs() {
  Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf'
};
function extFor(mimetype) { return MIME_EXT[mimetype] || 'bin'; }

// Remove any existing file for this id regardless of its extension — used
// before writing a replacement, since a re-uploaded image might have a
// different type/extension than the one it's replacing.
function removeExisting(dir, id) {
  let found = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(id + '.')) { fs.unlinkSync(path.join(dir, f)); found = f; }
    }
  } catch { /* directory may not exist yet on a fresh install */ }
  return found;
}

// Writes a buffer to disk for the given category/id, replacing any prior
// file for that id. Returns the relative path stored in the DB, e.g.
// "avatars/usr_1.png" (public) or "private/bills/pr_1.pdf" (auth-gated).
//
// The relative path is derived directly from DIRS[category] (rather than
// a separate hand-maintained category->relBase mapping) so it can never
// drift out of sync with where the file actually gets written — that drift
// is exactly what happened when the 'scrapBills' category was added:
// DIRS pointed at .../private/scrap-bills, but a since-removed separate
// mapping still fell back to the raw category name ('scrapBills'), so the
// file was written to the right folder while the DB recorded a path to a
// folder that doesn't exist, and every later lookup 404'd.
function relBaseFor(category) {
  const dir = DIRS[category];
  if (!dir) throw new Error(`Unknown file storage category: ${category}`);
  return path.relative(ROOT, dir).split(path.sep).join('/');
}

function save(category, id, buffer, mimetype) {
  const dir = DIRS[category];
  if (!dir) throw new Error(`Unknown file storage category: ${category}`);
  removeExisting(dir, id);
  const ext = extFor(mimetype);
  const filename = `${id}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `${relBaseFor(category)}/${filename}`;
}

// Absolute path on disk for a stored relative path (as saved in the DB).
function absolutePath(relPath) {
  if (!relPath) return null;
  return path.join(ROOT, relPath);
}

function remove(relPath) {
  if (!relPath) return;
  try { fs.unlinkSync(absolutePath(relPath)); } catch { /* already gone — fine */ }
}

function exists(relPath) {
  if (!relPath) return false;
  try { return fs.statSync(absolutePath(relPath)).isFile(); } catch { return false; }
}

// Copies an existing stored file into a different category under a new id
// — used when a procurement request's bill needs to be duplicated into the
// permanent purchase-log record, so the audit trail keeps its own copy
// independent of whatever later happens to the original procurement
// request (e.g. someone removing/replacing its bill afterwards).
function copy(sourceRelPath, destCategory, destId) {
  if (!sourceRelPath || !exists(sourceRelPath)) return null;
  const dir = DIRS[destCategory];
  if (!dir) throw new Error(`Unknown file storage category: ${destCategory}`);
  removeExisting(dir, destId);
  const ext = path.extname(sourceRelPath).slice(1) || 'bin';
  const filename = `${destId}.${ext}`;
  fs.copyFileSync(absolutePath(sourceRelPath), path.join(dir, filename));
  return `${relBaseFor(destCategory)}/${filename}`;
}

module.exports = { ROOT, DIRS, ensureDirs, save, copy, absolutePath, remove, exists, extFor };
