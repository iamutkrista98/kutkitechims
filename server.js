// server.js — School Inventory & Asset Management System v2 (MySQL)
'use strict';
const express    = require('express');
const session    = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const rateLimit  = require('express-rate-limit');
const bodyParser = require('body-parser');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const multer     = require('multer');
const helmet     = require('helmet');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const files = require('./fileStorage');
const { buildInventoryExcel, buildLogExcel, rowValue } = require('./exports');
const { toBsShort, toBsFormatted, fiscalYear, todayBs, bsMonthRange } = require('./nepaliDate');
const mailer = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Security & performance middleware
// crossOriginResourcePolicy is set explicitly (rather than left at helmet's
// default of same-origin) so images/bills served from /api/images/... can
// never be silently blocked by the browser if the deployed app is ever
// accessed via more than one origin (e.g. both a bare domain and a "www."
// alias, or a staging subdomain) — a same-origin policy would make an
// <img> tag or PDF preview render as broken with no console-visible cause
// on the app side, since the block happens entirely in the browser.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(bodyParser.json({ limit: '20mb' }));

// Request ID for tracing
app.use((req, _res, next) => { req.id = uuidv4(); next(); });

// ---------------------------------------------------------------------------
// MySQL session store — uses its OWN small, dedicated connection pool
// rather than sharing db.js's pool. express-mysql-session does not
// reliably accept an externally-created mysql2/promise pool, so the two
// stay independent. Both are kept small and tunable via env vars: on
// shared hosting (cPanel etc.), total connections used by one Node
// process is roughly DB_CONNECTION_LIMIT + SESSION_CONNECTION_LIMIT —
// keep the sum comfortably under your MySQL user's connection quota,
// especially since Passenger may run more than one Node process instance
// under load.
// ---------------------------------------------------------------------------
const sessionStore = new MySQLStore({
  host:     process.env.DB_HOST || 'localhost',
  port:     Number(process.env.DB_PORT || 3306),
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'assettrack',
  connectionLimit: Number(process.env.SESSION_CONNECTION_LIMIT || 3),
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 43200000
});

sessionStore.on('error', (err) => {
  console.error('[session-store] Error:', err.message);
});

app.use(session({
  name:   'assettrack.sid',
  secret: process.env.SESSION_SECRET || 'assettrack-secret-key-change-in-production',
  store:  sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12, sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'public')));

// Ensure the uploads directory tree exists on disk before any request
// tries to read/write to it.
files.ensureDirs();

// ---------------------------------------------------------------------------
// Multer — memory storage (all images go straight to MySQL LONGBLOB)
// ---------------------------------------------------------------------------
const ALLOWED_IMG = /^image\/(png|jpe?g|webp|gif)$/;
const ALLOWED_DOC = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/;
// Kept deliberately tight (256 KB) — this app is commonly deployed behind
// shared-hosting proxies/WAFs (cPanel + ModSecurity being the case this
// was tuned against) that impose their own low, often-undocumented
// multipart body-size ceiling well below what this app's own limits used
// to allow; a large "valid" upload could pass every check here and still
// get silently killed by that intermediate layer. The client already
// compresses photos to fit well under this before ever sending them (see
// compressImageFile() in common.js) — this server-side limit is the
// backstop for anyone bypassing the browser UI directly (e.g. via curl).
const MAX_IMG  = 256 * 1024;  // 256 KB photos
const MAX_BILL = 256 * 1024;  // 256 KB bills/receipts

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_IMG },
  fileFilter(req, file, cb) {
    if (!ALLOWED_IMG.test(file.mimetype))
      return cb(new Error('Please upload a PNG, JPG, WEBP or GIF image (max 256 KB).'));
    cb(null, true);
  }
}).single('image');

const billUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BILL },
  fileFilter(req, file, cb) {
    if (!ALLOWED_DOC.test(file.mimetype))
      return cb(new Error('Please upload an image (PNG/JPG/WEBP) or PDF document (max 256 KB) for the bill/receipt.'));
    cb(null, true);
  }
}).single('bill');

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BILL },
  fileFilter(req, file, cb) {
    if (!ALLOWED_DOC.test(file.mimetype))
      return cb(new Error('Please upload an image or PDF receipt (max 256 KB).'));
    cb(null, true);
  }
}).single('receipt');

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { error: 'Too many login attempts. Please wait a few minutes.' }
});
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 5,
  message: { error: 'Too many OTP requests. Please wait 10 minutes.' }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowStamp = () => new Date().toISOString();
const uid = (p) => db.uid ? db.uid(p) : `${p}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in.' });
  const me = await currentUser(req);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can do this.' });
  next();
}

// Caches the resolved user on the request object. Several middleware/
// handlers can run in the same request (e.g. requireAdmin, then
// requireDashboardAccess, then the route handler itself), each of which
// needs the current user — this way a chain like that does exactly one
// users-table lookup no matter how many times currentUser(req) is called
// while handling it.
async function currentUser(req) {
  if (req._cachedUser !== undefined) return req._cachedUser;
  const users = await db.load('users');
  const found = users.find(u => u.id === req.session.userId) || null;
  req._cachedUser = found;
  return found;
}

async function isManagerOf(managerId, employeeId) {
  const users = await db.load('users');
  const emp = users.find(u => u.id === employeeId);
  return !!emp && emp.managerId === managerId;
}

function resolveDateRange(query) {
  let { from, to, bsFromYear, bsFromMonth, bsToYear, bsToMonth } = query;
  if (bsFromYear && bsFromMonth) {
    const range = bsMonthRange(Number(bsFromYear), Number(bsFromMonth));
    if (range) from = range.startAD;
  }
  if (bsToYear && bsToMonth) {
    const range = bsMonthRange(Number(bsToYear), Number(bsToMonth));
    if (range) to = range.endAD;
  }
  return { from, to };
}

async function visibleLocationIds(user) {
  if (!user || user.role === 'admin') return null;
  const deptIds = new Set(user.departmentIds || []);
  const locations = await db.load('locations');
  const ids = locations
    .filter(l => (l.departmentId && deptIds.has(l.departmentId)) || l.custodianId === user.id || l.sharedAccess)
    .map(l => l.id);
  return new Set(ids);
}

async function scopeByLocation(rows, user, key = 'locationId') {
  const allowed = await visibleLocationIds(user);
  if (!allowed) return rows;
  return rows.filter(r => !r[key] || allowed.has(r[key]));
}

async function custodianLocationCount(userId) {
  if (!userId) return 0;
  const locs = await db.load('locations');
  return locs.filter(l => l.custodianId === userId).length;
}

async function hasFullDashboardAccess(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (user.dashboardAccess === 'granted') return true;
  if (user.dashboardAccess === 'denied')  return false;
  const locCount = await custodianLocationCount(user.id);
  if (locCount === 0) return true;
  return locCount >= 2;
}

async function requireDashboardAccess(req, res, next) {
  const me = await currentUser(req);
  if (!await hasFullDashboardAccess(me)) {
    return res.status(403).json({ error: 'Your account is limited to a single location. Ask an administrator to grant dashboard access.' });
  }
  next();
}

// Scrap access is its own permission, independent of dashboard access — an
// administrator can let someone browse the full inventory without letting
// them see disposal/revaluation records, or vice versa. Admins always have
// it; managers get it by default (can be revoked); staff need an explicit
// grant. An explicit 'granted'/'denied' override always wins.
function hasScrapAccess(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.scrapAccess === 'granted') return true;
  if (user.scrapAccess === 'denied')  return false;
  return user.role === 'manager';
}

async function requireScrapAccess(req, res, next) {
  const me = await currentUser(req);
  if (!hasScrapAccess(me)) {
    return res.status(403).json({ error: "You don't have permission to view or manage scrapped inventory. Ask an administrator to grant scrap access." });
  }
  next();
}

function withItemMiti(item) {
  return { ...item, purchaseDateMiti: toBsShort(item.purchaseDate), warrantyExpiryMiti: toBsShort(item.warrantyExpiry), createdAtMiti: toBsShort(item.createdAt) };
}
function withTransferMiti(t) {
  return { ...t, createdAtMiti: toBsShort(t.createdAt), completedAtMiti: toBsShort(t.completedAt) };
}
function withProcurementMiti(p) {
  return { ...p, createdAtMiti: toBsShort(p.createdAt), orderedAtMiti: toBsShort(p.orderedAt), receivedAtMiti: toBsShort(p.receivedAt) };
}
function withRepairMiti(r) {
  return { ...r, reportedAtMiti: toBsShort(r.reportedAt), resolvedAtMiti: toBsShort(r.resolvedAt) };
}

function computeApprovalStatus(managerDecision, adminDecision) {
  if (managerDecision === 'rejected' || adminDecision === 'rejected') return 'rejected';
  if ((managerDecision === 'approved' || managerDecision === 'not_required') && adminDecision === 'approved') return 'approved';
  return 'pending';
}

function initialDecisionState(requester) {
  const managerDecision = requester && requester.managerId ? 'pending' : 'not_required';
  return { managerDecision, managerReviewedBy: null, managerReviewedAt: null, adminDecision: 'pending', adminReviewedBy: null, adminReviewedAt: null, status: computeApprovalStatus(managerDecision, 'pending') };
}

function titleCase(s) { return String(s || '—').split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' '); }

// Shared error responder for route-level catch blocks. Special-cases MySQL
// connection-pool exhaustion (all connections busy, queue full) to return a
// clean, friendly JSON 503 instead of the default 500 — on shared hosting
// with a low connection quota, this is what a request looks like when it
// couldn't get a DB connection in time. Failing fast and clearly here beats
// letting the request hang until the upstream reverse proxy (Apache/
// Passenger on cPanel) gives up and returns its own non-JSON timeout page,
// which is what "failed to execute json" / an unexpected 408 looks like to
// the browser.
const POOL_EXHAUSTION_CODES = new Set(['ER_CON_COUNT_ERROR', 'POOL_ENQUEUE_LIMIT', 'ER_TOO_MANY_USER_CONNECTIONS']);
// mysql2's own pool-exhaustion errors are plain Error objects with only a
// .message (no .code) — verified against mysql2's source directly. Match on
// message text for these; everything else uses the documented .code values.
const POOL_EXHAUSTION_MESSAGES = new Set(['Queue limit reached.', 'No connections available.']);
function sendError(res, req, err) {
  if (POOL_EXHAUSTION_CODES.has(err.code) || POOL_EXHAUSTION_MESSAGES.has(err.message)) {
    console.error(`[db] Connection pool saturated (${err.code || err.message}) on ${req?.method || '?'} ${req?.path || '?'}. If this happens often, review DB_CONNECTION_LIMIT/DB_QUEUE_LIMIT against your hosting plan's MySQL connection quota.`);
    return res.status(503).json({ error: 'The server is handling a lot of requests right now. Please try again in a moment.', code: err.code || 'POOL_SATURATED' });
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNREFUSED') {
    console.error(`[db] Database connectivity error (${err.code}) on ${req?.method || '?'} ${req?.path || '?'}: ${err.message}`);
    return res.status(503).json({ error: 'Lost connection to the database. Please try again in a moment.', code: err.code });
  }
  res.status(500).json({ error: err.message });
}


// Keep the scrap register in sync whenever an item's condition crosses the
// 'disposed' boundary in either direction. Disposing sends it to Scraps
// (valued separately, excluded from live inventory + dashboard valuation);
// un-disposing (rare, e.g. a data-entry correction) pulls it back out.
async function syncScrapForCondition(item, previousCondition, newCondition, actor) {
  if (previousCondition === newCondition) return;
  if (newCondition === 'disposed') {
    const existing = await db.getScrapByItemId(item.id);
    if (existing) return;
    const qty = item.quantity || 1;
    await db.insertScrapRecord({
      itemId: item.id, itemCode: item.itemCode, name: item.name,
      categoryId: item.categoryId, categoryName: item.categoryName,
      quantity: qty, unit: item.unit,
      locationId: item.locationId, locationName: item.locationName,
      originalUnitCost: item.purchaseCost || null,
      originalValue: (item.purchaseCost || 0) * qty,
      conditionAtDisposal: previousCondition,
      disposedAt: nowStamp(), disposedById: actor?.id, disposedByName: actor?.name || 'System'
    });
  } else if (previousCondition === 'disposed') {
    await db.removeScrapRecord(item.id);
  }
}

async function logCondition(itemId, itemName, previousCondition, newCondition, note, actor) {
  if (previousCondition === newCondition) return;
  const log = {
    id: uid('log'), itemId, itemName, previousCondition, newCondition,
    note: note || null, loggedById: actor ? actor.id : null,
    loggedByName: actor ? actor.name : 'System', loggedAt: nowStamp()
  };
  await db.insertOne('conditionLogs', log);
}

async function adminEmails() {
  const users = await db.load('users');
  return users.filter(u => u.role === 'admin' && mailer.wantsMail(u)).map(u => u.email);
}

// Email notifications are entirely best-effort side effects — nobody
// should sit waiting on a real SMTP round-trip (which can easily take
// seconds, especially fanned out to several admins) just to see their
// approve/reject/submit action confirmed. Every notification in this file
// is fired through here instead of being awaited inline, so the HTTP
// response goes out as soon as the actual state change is saved; a failed
// or slow email only gets logged, never blocks or fails the request.
function notifyAsync(promiseFactory) {
  Promise.resolve().then(promiseFactory).catch(err => {
    console.error('[email notification failed]', err && err.message ? err.message : err);
  });
}

async function notifyAdminsNewRequest({ kind, title, rows }) {
  const emails = await adminEmails();
  // In parallel, not sequential — with N admins this was N times slower
  // than it needed to be, and since callers now fire this whole function
  // through notifyAsync() anyway, nothing is waiting on it regardless.
  await Promise.all(emails.map(email => mailer.sendNewRequest({ to: email, kind, requesterName: title, rows })));
}

// Generic requester notification used by flows that don't have a
// dedicated mailer.sendXxxDecision() helper (repair status updates,
// manager-level approve/decline). Skips silently if the user has emails
// turned off, matching mailer.wantsMail()'s use elsewhere.
async function notifyRequester(user, { subject, title, rows }) {
  if (!user?.email || !mailer.wantsMail(user)) return;
  notifyAsync(async () => {
    const settings = await db.getSettings();
    const html = await mailer.wrapEmail({
      schoolName: settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo,
      headerTitle: title,
      bodyHtml: mailer.infoTable(rows)
    });
    await mailer.sendMail({ to: user.email, subject, html });
  });
}

// ---------------------------------------------------------------------------
// Image serving endpoints — files live on disk (see fileStorage.js); these
// routes resolve the stored relative path (one cheap VARCHAR lookup) and
// stream the file with res.sendFile(), which supports range requests and
// conditional GETs natively. Kept at the same URLs as before so the
// frontend doesn't need to change how it builds image URLs.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Health check — for cPanel/uptime monitoring and load balancers. Verifies
// the database connection pool can actually reach MySQL (not just that the
// Node process is alive), since a "process running but DB unreachable"
// state is the scenario that most needs to be caught quickly in production.
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const start = Date.now();
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', uptimeSeconds: Math.floor(process.uptime()), responseMs: Date.now() - start });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', error: err.message });
  }
});

app.get('/api/images/avatar/:id', async (req, res) => {
  try {
    const relPath = await db.getAvatarPath(req.params.id);
    if (!relPath) return res.status(404).end();
    res.sendFile(files.absolutePath(relPath), { maxAge: '30d' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

app.get('/api/images/item/:id', async (req, res) => {
  try {
    const relPath = await db.getItemPhotoPath(req.params.id);
    if (!relPath) return res.status(404).end();
    res.sendFile(files.absolutePath(relPath), { maxAge: '30d' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

app.get('/api/images/logo', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const relPath = await db.getLogoPath();
    if (!relPath) return res.status(404).end();
    res.sendFile(files.absolutePath(relPath), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

app.get('/api/images/procurement/:id/bill', requireAuth, async (req, res) => {
  try {
    const row = await db.getProcurementBillPath(req.params.id);
    if (!row || !row.bill_path) return res.status(404).end();
    res.sendFile(files.absolutePath(row.bill_path), {
      maxAge: '10m',
      headers: { 'Content-Disposition': `inline; filename="${row.bill_filename || 'bill'}"` }
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

// ---------------------------------------------------------------------------
// Auth — login / logout / me
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = await db.load('users');
    const user  = users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
    if (!user || user.status !== 'active' || !bcrypt.compareSync(password || '', user.passwordHash))
      return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.userId = user.id;
    const isManager = users.some(u => u.managerId === user.id);
    const manager   = user.managerId ? users.find(u => u.id === user.managerId) : null;
    const depts = await db.load('departments');
    const departmentNames = (user.departmentIds || []).map(id => (depts.find(d => d.id === id) || {}).name).filter(Boolean);
    const locs = await db.load('locations');
    const custodianLocations = locs.filter(l => l.custodianId === user.id).map(l => l.name);
    res.json({ user: { ...publicUser(user), isManager, managerName: manager ? manager.name : null, departmentNames, custodianLocations, hasFullDashboardAccess: await hasFullDashboardAccess(user), hasScrapAccess: hasScrapAccess(user) } });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('assettrack.sid'); res.json({ ok: true }); });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const users = await db.load('users');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'Not found.' });
    const isManager = users.some(u => u.managerId === user.id);
    const manager   = user.managerId ? users.find(u => u.id === user.managerId) : null;
    const depts = await db.load('departments');
    const departmentNames = (user.departmentIds || []).map(id => (depts.find(d => d.id === id) || {}).name).filter(Boolean);
    const locs = await db.load('locations');
    const custodianLocations = locs.filter(l => l.custodianId === user.id).map(l => l.name);
    res.json({ user: { ...publicUser(user), isManager, managerName: manager ? manager.name : null, departmentNames, custodianLocations, hasFullDashboardAccess: await hasFullDashboardAccess(user), hasScrapAccess: hasScrapAccess(user) } });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Forgot password — OTP flow
// ---------------------------------------------------------------------------
app.post('/api/auth/forgot-password', otpLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    // Always return success to prevent email enumeration
    const users = await db.load('users');
    const user  = users.find(u => u.email.toLowerCase() === email && u.status === 'active');
    if (user) {
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      await db.createOtp(user.id, user.email, otp, expires);
      const s = await db.getSettings();
      await mailer.sendOtp({ to: user.email, name: user.name, otp, schoolName: s.schoolName });
    }
    res.json({ ok: true, message: 'If that email exists, an OTP has been sent.' });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required.' });
    const row = await db.verifyOtp(email.toLowerCase().trim(), String(otp).trim());
    if (!row) return res.status(400).json({ error: 'Invalid or expired OTP.' });
    // Issue a short-lived reset token stored in session
    req.session.resetToken = { userId: row.user_id, otpId: row.id, at: Date.now() };
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const token = req.session.resetToken;
    if (!token || Date.now() - token.at > 15 * 60 * 1000)
      return res.status(400).json({ error: 'Session expired. Please request a new OTP.' });
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const users = await db.load('users');
    const user  = users.find(u => u.id === token.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    user.passwordHash = bcrypt.hashSync(newPassword, 8);
    await db.save('users', users);
    await db.consumeOtp(token.otpId);
    delete req.session.resetToken;
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Profile image
// ---------------------------------------------------------------------------
app.post('/api/auth/profile-image', requireAuth, (req, res) => {
  upload(req, res, async (err) => {
    if (err) { console.error(`[upload][${req.id||'-'}] multer rejected ${req.method} ${req.path} —`, err.message); return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    try {
      const relPath = files.save('avatars', req.session.userId, req.file.buffer, req.file.mimetype);
      await db.setAvatarPath(req.session.userId, relPath);
      const users = await db.load('users');
      const user  = users.find(u => u.id === req.session.userId);
      res.json({ user: publicUser(user), avatarUrl: `/api/images/avatar/${req.session.userId}?t=${Date.now()}` });
    } catch (e) { console.error(`[upload][${req.id||'-'}] ${req.method} ${req.path} —`, e.message); res.status(500).json({ error: e.message }); }
  });
});

app.delete('/api/auth/profile-image', requireAuth, async (req, res) => {
  try {
    const oldPath = await db.getAvatarPath(req.session.userId);
    await db.clearAvatarPath(req.session.userId);
    files.remove(oldPath);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const users = await db.load('users');
    const user  = users.find(u => u.id === req.session.userId);
    if (!bcrypt.compareSync(currentPassword || '', user.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
    user.passwordHash = bcrypt.hashSync(newPassword, 8);
    await db.save('users', users);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// PWA manifest — generated per-request (not a static file) so the app name
// and icon reflect each school's actual branding: if a logo has been
// uploaded, it's used as the install icon; otherwise the bundled generic
// AssetTrack icon is used. Maskable icons are always the bundled generic
// ones regardless, since an arbitrary uploaded logo isn't guaranteed to be
// safe-zone-padded the way a maskable icon needs to be.
app.get('/manifest.json', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const settings = await db.getSettings();
    const name = settings.schoolName ? `AssetTrack — ${settings.schoolName}` : 'AssetTrack';
    const icons = settings.hasLogo
      ? [
          { src: `/api/images/logo?t=${Date.now()}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `/api/images/logo?t=${Date.now()}`, sizes: '512x512', type: 'image/png', purpose: 'any' }
        ]
      : [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
        ];
    icons.push(
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    );
    res.json({
      name, short_name: (settings.schoolName || 'AssetTrack').slice(0, 30), description: 'School inventory and asset management',
      start_url: '/dashboard.html', id: '/dashboard.html', scope: '/',
      display: 'standalone', background_color: '#ffffff', theme_color: '#12204A',
      orientation: 'any', icons
    });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Settings / branding
// ---------------------------------------------------------------------------
app.get('/api/settings/public', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const settings = await db.getSettings();
    const [users, departments, locations, items] = await Promise.all([db.load('users'), db.load('departments'), db.load('locations'), db.load('items')]);
    res.json({ settings, stats: { staffCount: users.filter(u => u.status === 'active').length, departmentCount: departments.length, locationCount: locations.length, itemCount: items.length } });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/settings', requireAdmin, async (req, res) => {
  try {
    const { schoolName, tagline, primaryColor, pettyCashLimit } = req.body;
    if (schoolName !== undefined && !schoolName.trim()) return res.status(400).json({ error: 'School name cannot be empty.' });
    if (pettyCashLimit !== undefined && pettyCashLimit !== '' && (Number.isNaN(Number(pettyCashLimit)) || Number(pettyCashLimit) < 0))
      return res.status(400).json({ error: 'Petty cash limit must be a non-negative number.' });
    const settings = await db.saveSettings({
      schoolName: schoolName?.trim(), tagline, primaryColor,
      pettyCashLimit: pettyCashLimit !== undefined && pettyCashLimit !== '' ? Number(pettyCashLimit) : undefined
    });
    res.json({ settings });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/settings/logo', requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) { console.error(`[upload][${req.id||'-'}] multer rejected ${req.method} ${req.path} —`, err.message); return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    try {
      const relPath = files.save('logo', 'school-logo', req.file.buffer, req.file.mimetype);
      await db.setLogoPath(relPath);
      const settings = await db.getSettings();
      mailer.invalidateLogoCache(); res.json({ settings, logoUrl: `/api/images/logo?t=${Date.now()}` });
    } catch (e) { console.error(`[upload][${req.id||'-'}] ${req.method} ${req.path} —`, e.message); res.status(500).json({ error: e.message }); }
  });
});

app.delete('/api/settings/logo', requireAdmin, async (req, res) => {
  try {
    const oldPath = await db.getLogoPath();
    await db.clearLogoPath();
    files.remove(oldPath);
    mailer.invalidateLogoCache();
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Dashboard overview
// ---------------------------------------------------------------------------
app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const me = await currentUser(req);
    let items = await db.load('items');
    items = await scopeByLocation(items, me);
    let transfers  = await db.load('transfers');
    let procurement = await db.load('procurementRequests');
    let repairs    = await scopeByLocation(await db.load('repairRequests'), me);
    const users    = await db.load('users');
    const allowedLocs = await visibleLocationIds(me);
    if (allowedLocs) transfers = transfers.filter(t => (!t.fromLocationId || allowedLocs.has(t.fromLocationId)) || (!t.toLocationId || allowedLocs.has(t.toLocationId)));

    const totalItems  = items.length;
    // Disposed goods are valued separately under Scraps (see below) — they
    // never contribute to the live inventory valuation shown here.
    const valuedItems = items.filter(i => i.condition !== 'disposed');
    const totalValue  = +valuedItems.reduce((s, i) => s + rowValue(i), 0).toFixed(2);
    const underRepair = items.filter(i => i.condition === 'under_repair').length;
    const damaged     = items.filter(i => i.condition === 'damaged').length;
    const disposed    = items.filter(i => i.condition === 'disposed').length;
    const lowStock    = items.filter(i => i.trackingType === 'stock' && i.minStockLevel != null && (i.quantity || 0) <= i.minStockLevel);

    const warrantyToday   = todayStr();
    const warnDate = new Date(); warnDate.setDate(warnDate.getDate() + 30);
    const warrantyHorizon = warnDate.toISOString().slice(0, 10);
    const warrantyAlerts  = items
      .filter(i => i.warrantyExpiry && i.condition !== 'disposed' && i.warrantyExpiry <= warrantyHorizon)
      .map(i => ({ ...i, warrantyExpired: i.warrantyExpiry < warrantyToday }))
      .sort((a, b) => (a.warrantyExpiry || '').localeCompare(b.warrantyExpiry || ''));

    const pendingTransfers  = transfers.filter(t => t.adminDecision === 'pending').length;
    const pendingProcurement = procurement.filter(p => p.adminDecision === 'pending').length;
    const openRepairs       = repairs.filter(r => !['repaired', 'not_repairable', 'cancelled'].includes(r.status)).length;

    const byCategory = {};
    valuedItems.forEach(i => {
      const key = i.categoryName || 'Uncategorized';
      if (!byCategory[key]) byCategory[key] = { category: key, count: 0, value: 0 };
      byCategory[key].count++;
      byCategory[key].value += rowValue(i);
    });
    const byLocation = {};
    items.forEach(i => {
      const key = i.locationName || 'Unassigned';
      if (!byLocation[key]) byLocation[key] = { location: key, count: 0 };
      byLocation[key].count++;
    });

    const activity = [
      ...transfers.slice(0, 10).map(t => ({ type: 'transfer', date: t.createdAt, miti: toBsShort(t.createdAt), text: `${t.requestedByName} requested to move ${t.itemName} to ${t.toLocationName}`, status: t.status, targetView: 'transfers', targetId: t.id })),
      ...procurement.slice(0, 10).map(p => ({ type: 'procurement', date: p.createdAt, miti: toBsShort(p.createdAt), text: `${p.requestedByName} requested ${p.quantity || ''} ${p.itemName}`.trim(), status: p.status, targetView: 'procurement', targetId: p.id })),
      ...repairs.slice(0, 10).map(r => ({ type: 'repair', date: r.reportedAt, miti: toBsShort(r.reportedAt), text: `${r.reportedByName} reported an issue with ${r.itemName}`, status: r.status, targetView: 'repairs', targetId: r.id }))
    ].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 15);

    // Pending review lists for quick dashboard action
    const pendingTransferList   = transfers.filter(t => t.adminDecision === 'pending').slice(0, 5).map(withTransferMiti);
    const pendingProcurementList = procurement.filter(p => p.adminDecision === 'pending').slice(0, 5).map(withProcurementMiti);
    const pendingRepairList     = repairs.filter(r => r.status === 'reported').slice(0, 5).map(withRepairMiti);

    // Scraps — kept in a wholly separate section so it never blends into
    // the inventory valuation above; only shown to users with scrap access.
    let scrapSummary = null;
    if (hasScrapAccess(me)) {
      const scraps = await db.listScraps();
      scrapSummary = {
        totalScrapItems: scraps.length,
        totalScrapValue: +scraps.reduce((s, r) => s + (r.depreciatedValue != null ? r.depreciatedValue : r.originalValue), 0).toFixed(2)
      };
    }

    const today = todayStr();
    res.json({
      totalItems, totalValue, underRepair, damaged, disposed, scrapSummary,
      lowStockCount: lowStock.length, lowStock: lowStock.slice(0, 8),
      warrantyAlertCount: warrantyAlerts.length, warrantyAlerts: warrantyAlerts.slice(0, 8),
      pendingApprovals: pendingTransfers + pendingProcurement,
      pendingTransfers, pendingProcurement, openRepairs,
      activeUsers: users.filter(u => u.status === 'active').length,
      byCategory: Object.values(byCategory).sort((a, b) => b.count - a.count),
      byLocation: Object.values(byLocation).sort((a, b) => b.count - a.count),
      activity,
      pendingTransferList, pendingProcurementList, pendingRepairList,
      date: today, dateMiti: toBsFormatted(today), todayBs: todayBs(), fiscalYear: fiscalYear(today)
    });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------
app.get('/api/departments', requireAuth, async (req, res) => {
  try { res.json({ departments: await db.load('departments') }); }
  catch (err) { sendError(res, req, err); }
});

app.post('/api/departments', requireAdmin, async (req, res) => {
  try {
    const { name, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'A name is required.' });
    const departments = await db.load('departments');
    if (departments.some(d => d.name.toLowerCase() === name.trim().toLowerCase()))
      return res.status(400).json({ error: 'A department with this name already exists.' });
    const dept = { id: uid('dep'), name: name.trim(), notes: notes || '' };
    await db.insertOne('departments', dept);
    res.json({ department: dept });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/departments/:id', requireAdmin, async (req, res) => {
  try {
    const departments = await db.load('departments');
    const dept = departments.find(d => d.id === req.params.id);
    if (!dept) return res.status(404).json({ error: 'Department not found.' });
    if (req.body.name !== undefined) dept.name = req.body.name.trim();
    if (req.body.notes !== undefined) dept.notes = req.body.notes;
    await db.save('departments', departments);
    const locations = await db.load('locations');
    let touched = false;
    locations.forEach(l => { if (l.departmentId === dept.id && l.departmentName !== dept.name) { l.departmentName = dept.name; touched = true; } });
    if (touched) await db.save('locations', locations);
    res.json({ department: dept });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/departments/:id', requireAdmin, async (req, res) => {
  try {
    const [locations, users, departments] = await Promise.all([db.load('locations'), db.load('users'), db.load('departments')]);
    if (locations.some(l => l.departmentId === req.params.id)) return res.status(400).json({ error: 'This department still has locations. Reassign them first.' });
    if (users.some(u => (u.departmentIds || []).includes(req.params.id))) return res.status(400).json({ error: 'This department still has staff. Reassign them first.' });
    await db.save('departments', departments.filter(d => d.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
app.get('/api/locations', requireAuth, async (req, res) => {
  try { res.json({ locations: await db.load('locations') }); }
  catch (err) { sendError(res, req, err); }
});

app.post('/api/locations', requireAdmin, async (req, res) => {
  try {
    const { name, type, building, floor, custodianId, notes, departmentId, sharedAccess } = req.body;
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const [users, departments, locations] = await Promise.all([db.load('users'), db.load('departments'), db.load('locations')]);
    const custodian = custodianId ? users.find(u => u.id === custodianId) : null;
    const dept      = departmentId ? departments.find(d => d.id === departmentId) : null;
    const loc = { id: uid('loc'), name, type: type || 'Room', building: building || '', floor: floor || '', departmentId: dept?.id || null, departmentName: dept?.name || null, custodianId: custodianId || null, custodianName: custodian?.name || null, notes: notes || '', sharedAccess: !!sharedAccess };
    await db.insertOne('locations', loc);
    res.json({ location: loc });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/locations/:id', requireAdmin, async (req, res) => {
  try {
    const locations = await db.load('locations');
    const loc = locations.find(l => l.id === req.params.id);
    if (!loc) return res.status(404).json({ error: 'Location not found.' });
    const [users, departments] = await Promise.all([db.load('users'), db.load('departments')]);
    ['name','type','building','floor','custodianId','notes','departmentId'].forEach(k => { if (req.body[k] !== undefined) loc[k] = req.body[k] === '' && ['custodianId','departmentId'].includes(k) ? null : req.body[k]; });
    if (req.body.sharedAccess !== undefined) loc.sharedAccess = !!req.body.sharedAccess;
    const custodian = loc.custodianId ? users.find(u => u.id === loc.custodianId) : null;
    loc.custodianName = custodian?.name || null;
    const dept = loc.departmentId ? departments.find(d => d.id === loc.departmentId) : null;
    loc.departmentName = dept?.name || null;
    await db.save('locations', locations);
    res.json({ location: loc });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/locations/:id', requireAdmin, async (req, res) => {
  try {
    const [items, locations] = await Promise.all([db.load('items'), db.load('locations')]);
    if (items.some(i => i.locationId === req.params.id)) return res.status(400).json({ error: 'This location still has items. Move or reassign them first.' });
    if (!locations.some(l => l.id === req.params.id)) return res.status(404).json({ error: 'Location not found.' });
    await db.save('locations', locations.filter(l => l.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
app.get('/api/categories', requireAuth, async (req, res) => {
  try { res.json({ categories: await db.load('categories') }); }
  catch (err) { sendError(res, req, err); }
});

app.post('/api/categories', requireAdmin, async (req, res) => {
  try {
    const { name, trackingType, defaultUnit } = req.body;
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const cat = { id: uid('cat'), name, trackingType: trackingType === 'stock' ? 'stock' : 'asset', defaultUnit: defaultUnit || 'pcs' };
    await db.insertOne('categories', cat);
    res.json({ category: cat });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const categories = await db.load('categories');
    const cat = categories.find(c => c.id === req.params.id);
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    ['name','trackingType','defaultUnit'].forEach(k => { if (req.body[k] !== undefined) cat[k] = req.body[k]; });
    await db.save('categories', categories);
    res.json({ category: cat });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const [items, categories] = await Promise.all([db.load('items'), db.load('categories')]);
    if (items.some(i => i.categoryId === req.params.id)) return res.status(400).json({ error: 'Items are still using this category. Recategorize them first.' });
    await db.save('categories', categories.filter(c => c.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------
app.get('/api/vendors', requireAuth, async (req, res) => {
  try { res.json({ vendors: await db.load('vendors') }); }
  catch (err) { sendError(res, req, err); }
});

app.post('/api/vendors', requireAdmin, async (req, res) => {
  try {
    const { name, contactPerson, phone, email, address, supplies, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const vendor = { id: uid('ven'), name, contactPerson: contactPerson || '', phone: phone || '', email: email || '', address: address || '', supplies: supplies || '', notes: notes || '' };
    await db.insertOne('vendors', vendor);
    res.json({ vendor });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/vendors/:id', requireAdmin, async (req, res) => {
  try {
    const vendors = await db.load('vendors');
    const vendor  = vendors.find(v => v.id === req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    ['name','contactPerson','phone','email','address','supplies','notes'].forEach(k => { if (req.body[k] !== undefined) vendor[k] = req.body[k]; });
    await db.save('vendors', vendors);
    res.json({ vendor });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/vendors/:id', requireAdmin, async (req, res) => {
  try {
    const vendors = await db.load('vendors');
    if (!vendors.some(v => v.id === req.params.id)) return res.status(404).json({ error: 'Vendor not found.' });
    await db.save('vendors', vendors.filter(v => v.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const [users, departments] = await Promise.all([db.load('users'), db.load('departments')]);
    res.json({ users: users.map(u => ({ ...publicUser(u), managerName: (users.find(m => m.id === u.managerId) || {}).name || null, departmentNames: (u.departmentIds || []).map(id => (departments.find(d => d.id === id) || {}).name).filter(Boolean), custodianLocationCount: 0, effectiveDashboardAccess: true })) });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { name, email, role, locationId, managerId, phone, departmentIds, dashboardAccess, scrapAccess, emailNotifications } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
    const [users, departments] = await Promise.all([db.load('users'), db.load('departments')]);
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ error: 'A user with this email already exists.' });
    const validDeptIds = Array.isArray(departmentIds) ? departmentIds.filter(id => departments.some(d => d.id === id)) : [];
    const division = validDeptIds.map(id => (departments.find(d => d.id === id) || {}).name).filter(Boolean).join(', ');
    const user = { id: uid('usr'), name, email, passwordHash: bcrypt.hashSync('Welcome@123', 8), role: ['admin','manager','staff'].includes(role) ? role : 'staff', division, departmentIds: validDeptIds, locationId: locationId || null, managerId: managerId || null, phone: phone || '', avatarColor: ['#1B2F63','#274E8C','#2E6B9E','#3F8F6A','#6DAF3C','#8CC63F'][users.length % 6], hasAvatar: false, status: 'active', createdAt: todayStr(), dashboardAccess: ['granted','denied'].includes(dashboardAccess) ? dashboardAccess : null, scrapAccess: ['granted','denied'].includes(scrapAccess) ? scrapAccess : null, emailNotifications: emailNotifications !== false };
    await db.insertOne('users', user);
    mailer.sendWelcomeUser({ to: user.email, name: user.name, tempPassword: 'Welcome@123' }).catch(()=>{});
    res.json({ user: publicUser(user), tempPassword: 'Welcome@123' });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const users = await db.load('users');
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (req.body.email !== undefined) {
      const newEmail = String(req.body.email).trim();
      if (!newEmail) return res.status(400).json({ error: 'Email cannot be empty.' });
      if (users.some(u => u.id !== user.id && u.email.toLowerCase() === newEmail.toLowerCase())) return res.status(400).json({ error: 'Another user already uses this email.' });
    }
    if (req.body.managerId && req.body.managerId === user.id) return res.status(400).json({ error: 'A user cannot be their own manager.' });
    if (req.body.departmentIds !== undefined) {
      const departments = await db.load('departments');
      user.departmentIds = Array.isArray(req.body.departmentIds) ? req.body.departmentIds.filter(id => departments.some(d => d.id === id)) : [];
      user.division = user.departmentIds.map(id => (departments.find(d => d.id === id) || {}).name).filter(Boolean).join(', ');
    }
    ['name','email','role','locationId','managerId','phone','status','emailNotifications'].forEach(k => { if (req.body[k] !== undefined) user[k] = req.body[k] === '' && ['managerId','locationId'].includes(k) ? null : req.body[k]; });
    if (req.body.dashboardAccess !== undefined) user.dashboardAccess = ['granted','denied'].includes(req.body.dashboardAccess) ? req.body.dashboardAccess : null;
    if (req.body.scrapAccess !== undefined) user.scrapAccess = ['granted','denied'].includes(req.body.scrapAccess) ? req.body.scrapAccess : null;
    await db.save('users', users);
    res.json({ user: publicUser(user) });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    let users = await db.load('users');
    if (!users.some(u => u.id === req.params.id)) return res.status(404).json({ error: 'User not found.' });
    if (req.params.id === req.session.userId) return res.status(400).json({ error: "You can't remove your own account." });
    users = users.map(u => u.managerId === req.params.id ? { ...u, managerId: null } : u).filter(u => u.id !== req.params.id);
    await db.save('users', users);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
app.get('/api/items', requireAuth, requireDashboardAccess, async (req, res) => {
  try {
    const me = await currentUser(req);
    let items = await db.load('items');
    items = await scopeByLocation(items, me);
    // Disposed items live in the Scraps register (see /api/scraps), not the
    // active inventory list — this is what keeps them out of every view
    // (list/grid/compact) and out of the dashboard's valuation by default.
    items = items.filter(i => i.condition !== 'disposed');
    const { location, category, condition, trackingType, search, tag, sortBy, sortDir } = req.query;
    if (location) items = items.filter(i => i.locationId === location);
    if (category) items = items.filter(i => i.categoryId === category);
    if (condition) items = items.filter(i => i.condition === condition);
    if (trackingType) items = items.filter(i => i.trackingType === trackingType);
    if (tag) items = items.filter(i => (i.tags || []).some(t => t.toLowerCase() === tag.toLowerCase()));
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(i => (i.name || '').toLowerCase().includes(q) || (i.assetTag || '').toLowerCase().includes(q) || (i.serialNumber || '').toLowerCase().includes(q) || (i.tags || []).some(t => t.toLowerCase().includes(q)) || (i.modelNumber || '').toLowerCase().includes(q) || (i.manufacturer || '').toLowerCase().includes(q) || (i.itemCode || '').toLowerCase().includes(q));
    }
    const { from, to } = resolveDateRange(req.query);
    if (from) items = items.filter(i => (i.purchaseDate || '') >= from);
    if (to)   items = items.filter(i => (i.purchaseDate || '') <= to);
    // Sorting
    const dir = sortDir === 'desc' ? -1 : 1;
    if (sortBy === 'cost')      items.sort((a, b) => dir * ((a.purchaseCost || 0) - (b.purchaseCost || 0)));
    else if (sortBy === 'qty')  items.sort((a, b) => dir * ((a.quantity || 0) - (b.quantity || 0)));
    else if (sortBy === 'date') items.sort((a, b) => dir * (a.purchaseDate || '').localeCompare(b.purchaseDate || ''));
    else if (sortBy === 'name') items.sort((a, b) => dir * a.name.localeCompare(b.name));

    // At-a-glance total across the current result set, plus a same-name
    // grouping so e.g. two "Desk" rows split across two locations/classes
    // show up as one combined total instead of looking like separate,
    // unrelated stock — this is what the search summary banner uses.
    const summary = {
      totalCount: items.length,
      totalQuantity: +items.reduce((s, i) => s + (i.quantity || 0), 0).toFixed(3),
      totalValue: +items.reduce((s, i) => s + rowValue(i), 0).toFixed(2)
    };
    const groupMap = new Map();
    items.forEach(i => {
      const key = (i.name || '').trim().toLowerCase();
      if (!groupMap.has(key)) groupMap.set(key, { name: i.name, count: 0, totalQuantity: 0, totalValue: 0, locations: new Set() });
      const g = groupMap.get(key);
      g.count++; g.totalQuantity += (i.quantity || 0); g.totalValue += rowValue(i);
      if (i.locationName) g.locations.add(i.locationName);
    });
    // The per-name breakdown (e.g. "Badminton Racket — 2 records across 2
    // locations") is only meaningful in the context of an active search —
    // without a search term it's just restating the whole inventory list
    // and, worse, would keep showing a stale item's breakdown on screen
    // after the search box is cleared. Only compute/return it when there's
    // actually a query to explain.
    const groups = search ? Array.from(groupMap.values())
      .map(g => ({ name: g.name, count: g.count, totalQuantity: +g.totalQuantity.toFixed(3), totalValue: +g.totalValue.toFixed(2), locations: Array.from(g.locations) }))
      .filter(g => g.count > 1 || g.locations.length > 1)
      .sort((a, b) => b.count - a.count) : [];

    res.json({ items: items.map(withItemMiti), summary, groups });
  } catch (err) { sendError(res, req, err); }
});

app.get('/api/items/:id', requireAuth, async (req, res) => {
  try {
    const items = await db.load('items');
    const item  = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const me      = await currentUser(req);
    const allowed = await visibleLocationIds(me);
    if (allowed && item.locationId && !allowed.has(item.locationId)) return res.status(403).json({ error: "This item belongs to a department you don't have access to." });
    const [condLogs, transfers, repairs] = await Promise.all([db.load('conditionLogs'), db.load('transfers'), db.load('repairRequests')]);
    const history = [
      ...condLogs.filter(c => c.itemId === item.id).map(c => ({ type: 'condition', date: c.loggedAt, miti: toBsShort(c.loggedAt), text: `Condition changed from ${titleCase(c.previousCondition)} to ${titleCase(c.newCondition)}${c.note ? ' — ' + c.note : ''}`, by: c.loggedByName })),
      ...transfers.filter(t => t.itemId === item.id).map(t => ({ type: 'transfer', date: t.createdAt, miti: toBsShort(t.createdAt), text: `Transfer: ${t.fromLocationName || '—'} → ${t.toLocationName} (${titleCase(t.status)})`, by: t.requestedByName })),
      ...repairs.filter(r => r.itemId === item.id).map(r => ({ type: 'repair', date: r.reportedAt, miti: toBsShort(r.reportedAt), text: `Repair: ${r.issue} (${titleCase(r.status)})`, by: r.reportedByName }))
    ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ item: withItemMiti(item), history });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/items', requireAdmin, async (req, res) => {
  try {
    const { name, categoryId, trackingType, assetTag, serialNumber, modelNumber, manufacturer, color, dimensions, weight, locationId, quantity, unit, condition, stockingMethod, reorderQty, purchaseDate, purchaseCost, vendorId, warrantyExpiry, minStockLevel, notes, tags } = req.body;
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    if (stockingMethod && !['fifo','lifo'].includes(stockingMethod)) return res.status(400).json({ error: 'Stock issuing method must be FIFO or LIFO.' });
    const [categories, locations, vendors] = await Promise.all([db.load('categories'), db.load('locations'), db.load('vendors')]);
    const cat    = categories.find(c => c.id === categoryId);
    const loc    = locations.find(l => l.id === locationId);
    const vendor = vendors.find(v => v.id === vendorId);
    const itemCode = await db.nextItemCode();
    const item = {
      id: uid('itm'), itemCode, name, categoryId: categoryId || null, categoryName: cat?.name || null,
      trackingType: trackingType === 'stock' ? 'stock' : 'asset',
      assetTag: assetTag || null, serialNumber: serialNumber || null,
      modelNumber: modelNumber || null, manufacturer: manufacturer || null,
      color: color || null, dimensions: dimensions || null, weight: weight || null,
      locationId: locationId || null, locationName: loc?.name || null,
      quantity: quantity !== undefined && quantity !== '' ? Number(quantity) || 1 : 1,
      unit: unit || (cat ? cat.defaultUnit : 'pcs'), condition: condition || 'good',
      stockingMethod: stockingMethod === 'lifo' ? 'lifo' : 'fifo',
      purchaseDate: purchaseDate || null, purchaseCost: purchaseCost ? Number(purchaseCost) : null,
      vendorId: vendorId || null, vendorName: vendor?.name || null, warrantyExpiry: warrantyExpiry || null,
      minStockLevel: minStockLevel !== undefined && minStockLevel !== '' ? Number(minStockLevel) : null,
      reorderQty: reorderQty !== undefined && reorderQty !== '' ? Number(reorderQty) : null,
      notes: notes || '', tags: Array.isArray(tags) ? tags : [],
      hasPhoto: false, procurementRequestId: null, createdAt: todayStr()
    };
    await db.insertOne('items', item);
    const me = await currentUser(req);
    await logCondition(item.id, item.name, null, item.condition, 'Added to inventory', me);
    res.json({ item });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    if (req.body.stockingMethod && !['fifo','lifo'].includes(req.body.stockingMethod)) return res.status(400).json({ error: 'Stock issuing method must be FIFO or LIFO.' });
    const items = await db.load('items');
    const item  = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const [categories, locations, vendors] = await Promise.all([db.load('categories'), db.load('locations'), db.load('vendors')]);
    const previousCondition = item.condition;
    const allowed = ['name','categoryId','trackingType','assetTag','serialNumber','modelNumber','manufacturer','color','dimensions','weight','locationId','quantity','unit','condition','stockingMethod','purchaseDate','purchaseCost','vendorId','warrantyExpiry','minStockLevel','reorderQty','notes','tags'];
    allowed.forEach(k => { if (req.body[k] !== undefined) item[k] = req.body[k]; });
    if (req.body.quantity !== undefined) item.quantity = req.body.quantity === '' ? 1 : Number(req.body.quantity) || 1;
    if (req.body.purchaseCost !== undefined) item.purchaseCost = req.body.purchaseCost === '' ? null : Number(req.body.purchaseCost);
    if (req.body.reorderQty !== undefined) item.reorderQty = req.body.reorderQty === '' ? null : Number(req.body.reorderQty);
    if (req.body.tags !== undefined) item.tags = Array.isArray(req.body.tags) ? req.body.tags : [];
    if (req.body.categoryId !== undefined) { const c = categories.find(c => c.id === item.categoryId); item.categoryName = c?.name || null; }
    if (req.body.locationId !== undefined) { const l = locations.find(l => l.id === item.locationId); item.locationName = l?.name || null; }
    if (req.body.vendorId !== undefined)   { const v = vendors.find(v => v.id === item.vendorId);     item.vendorName   = v?.name || null; }
    await db.save('items', items);
    const me = await currentUser(req);
    if (req.body.condition !== undefined) {
      await logCondition(item.id, item.name, previousCondition, item.condition, req.body.conditionNote || 'Updated by administrator', me);
      await syncScrapForCondition(item, previousCondition, item.condition, me);
    }
    res.json({ item });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/items/:id/photo', requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) { console.error(`[upload][${req.id||'-'}] multer rejected ${req.method} ${req.path} —`, err.message); return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    try {
      const relPath = files.save('items', req.params.id, req.file.buffer, req.file.mimetype);
      await db.setItemPhotoPath(req.params.id, relPath);
      res.json({ photoUrl: `/api/images/item/${req.params.id}?t=${Date.now()}` });
    } catch (e) { console.error(`[upload][${req.id||'-'}] ${req.method} ${req.path} —`, e.message); res.status(500).json({ error: e.message }); }
  });
});

app.delete('/api/items/:id/photo', requireAdmin, async (req, res) => {
  try {
    const oldPath = await db.getItemPhotoPath(req.params.id);
    await db.clearItemPhotoPath(req.params.id);
    files.remove(oldPath);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/items/:id/log-condition', requireAuth, async (req, res) => {
  try {
    const me = await currentUser(req);
    if (!['admin','manager'].includes(me.role)) return res.status(403).json({ error: 'Only administrators and department heads can log a condition change.' });
    const { newCondition, note } = req.body;
    if (!newCondition) return res.status(400).json({ error: 'A condition is required.' });
    const items = await db.load('items');
    const item  = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const previous = item.condition;
    item.condition  = newCondition;
    await db.save('items', items);
    await logCondition(item.id, item.name, previous, newCondition, note, me);
    await syncScrapForCondition(item, previous, newCondition, me);
    res.json({ item });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    const items = await db.load('items');
    if (!items.some(i => i.id === req.params.id)) return res.status(404).json({ error: 'Item not found.' });
    await db.save('items', items.filter(i => i.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// Quick shortcut alongside Delete on the item detail page: mark the item
// disposed and move it to Scraps in one step, instead of opening the
// condition-log modal separately.
app.post('/api/items/:id/dispose', requireAdmin, async (req, res) => {
  try {
    const me = await currentUser(req);
    const items = await db.load('items');
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    if (item.condition === 'disposed') return res.status(400).json({ error: 'That item has already been disposed.' });
    const previous = item.condition;
    item.condition = 'disposed';
    await db.save('items', items);
    await logCondition(item.id, item.name, previous, 'disposed', req.body.note || 'Disposed via quick action', me);
    await syncScrapForCondition(item, previous, 'disposed', me);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Scraps — disposed goods, valued and tracked separately from live
// inventory. Viewing AND interacting are both gated by requireScrapAccess;
// only an administrator can set/change the depreciated (revalued) amount.
// ---------------------------------------------------------------------------
app.get('/api/scraps', requireAuth, requireScrapAccess, async (req, res) => {
  try {
    const scraps = await db.listScraps();
    const totalOriginalValue = +scraps.reduce((s, r) => s + (r.originalValue || 0), 0).toFixed(2);
    const totalCurrentValue  = +scraps.reduce((s, r) => s + (r.depreciatedValue != null ? r.depreciatedValue : r.originalValue), 0).toFixed(2);
    res.json({ scraps, summary: { count: scraps.length, totalOriginalValue, totalCurrentValue } });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/scraps/:id', requireAuth, requireScrapAccess, async (req, res) => {
  try {
    const me = await currentUser(req);
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can revalue scrapped inventory.' });
    const { depreciatedValue, notes } = req.body;
    if (depreciatedValue !== undefined && depreciatedValue !== '' && depreciatedValue !== null) {
      const n = Number(depreciatedValue);
      if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'Depreciated value must be a non-negative number.' });
    }
    const updated = await db.updateScrapValue(req.params.id, { depreciatedValue, notes, revaluedById: me.id, revaluedByName: me.name });
    if (!updated) return res.status(404).json({ error: 'Scrap record not found.' });
    res.json({ scrap: updated });
  } catch (err) { sendError(res, req, err); }
});

// Bill/receipt for a scrapped item — e.g. a disposal certificate, a scrap
// dealer's payment slip, or the original purchase bill kept for the
// write-off record. Anyone with scrap access can attach or view one;
// removing a whole scrap record (destructive) stays admin-only below.
app.post('/api/scraps/:id/bill', requireAuth, requireScrapAccess, (req, res) => {
  billUpload(req, res, async (err) => {
    if (err) { console.error(`[upload][${req.id||'-'}] multer rejected ${req.method} ${req.path} —`, err.message); return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      const scrap = await db.getScrapById(req.params.id);
      if (!scrap) return res.status(404).json({ error: 'Scrap record not found.' });
      const relPath = files.save('scrapBills', req.params.id, req.file.buffer, req.file.mimetype);
      await db.setScrapBillPath(req.params.id, relPath, req.file.originalname);
      res.json({ ok: true, billUrl: `/api/images/scrap/${req.params.id}/bill?t=${Date.now()}` });
    } catch (e) { console.error(`[upload][${req.id||'-'}] ${req.method} ${req.path} —`, e.message); res.status(500).json({ error: e.message }); }
  });
});

app.get('/api/images/scrap/:id/bill', requireAuth, requireScrapAccess, async (req, res) => {
  try {
    const row = await db.getScrapBillPath(req.params.id);
    if (!row || !row.bill_path) return res.status(404).end();
    res.sendFile(files.absolutePath(row.bill_path), {
      maxAge: '10m',
      headers: { 'Content-Disposition': `inline; filename="${row.bill_filename || 'bill'}"` }
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

// Removes just the attached bill, keeping the scrap record itself intact —
// the counterpart to POST /api/scraps/:id/bill, mirroring the same
// upload/view/remove pattern used for procurement bills.
app.delete('/api/scraps/:id/bill', requireAuth, requireScrapAccess, async (req, res) => {
  try {
    const scrap = await db.getScrapById(req.params.id);
    if (!scrap) return res.status(404).json({ error: 'Scrap record not found.' });
    const row = await db.getScrapBillPath(req.params.id);
    await db.clearScrapBillPath(req.params.id);
    files.remove(row?.bill_path);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// Removing a scrap record restores the underlying item to active inventory
// (reverting its condition to whatever it was right before disposal) rather
// than just deleting the register entry — otherwise the item would vanish
// from both the Scraps list AND the main inventory list (which always
// excludes disposed items), becoming permanently invisible. Admin-only
// since it affects both the scrap valuation total and live inventory.
app.delete('/api/scraps/:id', requireAuth, requireScrapAccess, async (req, res) => {
  try {
    const me = await currentUser(req);
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can remove a scrap record.' });
    const scrap = await db.getScrapById(req.params.id);
    if (!scrap) return res.status(404).json({ error: 'Scrap record not found.' });
    const billRow = await db.getScrapBillPath(req.params.id);
    if (billRow?.bill_path) files.remove(billRow.bill_path);
    await db.deleteScrapById(req.params.id);

    const items = await db.load('items');
    const item = items.find(i => i.id === scrap.itemId);
    if (item && item.condition === 'disposed') {
      const restoredCondition = scrap.conditionAtDisposal || 'good';
      item.condition = restoredCondition;
      await db.save('items', items);
      await logCondition(item.id, item.name, 'disposed', restoredCondition, 'Removed from scrap list — restored to active inventory.', me);
    }
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// My location (custodian limited view)
// ---------------------------------------------------------------------------
app.get('/api/my-location', requireAuth, async (req, res) => {
  try {
    const me = await currentUser(req);
    const locs = await db.load('locations');
    const myLocations = locs.filter(l => l.custodianId === me.id);
    const locIds = new Set(myLocations.map(l => l.id));
    const allItems   = await db.load('items');
    const allRepairs = await db.load('repairRequests');
    const items   = allItems.filter(i => locIds.has(i.locationId)).map(withItemMiti);
    const repairs = allRepairs.filter(r => locIds.has(r.locationId)).map(withRepairMiti);
    res.json({ locations: myLocations, items, repairs });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
app.get('/api/transfers', requireAuth, requireDashboardAccess, async (req, res) => {
  try {
    const me = await currentUser(req);
    let transfers = await db.load('transfers');
    const allowed = await visibleLocationIds(me);
    if (allowed) transfers = transfers.filter(t => (!t.fromLocationId || allowed.has(t.fromLocationId)) || (!t.toLocationId || allowed.has(t.toLocationId)));
    if (req.query.status) transfers = transfers.filter(t => t.status === req.query.status);
    const { from, to } = resolveDateRange(req.query);
    if (from) transfers = transfers.filter(t => (t.createdAt || '') >= from);
    if (to)   transfers = transfers.filter(t => (t.createdAt || '') <= to);
    res.json({ transfers: transfers.slice(0, 300).map(withTransferMiti) });
  } catch (err) { sendError(res, req, err); }
});

app.get('/api/transfers/mine', requireAuth, async (req, res) => {
  try {
    const transfers = await db.load('transfers');
    res.json({ transfers: transfers.filter(t => t.requestedById === req.session.userId).map(withTransferMiti) });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/transfers', requireAuth, async (req, res) => {
  try {
    const { itemId, toLocationId, quantity, reason } = req.body;
    if (!itemId || !toLocationId) return res.status(400).json({ error: 'Item and destination are required.' });
    if (!reason?.trim()) return res.status(400).json({ error: 'A reason is required.' });
    const [items, locations] = await Promise.all([db.load('items'), db.load('locations')]);
    const item       = items.find(i => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const me      = await currentUser(req);
    const allowed = await visibleLocationIds(me);
    if (allowed && item.locationId && !allowed.has(item.locationId)) return res.status(403).json({ error: "You can only request transfers for items in your department's locations." });
    if (item.locationId === toLocationId) return res.status(400).json({ error: 'That item is already at this location.' });
    const toLocation = locations.find(l => l.id === toLocationId);
    if (!toLocation) return res.status(404).json({ error: 'Destination location not found.' });
    let qty = null;
    if (item.trackingType === 'stock') {
      qty = Number(quantity);
      if (!qty || qty <= 0) return res.status(400).json({ error: 'Enter a quantity to transfer.' });
      if (qty > item.quantity) return res.status(400).json({ error: `Only ${item.quantity} ${item.unit} available.` });
    }
    const transfers = await db.load('transfers');
    const transfer  = { id: uid('trf'), itemId: item.id, itemName: item.name, fromLocationId: item.locationId, fromLocationName: item.locationName, toLocationId, toLocationName: toLocation.name, quantity: qty, requestedById: me.id, requestedByName: me.name, reason: reason.trim(), ...initialDecisionState(me), createdAt: nowStamp(), completedAt: null };
    transfers.unshift(transfer);
    await db.save('transfers', transfers);
    notifyAsync(() => notifyAdminsNewRequest({ kind: 'transfer', title: transfer.itemName, rows: [['Item', transfer.itemName], ['From', transfer.fromLocationName || '—'], ['To', transfer.toLocationName], ['Requested by', transfer.requestedByName], ['Reason', transfer.reason]] }));
    res.json({ transfer });
  } catch (err) { sendError(res, req, err); }
});

async function applyTransfer(transfer) {
  const items = await db.load('items');
  const source = items.find(i => i.id === transfer.itemId);
  if (!source) return;
  if (source.trackingType === 'asset') {
    source.locationId   = transfer.toLocationId;
    source.locationName = transfer.toLocationName;
    await db.save('items', items);
  } else {
    const qty = transfer.quantity || 0;
    source.quantity = +(source.quantity - qty).toFixed(3);
    let dest = items.find(i => i.name === source.name && i.categoryId === source.categoryId && i.trackingType === 'stock' && i.locationId === transfer.toLocationId);
    let destIsNew = false;
    if (dest) {
      dest.quantity = +(dest.quantity + qty).toFixed(3);
    } else {
      // A genuine split: same item name, but now a distinct inventory
      // record at a different location. Gets its own item code (never
      // reuses the source's) so the two rows can always be told apart at a
      // glance, with a note tracing it back to where it came from.
      const destCode = await db.nextItemCode();
      const splitNote = `Split from ${source.name} (${source.itemCode || source.id}) via transfer on ${todayStr()}.`;
      dest = { ...source, id: uid('itm'), itemCode: destCode, locationId: transfer.toLocationId, locationName: transfer.toLocationName, quantity: qty, assetTag: null, serialNumber: null, hasPhoto: false, createdAt: todayStr(), notes: [source.notes, splitNote].filter(Boolean).join(' | ') };
      items.push(dest);
      destIsNew = true;
    }
    await db.save('items', items);
    // Issue stock from the source item's batches using its configured
    // FIFO/LIFO method, then land that same quantity as a fresh batch on
    // the destination item — this is what keeps the batch ledger (and the
    // Stock Batches tab / average cost) meaningfully connected to actual
    // stock movement rather than just sitting there unused.
    await db.withTx(async conn => {
      const { deducted, avgCost } = await db.deductFromBatches(conn, source.id, qty, source.stockingMethod || 'fifo');
      if (deducted > 0) {
        await db.addStockBatch(conn, {
          itemId: dest.id, itemName: dest.name, qtyReceived: deducted,
          unitCost: avgCost || null, receivedDate: todayStr(),
          procurementId: null, vendorId: source.vendorId, vendorName: source.vendorName,
          receivedById: transfer.requestedById, receivedByName: transfer.requestedByName
        });
      }
    });
  }
  transfer.completedAt = nowStamp();
}

app.post('/api/admin/transfers/:id/decide', requireAdmin, async (req, res) => {
  try {
    const { decision } = req.body;
    if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
    const transfers = await db.load('transfers');
    const t = transfers.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Transfer not found.' });
    const me = await currentUser(req);
    t.adminDecision = decision; t.adminReviewedBy = me.name; t.adminReviewedAt = nowStamp();
    t.status = computeApprovalStatus(t.managerDecision, t.adminDecision);
    if (t.status === 'approved') await applyTransfer(t);
    await db.save('transfers', transfers);
    const users = await db.load('users');
    const requester = users.find(u => u.id === t.requestedById);
    if (requester && mailer.wantsMail(requester)) notifyAsync(() => mailer.sendTransferDecision({ to: requester.email, transfer: t, decision, reviewedBy: me.name }));
    res.json({ transfer: t });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------
app.get('/api/procurement', requireAuth, requireDashboardAccess, async (req, res) => {
  try {
    let list = await db.load('procurementRequests');
    if (req.query.status) list = list.filter(p => p.status === req.query.status);
    const { from, to } = resolveDateRange(req.query);
    if (from) list = list.filter(p => (p.createdAt || '') >= from);
    if (to)   list = list.filter(p => (p.createdAt || '') <= to);
    res.json({ requests: list.slice(0, 300).map(withProcurementMiti) });
  } catch (err) { sendError(res, req, err); }
});

app.get('/api/procurement/mine', requireAuth, async (req, res) => {
  try {
    const list = await db.load('procurementRequests');
    res.json({ requests: list.filter(p => p.requestedById === req.session.userId).map(withProcurementMiti) });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/procurement', requireAuth, async (req, res) => {
  try {
    const { itemName, categoryId, quantity, unit, estimatedCost, vendorId, justification, isRestock, existingItemId, stockingPlanId } = req.body;
    if (!itemName?.trim()) return res.status(400).json({ error: 'An item name is required.' });
    if (!justification?.trim()) return res.status(400).json({ error: 'A justification is required.' });
    const [categories, vendors] = await Promise.all([db.load('categories'), db.load('vendors')]);
    const cat    = categories.find(c => c.id === categoryId);
    const vendor = vendors.find(v => v.id === vendorId);
    const me = await currentUser(req);
    const reqItem = {
      id: uid('pr'), requestedById: me.id, requestedByName: me.name, division: me.division || '',
      itemName: itemName.trim(), categoryId: categoryId || null, categoryName: cat?.name || null,
      quantity: quantity ? Number(quantity) : 1, unit: unit || (cat ? cat.defaultUnit : 'pcs'),
      estimatedCost: estimatedCost ? Number(estimatedCost) : null,
      vendorId: vendorId || null, vendorName: vendor?.name || null,
      justification: justification.trim(),
      isRestock: !!isRestock, existingItemId: existingItemId || null,
      hasBill: false, billFilename: null, stockingPlanId: stockingPlanId || null,
      ...initialDecisionState(me),
      receivedItemId: null, createdAt: nowStamp(), orderedAt: null, receivedAt: null
    };
    const list = await db.load('procurementRequests');
    list.unshift(reqItem);
    await db.save('procurementRequests', list);
    notifyAsync(() => notifyAdminsNewRequest({ kind: 'procurement', title: reqItem.itemName, rows: [['Item', reqItem.itemName], ['Quantity', `${reqItem.quantity} ${reqItem.unit || ''}`.trim()], ['Est. cost', reqItem.estimatedCost != null ? `Rs. ${reqItem.estimatedCost}` : '—'], ['Requested by', reqItem.requestedByName], ['Justification', reqItem.justification]] }));
    res.json({ request: reqItem });
  } catch (err) { sendError(res, req, err); }
});

// Batch procurement (cart submission)
app.post('/api/procurement/batch', requireAuth, async (req, res) => {
  try {
    const { items: cartItems, justification } = req.body;
    if (!Array.isArray(cartItems) || !cartItems.length) return res.status(400).json({ error: 'Cart is empty.' });
    if (!justification?.trim()) return res.status(400).json({ error: 'A justification is required.' });
    const [categories, vendors] = await Promise.all([db.load('categories'), db.load('vendors')]);
    const me = await currentUser(req);
    const list = await db.load('procurementRequests');
    const created = [];
    for (const ci of cartItems) {
      if (!ci.itemName?.trim()) continue;
      const cat    = categories.find(c => c.id === ci.categoryId);
      const vendor = vendors.find(v => v.id === ci.vendorId);
      const reqItem = {
        id: uid('pr'), requestedById: me.id, requestedByName: me.name, division: me.division || '',
        itemName: ci.itemName.trim(), categoryId: ci.categoryId || null, categoryName: cat?.name || null,
        quantity: Number(ci.quantity) || 1, unit: ci.unit || (cat?.defaultUnit || 'pcs'),
        estimatedCost: ci.estimatedCost ? Number(ci.estimatedCost) : null,
        vendorId: ci.vendorId || null, vendorName: vendor?.name || null,
        justification: justification.trim(),
        isRestock: !!ci.isRestock, existingItemId: ci.existingItemId || null,
        hasBill: false, billFilename: null, stockingPlanId: ci.stockingPlanId || null,
        ...initialDecisionState(me),
        receivedItemId: null, createdAt: nowStamp(), orderedAt: null, receivedAt: null
      };
      list.unshift(reqItem);
      created.push(reqItem);
    }
    await db.save('procurementRequests', list);
    if (created.length) {
      notifyAsync(() => notifyAdminsNewRequest({ kind: 'procurement', title: `${created.length} item(s) batch request`, rows: [['Items', created.map(r => r.itemName).join(', ')], ['Requested by', me.name], ['Justification', justification.trim()]] }));
    }
    res.json({ requests: created });
  } catch (err) { sendError(res, req, err); }
});

// Upload bill/receipt for a procurement request
app.post('/api/procurement/:id/bill', requireAuth, (req, res) => {
  billUpload(req, res, async (err) => {
    if (err) { console.error(`[upload][${req.id||'-'}] multer rejected ${req.method} ${req.path} —`, err.message); return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      const list = await db.load('procurementRequests');
      const p = list.find(x => x.id === req.params.id);
      if (!p) return res.status(404).json({ error: 'Procurement request not found.' });
      const me = await currentUser(req);
      if (me.role !== 'admin' && p.requestedById !== me.id) return res.status(403).json({ error: 'Not authorized.' });
      const relPath = files.save('bills', req.params.id, req.file.buffer, req.file.mimetype);
      await db.setProcurementBillPath(req.params.id, relPath, req.file.originalname);
      // A bill often arrives AFTER the goods have already been received
      // into inventory (invoice comes later than the delivery) — when that
      // happens, the purchase-log record was created with no bill at the
      // time, so it needs its own copy of this one backfilled now too,
      // otherwise "View bill" on that log stays permanently empty even
      // though a bill clearly exists.
      if (p.receivedItemId) {
        const logs = await db.getPurchaseLogsByProcurementId(p.id);
        for (const log of logs) {
          const copiedPath = files.copy(relPath, 'purchaseLogs', log.id);
          if (copiedPath) await db.setPurchaseLogBillPath(log.id, copiedPath, req.file.originalname);
        }
      }
      res.json({ ok: true, billUrl: `/api/images/procurement/${req.params.id}/bill?t=${Date.now()}` });
    } catch (e) { console.error(`[upload][${req.id||'-'}] ${req.method} ${req.path} —`, e.message); res.status(500).json({ error: e.message }); }
  });
});

app.delete('/api/procurement/:id/bill', requireAuth, async (req, res) => {
  try {
    const list = await db.load('procurementRequests');
    const p = list.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Procurement request not found.' });
    const me = await currentUser(req);
    if (me.role !== 'admin' && p.requestedById !== me.id) return res.status(403).json({ error: 'Not authorized.' });
    const row = await db.getProcurementBillPath(req.params.id);
    await db.clearProcurementBillPath(req.params.id);
    files.remove(row?.bill_path);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/admin/procurement/:id/decide', requireAdmin, async (req, res) => {
  try {
    const { decision } = req.body;
    if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
    const list = await db.load('procurementRequests');
    const p = list.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Procurement request not found.' });
    const me = await currentUser(req);
    p.adminDecision = decision; p.adminReviewedBy = me.name; p.adminReviewedAt = nowStamp();
    p.status = computeApprovalStatus(p.managerDecision, p.adminDecision);
    if (p.status === 'approved') p.orderedAt = nowStamp();
    await db.save('procurementRequests', list);
    // Count this against its linked stocking plan's budget the moment it's
    // fully approved — this is what makes an annual/weekly plan's spend
    // total actually reflect real activity instead of always reading zero.
    if (p.status === 'approved' && p.stockingPlanId && p.estimatedCost) {
      await db.withTx(async conn => { await db.addSpentToplan(conn, p.stockingPlanId, p.estimatedCost); });
    }
    const users = await db.load('users');
    const requester = users.find(u => u.id === p.requestedById);
    if (requester && mailer.wantsMail(requester)) notifyAsync(() => mailer.sendProcurementDecision({ to: requester.email, procurement: p, decision, reviewedBy: me.name }));
    res.json({ request: p });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/admin/procurement/:id/receive', requireAdmin, async (req, res) => {
  try {
    const list = await db.load('procurementRequests');
    const p = list.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Procurement request not found.' });
    if (p.status !== 'approved') return res.status(400).json({ error: 'This request has not been approved yet.' });
    if (p.receivedItemId) return res.status(400).json({ error: 'This request has already been received into inventory.' });
    const { locationId, assetTag, serialNumber, condition, modelNumber, manufacturer, color, dimensions, weight, minStockLevel, reorderQty, warrantyExpiry, tags, notes } = req.body;
    const locations = await db.load('locations');
    const loc = locations.find(l => l.id === locationId);
    if (!loc) return res.status(400).json({ error: 'Choose which location received the item(s).' });
    const trackingType = (p.quantity > 1) ? 'stock' : 'asset';
    const items = await db.load('items');
    // If restock, increase qty of existing item if it exists at this location
    if (p.isRestock && p.existingItemId) {
      const existing = items.find(i => i.id === p.existingItemId);
      if (existing) {
        const addedQty  = p.quantity || 1;
        const unitCost  = p.estimatedCost && p.quantity ? +(p.estimatedCost / p.quantity).toFixed(2) : null;
        const prevQty   = existing.quantity || 0;
        // Blend into a quantity-weighted average unit cost rather than
        // overwriting it outright, so a restock at a different price
        // doesn't silently erase what the existing stock was actually
        // bought for.
        if (unitCost != null) {
          const combinedQty = prevQty + addedQty;
          existing.purchaseCost = combinedQty ? +(((existing.purchaseCost || 0) * prevQty + unitCost * addedQty) / combinedQty).toFixed(2) : unitCost;
        }
        existing.quantity = prevQty + addedQty;
        existing.purchaseDate = todayStr();
        await db.save('items', items);
        // Add stock batch + purchase log for restock
        const me2 = await currentUser(req);
        const prBillRow2 = await db.getProcurementBillPath(p.id);
        const plId2 = uid('pl');
        const copiedBillPath2 = files.copy(prBillRow2?.bill_path, 'purchaseLogs', plId2);
        await db.withTx(async conn => {
          await db.addStockBatch(conn, {
            itemId: existing.id, itemName: existing.name, qtyReceived: p.quantity || 1,
            unitCost,
            receivedDate: todayStr(), procurementId: p.id,
            vendorId: p.vendorId, vendorName: p.vendorName,
            receivedById: me2.id, receivedByName: me2.name
          });
          await db.createPurchaseLog(conn, {
            id: plId2, itemId: existing.id, itemName: existing.name, procurementId: p.id,
            quantity: p.quantity, unit: p.unit, unitCost,
            totalCost: p.estimatedCost, billPath: copiedBillPath2, billFilename: prBillRow2?.bill_filename || null,
            receivedAt: nowStamp(), receivedById: me2.id, receivedByName: me2.name,
            vendorId: p.vendorId, vendorName: p.vendorName,
            locationId: existing.locationId, locationName: existing.locationName,
            notes: `Restock via procurement request ${p.id}`
          });
        });
        p.receivedItemId = existing.id; p.receivedAt = nowStamp();
        await db.save('procurementRequests', list);
        return res.json({ request: p, item: existing });
      }
    }
    const me = await currentUser(req);
    const settings = await db.getSettings();
    const itemCode = await db.nextItemCode();
    // p.estimatedCost is the TOTAL estimated cost for the whole request
    // (quantity included) — same convention used just below for the stock
    // batch / purchase log unit cost. The item's own purchaseCost field is
    // a PER-UNIT figure (rowValue() elsewhere multiplies it by quantity),
    // so it has to be divided here too, or received stock ends up valued
    // at cost × quantity twice over.
    const unitCost = p.estimatedCost && p.quantity ? +(p.estimatedCost / p.quantity).toFixed(2) : (p.estimatedCost || null);
    const item = { id: uid('itm'), itemCode, name: p.itemName, categoryId: p.categoryId, categoryName: p.categoryName, trackingType, assetTag: assetTag || null, serialNumber: serialNumber || null, modelNumber: modelNumber?.trim() || null, manufacturer: manufacturer?.trim() || null, color: color?.trim() || null, dimensions: dimensions?.trim() || null, weight: weight?.trim() || null, locationId: loc.id, locationName: loc.name, quantity: trackingType === 'stock' ? (p.quantity || 1) : 1, unit: p.unit || 'pcs', condition: condition || 'new', stockingMethod: settings.stockingMethod || 'fifo', purchaseDate: todayStr(), purchaseCost: unitCost, vendorId: p.vendorId, vendorName: p.vendorName, warrantyExpiry: warrantyExpiry || null, minStockLevel: minStockLevel === '' || minStockLevel == null ? null : Number(minStockLevel), reorderQty: reorderQty === '' || reorderQty == null ? null : Number(reorderQty), notes: [`Received from procurement request ${p.id}.`, notes?.trim()].filter(Boolean).join(' '), tags: Array.isArray(tags) ? tags.filter(Boolean) : [], hasPhoto: false, procurementRequestId: p.id, createdAt: todayStr() };
    items.push(item);
    await db.save('items', items);
    await logCondition(item.id, item.name, null, item.condition, 'Received from procurement', me);

    // Copy bill from the procurement request into an immutable purchase log
    const prBillRow = await db.getProcurementBillPath(p.id);
    const plId   = uid('pl');
    const copiedBillPath = files.copy(prBillRow?.bill_path, 'purchaseLogs', plId);
    await db.withTx(async conn => {
      // Create stock batch entry for FIFO/LIFO tracking
      if (trackingType === 'stock') {
        await db.addStockBatch(conn, {
          itemId: item.id, itemName: item.name, qtyReceived: p.quantity || 1,
          unitCost,
          receivedDate: todayStr(), procurementId: p.id,
          vendorId: p.vendorId, vendorName: p.vendorName,
          receivedById: me.id, receivedByName: me.name
        });
      }
      // Create immutable purchase log with its own copy of the bill file
      await db.createPurchaseLog(conn, {
        id: plId, itemId: item.id, itemName: item.name, procurementId: p.id,
        quantity: p.quantity, unit: p.unit, unitCost,
        totalCost: p.estimatedCost, billPath: copiedBillPath, billFilename: prBillRow?.bill_filename || null,
        receivedAt: nowStamp(), receivedById: me.id, receivedByName: me.name,
        vendorId: p.vendorId, vendorName: p.vendorName,
        locationId: loc.id, locationName: loc.name,
        notes: `Received via procurement request ${p.id}`
      });
    });

    p.receivedItemId = item.id; p.receivedAt = nowStamp();
    await db.save('procurementRequests', list);
    res.json({ request: p, item });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------
app.get('/api/repairs', requireAuth, requireDashboardAccess, async (req, res) => {
  try {
    const me = await currentUser(req);
    let list = await scopeByLocation(await db.load('repairRequests'), me);
    if (req.query.status) list = list.filter(r => r.status === req.query.status);
    const { from, to } = resolveDateRange(req.query);
    if (from) list = list.filter(r => (r.reportedAt || '') >= from);
    if (to)   list = list.filter(r => (r.reportedAt || '') <= to);
    res.json({ repairs: list.slice(0, 300).map(withRepairMiti) });
  } catch (err) { sendError(res, req, err); }
});

app.get('/api/repairs/mine', requireAuth, async (req, res) => {
  try {
    const me = await currentUser(req);
    const list = await db.load('repairRequests');
    res.json({ repairs: list.filter(r => r.reportedById === me.id).slice(0, 100).map(withRepairMiti) });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/repairs', requireAuth, async (req, res) => {
  try {
    const { itemId, issue, priority } = req.body;
    if (!itemId) return res.status(400).json({ error: 'Choose the item that needs attention.' });
    if (!issue?.trim()) return res.status(400).json({ error: 'Describe the issue.' });
    const items = await db.load('items');
    const item  = items.find(i => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const me   = await currentUser(req);
    const list = await db.load('repairRequests');
    const repair = { id: uid('rep'), itemId: item.id, itemName: item.name, locationId: item.locationId, locationName: item.locationName, reportedById: me.id, reportedByName: me.name, issue: issue.trim(), priority: ['low','medium','high','urgent'].includes(priority) ? priority : 'medium', status: 'reported', assignedVendorId: null, assignedVendorName: null, estimatedCost: null, actualCost: null, resolutionNotes: null, reportedAt: nowStamp(), resolvedAt: null };
    list.unshift(repair);
    await db.save('repairRequests', list);
    notifyAsync(() => notifyAdminsNewRequest({ kind: 'repair', title: repair.itemName, rows: [['Item', repair.itemName], ['Location', repair.locationName || '—'], ['Priority', titleCase(repair.priority)], ['Reported by', repair.reportedByName], ['Issue', repair.issue]] }));
    const previous = item.condition;
    if (['good','new'].includes(item.condition)) {
      item.condition = 'under_repair';
      await db.save('items', items);
      await logCondition(item.id, item.name, previous, item.condition, 'Repair reported: ' + issue.trim(), me);
    }
    res.json({ repair });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/repairs/:id', requireAuth, async (req, res) => {
  try {
    const me   = await currentUser(req);
    const list = await db.load('repairRequests');
    const repair = list.find(r => r.id === req.params.id);
    if (!repair) return res.status(404).json({ error: 'Repair request not found.' });
    const locs = await db.load('locations');
    const loc  = repair.locationId ? locs.find(l => l.id === repair.locationId) : null;
    const isCustodian  = loc && loc.custodianId === me.id;
    const isDeptManager = me.role === 'manager' && loc && loc.departmentId && (me.departmentIds || []).includes(loc.departmentId);
    if (me.role !== 'admin' && !isCustodian && !isDeptManager) return res.status(403).json({ error: "You're not the custodian or department head for this item's location." });
    const vendors = await db.load('vendors');
    const { status, assignedVendorId, estimatedCost, actualCost, resolutionNotes } = req.body;
    if (status) repair.status = status;
    if (assignedVendorId !== undefined) { const v = vendors.find(v => v.id === assignedVendorId); repair.assignedVendorId = assignedVendorId || null; repair.assignedVendorName = v?.name || null; }
    if (estimatedCost !== undefined) repair.estimatedCost = estimatedCost === '' ? null : Number(estimatedCost);
    if (actualCost    !== undefined) repair.actualCost    = actualCost    === '' ? null : Number(actualCost);
    if (resolutionNotes !== undefined) repair.resolutionNotes = resolutionNotes;
    if (['repaired','not_repairable','cancelled'].includes(repair.status) && !repair.resolvedAt) repair.resolvedAt = nowStamp();
    await db.save('repairRequests', list);
    if (status !== undefined) {
      const users = await db.load('users');
      const reporter = users.find(u => u.id === repair.reportedById);
      if (reporter) await notifyRequester(reporter, { subject: `Repair update — ${repair.itemName}`, title: `Repair status updated: ${titleCase(repair.status)}`, rows: [['Item', repair.itemName], ['Status', titleCase(repair.status)], ['Vendor', repair.assignedVendorName || '—'], ['Notes', repair.resolutionNotes || '—']] });
    }
    const items = await db.load('items');
    const item  = items.find(i => i.id === repair.itemId);
    if (item) {
      const previous = item.condition;
      if (repair.status === 'repaired' && item.condition === 'under_repair') { item.condition = 'good'; await db.save('items', items); await logCondition(item.id, item.name, previous, item.condition, 'Repaired and returned to service', me); }
      else if (repair.status === 'not_repairable') { item.condition = 'damaged'; await db.save('items', items); await logCondition(item.id, item.name, previous, item.condition, 'Marked not repairable', me); }
    }
    res.json({ repair });
  } catch (err) { sendError(res, req, err); }
});

// Bill/receipt for a repair — e.g. a vendor's invoice for parts or labor.
// Mirrors the same upload/view/remove pattern used for procurement and
// scrap bills, via the same shared client-side viewer.
app.post('/api/repairs/:id/bill', requireAuth, (req, res) => {
  billUpload(req, res, async (err) => {
    if (err) { console.error(`[upload][${req.id||'-'}] multer rejected ${req.method} ${req.path} —`, err.message); return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      const list = await db.load('repairRequests');
      const repair = list.find(r => r.id === req.params.id);
      if (!repair) return res.status(404).json({ error: 'Repair request not found.' });
      const relPath = files.save('bills', req.params.id, req.file.buffer, req.file.mimetype);
      await db.setRepairBillPath(req.params.id, relPath, req.file.originalname);
      res.json({ ok: true, billUrl: `/api/images/repair/${req.params.id}/bill?t=${Date.now()}` });
    } catch (e) { console.error(`[upload][${req.id||'-'}] ${req.method} ${req.path} —`, e.message); res.status(500).json({ error: e.message }); }
  });
});

app.get('/api/images/repair/:id/bill', requireAuth, async (req, res) => {
  try {
    const row = await db.getRepairBillPath(req.params.id);
    if (!row || !row.bill_path) return res.status(404).end();
    res.sendFile(files.absolutePath(row.bill_path), {
      maxAge: '10m',
      headers: { 'Content-Disposition': `inline; filename="${row.bill_filename || 'bill'}"` }
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

app.delete('/api/repairs/:id/bill', requireAuth, async (req, res) => {
  try {
    const list = await db.load('repairRequests');
    const repair = list.find(r => r.id === req.params.id);
    if (!repair) return res.status(404).json({ error: 'Repair request not found.' });
    const row = await db.getRepairBillPath(req.params.id);
    await db.clearRepairBillPath(req.params.id);
    files.remove(row?.bill_path);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// Quick shortcut: dispose the item behind a repair report directly to
// Scraps, without having to leave Repairs and go find the item in
// Inventory first — useful when a repair turns out to be uneconomical and
// the item should just be written off on the spot.
app.post('/api/repairs/:id/dispose', requireAuth, async (req, res) => {
  try {
    const me = await currentUser(req);
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can dispose of an item.' });
    const list = await db.load('repairRequests');
    const repair = list.find(r => r.id === req.params.id);
    if (!repair) return res.status(404).json({ error: 'Repair request not found.' });
    const items = await db.load('items');
    const item = items.find(i => i.id === repair.itemId);
    if (!item) return res.status(404).json({ error: 'The item behind this repair report no longer exists.' });
    if (item.condition === 'disposed') return res.status(400).json({ error: 'That item has already been disposed.' });
    const previous = item.condition;
    item.condition = 'disposed';
    await db.save('items', items);
    await logCondition(item.id, item.name, previous, 'disposed', `Disposed directly from repair report: ${repair.issue}`, me);
    await syncScrapForCondition(item, previous, 'disposed', me);
    repair.status = 'not_repairable';
    if (!repair.resolvedAt) repair.resolvedAt = nowStamp();
    await db.save('repairRequests', list);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Manager approvals
// ---------------------------------------------------------------------------
app.get('/api/manager/approvals', requireAuth, async (req, res) => {
  try {
    const users = await db.load('users');
    const reportIds = users.filter(u => u.managerId === req.session.userId).map(u => u.id);
    const status = req.query.status;
    let transfers   = (await db.load('transfers')).filter(t => reportIds.includes(t.requestedById));
    let procurement = (await db.load('procurementRequests')).filter(p => reportIds.includes(p.requestedById));
    if (status) { transfers = transfers.filter(t => t.status === status); procurement = procurement.filter(p => p.status === status); }
    res.json({ transfers: transfers.slice(0, 200), procurement: procurement.slice(0, 200) });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/manager/approvals/:type/:id/decide', requireAuth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const { decision } = req.body;
    if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
    if (!['transfer','procurement'].includes(type)) return res.status(400).json({ error: 'Invalid request type.' });
    const tableName = type === 'transfer' ? 'transfers' : 'procurementRequests';
    const list = await db.load(tableName);
    const item = list.find(x => x.id === id);
    if (!item) return res.status(404).json({ error: 'Request not found.' });
    if (!await isManagerOf(req.session.userId, item.requestedById)) return res.status(403).json({ error: 'You are not the manager for this request.' });
    const me = await currentUser(req);
    item.managerDecision = decision; item.managerReviewedBy = me.name; item.managerReviewedAt = nowStamp();
    item.status = computeApprovalStatus(item.managerDecision, item.adminDecision);
    if (type === 'transfer'    && item.status === 'approved') await applyTransfer(item);
    if (type === 'procurement' && item.status === 'approved') {
      item.orderedAt = nowStamp();
      if (item.stockingPlanId && item.estimatedCost) {
        await db.withTx(async conn => { await db.addSpentToplan(conn, item.stockingPlanId, item.estimatedCost); });
      }
    }
    await db.save(tableName, list);
    const users = await db.load('users');
    const requester = users.find(u => u.id === item.requestedById);
    if (requester) await notifyRequester(requester, { subject: `${titleCase(type)} ${decision === 'approved' ? 'approved' : 'declined'} by your manager`, title: `Your ${type} request was ${decision} by your manager`, rows: [['Item', item.itemName], ['Decision', titleCase(decision)], ['Reviewed by', me.name], ['Overall status', titleCase(item.status)]] });
    res.json({ request: item });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Reports / exports
// ---------------------------------------------------------------------------
app.get('/api/reports/inventory/export', requireAuth, requireDashboardAccess, async (req, res) => {
  try {
    const me = await currentUser(req);
    let items = await scopeByLocation(await db.load('items'), me);
    const { location, category, condition } = req.query;
    // Same rule as the live inventory list: disposed goods are excluded by
    // default (they're tracked separately under Scraps) unless someone
    // explicitly asks for a disposed-only export via the condition filter.
    if (condition !== 'disposed') items = items.filter(i => i.condition !== 'disposed');
    const summary = [];
    if (location) { items = items.filter(i => i.locationId === location); const locs = await db.load('locations'); const l = locs.find(l => l.id === location); summary.push(`Location: ${l?.name || location}`); }
    if (category) { items = items.filter(i => i.categoryId === category); const cats = await db.load('categories'); const c = cats.find(c => c.id === category); summary.push(`Category: ${c?.name || category}`); }
    if (condition) { items = items.filter(i => i.condition === condition); summary.push(`Condition: ${titleCase(condition)}`); }
    const { from, to } = resolveDateRange(req.query);
    if (from) { items = items.filter(i => (i.purchaseDate || '') >= from); summary.push(`From: ${from}`); }
    if (to)   { items = items.filter(i => (i.purchaseDate || '') <= to);   summary.push(`To: ${to}`); }
    const buffer = await buildInventoryExcel({ items: items.map(withItemMiti), generatedBy: me.name, filterSummary: summary.join(', ') || null });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Inventory_${todayStr()}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) { console.error('Inventory export failed:', err); res.status(500).json({ error: 'Could not generate export.' }); }
});

app.get('/api/reports/:kind/export', requireAuth, requireDashboardAccess, async (req, res) => {
  try {
    const { kind } = req.params;
    if (!['transfers','procurement','repairs'].includes(kind)) return res.status(404).json({ error: 'Unknown report.' });
    const me = await currentUser(req);
    let rows = kind === 'transfers' ? await db.load('transfers') : kind === 'procurement' ? await db.load('procurementRequests') : await db.load('repairRequests');
    if (kind === 'transfers') { const allowed = await visibleLocationIds(me); if (allowed) rows = rows.filter(t => (!t.fromLocationId || allowed.has(t.fromLocationId)) || (!t.toLocationId || allowed.has(t.toLocationId))); }
    else if (kind === 'repairs') rows = await scopeByLocation(rows, me);
    const summary = [];
    if (req.query.status) { rows = rows.filter(r => r.status === req.query.status); summary.push(`Status: ${titleCase(req.query.status)}`); }
    const { from, to } = resolveDateRange(req.query);
    const dateKey = kind === 'repairs' ? 'reportedAt' : 'createdAt';
    if (from) { rows = rows.filter(r => (r[dateKey] || '') >= from); summary.push(`From: ${from}`); }
    if (to)   { rows = rows.filter(r => (r[dateKey] || '') <= to);   summary.push(`To: ${to}`); }
    rows = rows.map(kind === 'transfers' ? withTransferMiti : kind === 'procurement' ? withProcurementMiti : withRepairMiti);
    const title = kind === 'transfers' ? 'Transfer Log' : kind === 'procurement' ? 'Procurement Log' : 'Repair & Maintenance Log';
    const buffer = await buildLogExcel({ kind, rows, title, generatedBy: me.name, filterSummary: summary.join(', ') || null });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/\s+/g, '_')}_${todayStr()}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) { console.error('Log export failed:', err); res.status(500).json({ error: 'Could not generate export.' }); }
});

// ---------------------------------------------------------------------------
// Purchase log routes (audit trail per item)
// ---------------------------------------------------------------------------
app.get('/api/items/:id/purchase-history', requireAuth, async (req, res) => {
  try {
    const logs = await db.getPurchaseLogsForItem(req.params.id);
    res.json({ logs });
  } catch (err) { sendError(res, req, err); }
});

app.get('/api/images/purchase-log/:id/bill', requireAuth, async (req, res) => {
  try {
    const row = await db.getPurchaseLogBillPath(req.params.id);
    if (!row || !row.bill_path) return res.status(404).end();
    res.sendFile(files.absolutePath(row.bill_path), {
      maxAge: '1h',
      headers: { 'Content-Disposition': `inline; filename="${row.bill_filename || 'bill'}"` }
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

// ---------------------------------------------------------------------------
// Stock batch routes (FIFO/LIFO detail per item)
// ---------------------------------------------------------------------------
app.get('/api/items/:id/stock-batches', requireAuth, async (req, res) => {
  try {
    const items = await db.load('items');
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const [available, all] = await Promise.all([
      db.getStockBatches(req.params.id, item.stockingMethod || 'fifo'),
      db.getAllStockBatches(req.params.id)
    ]);
    res.json({ batches: available, history: all, method: item.stockingMethod || 'fifo' });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Stocking plans — annual / weekly / petty
// ---------------------------------------------------------------------------
app.get('/api/stocking-plans', requireAuth, async (req, res) => {
  try {
    const { planType, departmentId, status } = req.query;
    const plans = await db.listStockingPlans({ planType, departmentId, status });
    res.json({ plans });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/stocking-plans', requireAuth, async (req, res) => {
  try {
    const me = await currentUser(req);
    if (!['admin','manager'].includes(me.role))
      return res.status(403).json({ error: 'Only administrators and managers can create stocking plans.' });
    const { planType, title, description, budget, departmentId, fiscalYear, weekNumber, weekStartDate } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'A title is required for the stocking plan.' });
    if (!['annual','weekly','petty'].includes(planType))
      return res.status(400).json({ error: 'Plan type must be annual, weekly, or petty.' });
    if (budget !== undefined && budget !== '' && Number(budget) < 0)
      return res.status(400).json({ error: 'Budget cannot be negative.' });
    const depts = await db.load('departments');
    const dept  = departmentId ? depts.find(d => d.id === departmentId) : null;
    const plan = {
      id: db.uid('sp'), planType, title: title.trim(), description: description?.trim() || null,
      budget: budget !== undefined && budget !== '' ? Number(budget) : null,
      departmentId: dept?.id || null, departmentName: dept?.name || null,
      fiscalYear: fiscalYear || null, weekNumber: weekNumber ? Number(weekNumber) : null,
      weekStartDate: weekStartDate || null, status: 'active',
      createdById: me.id, createdByName: me.name
    };
    await db.insertStockingPlan(plan);
    // Notify admins (fire-and-forget — never block the response on email delivery)
    adminEmails().then(async admins => {
      const settings = await db.getSettings();
      const html = await mailer.wrapEmail({
        schoolName: settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo,
        headerTitle: 'New Stocking Plan Created',
        bodyHtml: `<p>${me.name} created a new ${plan.planType} stocking plan.</p>${mailer.infoTable([
          ['Title', plan.title], ['Type', titleCase(plan.planType)],
          ['Budget', plan.budget != null ? `Rs. ${Number(plan.budget).toLocaleString()}` : '—'],
          ['Department', plan.departmentName || 'All departments']
        ])}`
      });
      admins.forEach(email => mailer.sendMail({ to: email, subject: `New stocking plan: ${plan.title}`, html }));
    }).catch(()=>{});
    res.json({ plan });
  } catch (err) { sendError(res, req, err); }
});

app.patch('/api/stocking-plans/:id', requireAuth, async (req, res) => {
  try {
    const me = await currentUser(req);
    if (!['admin','manager'].includes(me.role))
      return res.status(403).json({ error: 'Not authorized.' });
    const plans = await db.listStockingPlans();
    const plan  = plans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: 'Stocking plan not found.' });
    const updates = {};
    if (req.body.title !== undefined)       updates.title       = req.body.title;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.budget !== undefined)      updates.budget      = req.body.budget;
    if (req.body.status !== undefined)      updates.status      = req.body.status;
    if (req.body.approve && me.role === 'admin') {
      updates.approvedById = me.id; updates.approvedByName = me.name;
      updates.status = 'approved';
    }
    await db.updateStockingPlan(req.params.id, updates);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// Plan detail — the plan itself plus every procurement request and petty
// expense linked to it, so the frontend can render a full activity trail
// and an accurate live budget picture in one round trip.
app.get('/api/stocking-plans/:id', requireAuth, async (req, res) => {
  try {
    const plans = await db.listStockingPlans();
    const plan  = plans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: 'Stocking plan not found.' });
    const [allProcurement, allPetty] = await Promise.all([
      db.load('procurementRequests'),
      db.listPettyExpenses({ planId: plan.id })
    ]);
    const procurement = allProcurement.filter(p => p.stockingPlanId === plan.id).map(withProcurementMiti);
    res.json({ plan, procurement, pettyExpenses: allPetty });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/stocking-plans/:id', requireAdmin, async (req, res) => {
  try {
    await db.run(`DELETE FROM stocking_plans WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// Petty expenses
// ---------------------------------------------------------------------------
app.get('/api/petty-expenses', requireAuth, async (req, res) => {
  try {
    const { departmentId, status, planId } = req.query;
    const expenses = await db.listPettyExpenses({ departmentId, status, planId });
    res.json({ expenses });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/petty-expenses', requireAuth, async (req, res) => {
  try {
    const { description, amount, category, departmentId, stockingPlanId, expenseDate, notes } = req.body;
    if (!description?.trim()) return res.status(400).json({ error: 'Description is required.' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A valid positive amount is required.' });
    const settings = await db.getSettings();
    if (Number(amount) > settings.pettyCashLimit)
      return res.status(400).json({ error: `Amount exceeds the petty cash limit of Rs. ${settings.pettyCashLimit.toLocaleString()}. Submit a formal procurement request instead.` });
    const depts = await db.load('departments');
    const dept  = departmentId ? depts.find(d => d.id === departmentId) : null;
    const me    = await currentUser(req);
    const expense = {
      id: db.uid('pe'), description: description.trim(), amount: Number(amount),
      category: category || null, paidById: me.id, paidByName: me.name,
      departmentId: dept?.id || null, departmentName: dept?.name || null,
      stockingPlanId: stockingPlanId || null, status: 'pending',
      expenseDate: expenseDate || new Date().toISOString().slice(0,10), notes: notes || null
    };
    await db.insertPettyExpense(expense);
    // Notify admins
    const admins = await adminEmails();
    const settings2 = await db.getSettings();
    const html = await mailer.wrapEmail({
      schoolName: settings2.schoolName, tagline: settings2.tagline, hasLogo: settings2.hasLogo,
      headerTitle: 'New Petty Cash Expense',
      bodyHtml: `<p>A new petty cash expense has been submitted and requires your approval.</p>
        ${mailer.infoTable([
          ['Description', expense.description], ['Amount', `Rs. ${Number(expense.amount).toLocaleString()}`],
          ['Category', expense.category || '—'], ['Department', dept?.name || '—'],
          ['Submitted by', me.name], ['Date', expense.expenseDate]
        ])}`
    });
    admins.forEach(email => mailer.sendMail({ to: email, subject: `Petty expense: ${expense.description} — Rs. ${amount}`, html }));
    res.json({ expense });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/petty-expenses/:id/receipt', requireAuth, (req, res) => {
  receiptUpload(req, res, async (err) => {
    if (err) { console.error(`[upload][${req.id||'-'}] multer rejected ${req.method} ${req.path} —`, err.message); return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      const expenses = await db.listPettyExpenses();
      const expense  = expenses.find(e => e.id === req.params.id);
      if (!expense) return res.status(404).json({ error: 'Expense not found.' });
      const me = await currentUser(req);
      if (me.role !== 'admin' && expense.paidByName !== me.name)
        return res.status(403).json({ error: 'Not authorized.' });
      const relPath = files.save('pettyReceipts', req.params.id, req.file.buffer, req.file.mimetype);
      await db.setPettyReceiptPath(req.params.id, relPath, req.file.originalname);
      res.json({ ok: true, receiptUrl: `/api/images/petty-expense/${req.params.id}/receipt?t=${Date.now()}` });
    } catch (e) { console.error(`[upload][${req.id||'-'}] ${req.method} ${req.path} —`, e.message); res.status(500).json({ error: e.message }); }
  });
});

app.get('/api/images/petty-expense/:id/receipt', requireAuth, async (req, res) => {
  try {
    const row = await db.getPettyReceiptPath(req.params.id);
    if (!row || !row.receipt_path) return res.status(404).end();
    res.sendFile(files.absolutePath(row.receipt_path), {
      maxAge: '10m',
      headers: { 'Content-Disposition': `inline; filename="${row.receipt_filename || 'receipt'}"` }
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch { res.status(404).end(); }
});

app.delete('/api/petty-expenses/:id/receipt', requireAuth, async (req, res) => {
  try {
    const expenses = await db.listPettyExpenses();
    const expense  = expenses.find(e => e.id === req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });
    const me = await currentUser(req);
    if (me.role !== 'admin' && expense.paidByName !== me.name) return res.status(403).json({ error: 'Not authorized.' });
    const row = await db.getPettyReceiptPath(req.params.id);
    await db.clearPettyReceiptPath(req.params.id);
    files.remove(row?.receipt_path);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

app.post('/api/petty-expenses/:id/approve', requireAdmin, async (req, res) => {
  try {
    const me = await currentUser(req);
    const expenses = await db.listPettyExpenses();
    const expense  = expenses.find(e => e.id === req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });
    if (expense.status !== 'pending') return res.status(400).json({ error: 'This expense has already been reviewed.' });
    const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
    await db.updatePettyExpense(req.params.id, { status: decision, approvedById: me.id, approvedByName: me.name });
    // Deduct from plan budget if approved
    if (decision === 'approved' && expense.stockingPlanId) {
      await db.withTx(async conn => { await db.addSpentToplan(conn, expense.stockingPlanId, expense.amount); });
    }
    // Notify submitter
    const users = await db.load('users');
    const submitter = users.find(u => u.name === expense.paidByName);
    if (submitter && mailer.wantsMail(submitter)) {
      const settings = await db.getSettings();
      const html = await mailer.wrapEmail({
        schoolName: settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo,
        headerTitle: `Petty Expense ${titleCase(decision)}`,
        bodyHtml: `<p>Your petty cash expense has been <strong>${decision}</strong> by ${me.name}.</p>
          ${mailer.infoTable([['Description', expense.description], ['Amount', `Rs. ${expense.amount.toLocaleString()}`], ['Decision', titleCase(decision)], ['Reviewed by', me.name]])}`
      });
      mailer.sendMail({ to: submitter.email, subject: `Petty expense ${decision} — ${expense.description}`, html });
    }
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

app.delete('/api/petty-expenses/:id', requireAdmin, async (req, res) => {
  try {
    await db.run(`DELETE FROM petty_expenses WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { sendError(res, req, err); }
});

// ---------------------------------------------------------------------------
// SPA fallback (must be registered AFTER every /api/* route above)
// ---------------------------------------------------------------------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 for unmatched API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'This endpoint does not exist.' });
});

// ---------------------------------------------------------------------------
// Global error handler — must be the LAST app.use() so it can catch errors
// from every route (including multer file-size / file-type errors, and any
// unexpected exceptions in async handlers that call next(err), which is
// most likely errors NOT already caught by a route's own try/catch →
// sendError()). Shares the same pool-exhaustion detection as sendError()
// so behavior is consistent regardless of which path an error takes.
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large. Please upload a smaller image or PDF.', code: err.code });
  }
  if (POOL_EXHAUSTION_CODES.has(err.code) || POOL_EXHAUSTION_MESSAGES.has(err.message)) {
    return sendError(res, req, err);
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[error][${req.id||'-'}] ${req.method} ${req.path} — ${err.message}`, err.stack?.split('\n')[1]?.trim());
  res.status(status).json({ error: err.message || 'An unexpected server error occurred. Please try again.', code: err.code || undefined });
});

// ---------------------------------------------------------------------------
// Boot — production-ready startup with graceful shutdown and connection
// draining so in-flight requests (e.g. large bill uploads) complete cleanly
// on redeploys, rather than being cut off mid-transfer.
// ---------------------------------------------------------------------------
let httpServer = null;

async function boot() {
  try {
    await db.init();
    console.log('[db] MySQL schema ready.');
    httpServer = app.listen(PORT, () => console.log(`[app] AssetTrack running on port ${PORT} (pid ${process.pid})`));

    // Keep-alive tuning for reverse-proxy setups (cPanel/Passenger, nginx,
    // Apache mod_proxy). If Node closes an idle keep-alive socket before
    // the upstream proxy does, the proxy can try to reuse that socket for
    // the next request and get a connection reset — which surfaces to the
    // browser as a truncated/empty response (the "failed to execute json"
    // / unexpected-408 symptom). The safe direction is for Node's timeout
    // to be LONGER than the proxy's, never shorter. Since shared-hosting
    // proxy timeouts vary a lot between providers, this is tunable via env
    // var — if 408s persist, check your host's Apache/Passenger timeout
    // (ask your hosting provider if unsure) and set this comfortably above
    // it. Defaults to a moderate, broadly-safe 30s/31s.
    httpServer.keepAliveTimeout = Number(process.env.NODE_KEEPALIVE_TIMEOUT_MS || 30000);
    httpServer.headersTimeout   = httpServer.keepAliveTimeout + 1000;

    // Periodic housekeeping
    setInterval(() => db.cleanOtps().catch(err => console.error('[cleanup] OTP cleanup failed:', err.message)), 30 * 60 * 1000);
  } catch (err) {
    console.error('[boot] Fatal error during startup:', err);
    process.exit(1);
  }
}

function shutdown(signal) {
  console.log(`[app] Received ${signal}, shutting down gracefully…`);
  if (!httpServer) return process.exit(0);
  httpServer.close(async () => {
    try { await db.pool.end(); } catch {}
    console.log('[app] Shutdown complete.');
    process.exit(0);
  });
  // Force-exit if shutdown hangs (e.g. a stuck connection)
  setTimeout(() => { console.warn('[app] Forced shutdown after timeout.'); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => { console.error('[app] Unhandled promise rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('[app] Uncaught exception:', err); shutdown('uncaughtException'); });

boot();
