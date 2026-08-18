// db.js — MySQL data layer: stock_batches (FIFO/LIFO), purchase_logs
// (immutable audit trail), stocking_plans, petty_expenses. Images are
// stored as LONGBLOB. Uses a connection pool with transaction helpers.
//
// IMPORTANT — MySQL server timezone: shared hosting (e.g. cPanel) commonly
// has its MySQL server's system timezone set to the datacenter's local
// zone rather than UTC. Any code that compares a stored UTC timestamp
// against MySQL's own NOW() (e.g. OTP expiry) would silently be comparing
// two different clocks — on a server several hours ahead of UTC, a
// freshly issued 10-minute OTP can appear "already expired" the instant
// it's checked.
//
// The fix: never ask MySQL what time it is. Every place that would
// otherwise compare against NOW() instead receives an explicit timestamp
// computed in Node (already correct UTC) as a bound parameter — see
// verifyOtp/cleanOtps/updateStockingPlan below. This is simpler and fully
// race-free compared to the alternative of forcing each pooled
// connection's SESSION time_zone via a 'connection' event hook: that
// approach carries a real deadlock risk, since the hook's own query and
// the pool's very first caller (e.g. during db.init()) can end up racing
// for the same freshly-opened physical connection — especially at small
// pool sizes, a realistic setting on constrained shared hosting.
'use strict';
const mysql = require('mysql2/promise');

// Shared hosting (cPanel etc.) typically caps MySQL connections per user
// far below what a generous default would request — and importantly, the
// Node.js process itself may be spawned as MULTIPLE Passenger worker
// instances under load, each opening its own pool. A high per-process
// connectionLimit multiplied across instances is a common cause of
// intermittent "too many connections" failures, slow/hung requests, and
// what looks like a memory leak (queued queries and pending promises
// piling up while waiting for a saturated pool). Keep this conservative by
// default and let it be tuned via env var for larger deployments.
const CONNECTION_LIMIT = Number(process.env.DB_CONNECTION_LIMIT || 8);
const QUEUE_LIMIT       = Number(process.env.DB_QUEUE_LIMIT || 30);

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               Number(process.env.DB_PORT || 3306),
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASS     || '',
  database:           process.env.DB_NAME     || 'assettrack',
  waitForConnections: true,
  connectionLimit:    CONNECTION_LIMIT,
  queueLimit:         QUEUE_LIMIT,
  charset:            'utf8mb4',
  timezone:           '+00:00',
  multipleStatements: false,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 10000,
  connectTimeout:     10000
});

// Pool error handler — prevents crash on idle connection drop
pool.on('error', (err) => {
  if (err.code !== 'PROTOCOL_CONNECTION_LOST') console.error('[db] Pool error:', err.message);
});

// ---------------------------------------------------------------------------
// Core query helpers
// ---------------------------------------------------------------------------
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}
async function run(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

// Transaction helper — wraps a function in a DB transaction with retry on deadlock
async function withTx(fn, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      lastErr = err;
      // Retry on deadlock or lock wait timeout
      if (attempt < retries && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT')) {
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      conn.release();
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Schema init — idempotent
// ---------------------------------------------------------------------------
async function init() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`SET NAMES utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS departments (
      id            VARCHAR(60)  PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      notes         TEXT,
      annual_budget DECIMAL(14,2) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS users (
      id                  VARCHAR(60)  PRIMARY KEY,
      name                VARCHAR(255) NOT NULL,
      email               VARCHAR(255) UNIQUE NOT NULL,
      password_hash       VARCHAR(255) NOT NULL,
      role                VARCHAR(30)  NOT NULL DEFAULT 'staff',
      division            TEXT,
      department_ids      TEXT,
      location_id         VARCHAR(60),
      manager_id          VARCHAR(60),
      phone               VARCHAR(60),
      avatar_color        VARCHAR(20),
      avatar_path         VARCHAR(255),
      status              VARCHAR(20)  DEFAULT 'active',
      created_at          VARCHAR(40),
      dashboard_access    VARCHAR(20),
      email_notifications TINYINT      DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS locations (
      id              VARCHAR(60)  PRIMARY KEY,
      name            VARCHAR(255) NOT NULL,
      type            VARCHAR(60),
      building        VARCHAR(255),
      floor           VARCHAR(60),
      department_id   VARCHAR(60),
      department_name VARCHAR(255),
      custodian_id    VARCHAR(60),
      custodian_name  VARCHAR(255),
      notes           TEXT,
      shared_access   TINYINT      DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS categories (
      id            VARCHAR(60)  PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      tracking_type VARCHAR(20)  NOT NULL DEFAULT 'asset',
      default_unit  VARCHAR(60)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS vendors (
      id             VARCHAR(60)  PRIMARY KEY,
      name           VARCHAR(255) NOT NULL,
      contact_person VARCHAR(255),
      phone          VARCHAR(60),
      email          VARCHAR(255),
      address        TEXT,
      supplies       TEXT,
      notes          TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS items (
      id                     VARCHAR(60)   PRIMARY KEY,
      item_code              VARCHAR(40),
      name                   VARCHAR(255)  NOT NULL,
      category_id            VARCHAR(60),
      category_name          VARCHAR(255),
      tracking_type          VARCHAR(20)   NOT NULL DEFAULT 'asset',
      asset_tag              VARCHAR(100),
      serial_number          VARCHAR(255),
      model_number           VARCHAR(255),
      manufacturer           VARCHAR(255),
      color                  VARCHAR(100),
      dimensions             VARCHAR(255),
      weight                 VARCHAR(100),
      department_id          VARCHAR(60),
      department_name        VARCHAR(255),
      location_id            VARCHAR(60),
      location_name          VARCHAR(255),
      quantity               DECIMAL(12,3) DEFAULT 1,
      unit                   VARCHAR(60)   DEFAULT 'pcs',
      condition_status       VARCHAR(40)   DEFAULT 'good',
      stocking_method        VARCHAR(10)   DEFAULT 'fifo',
      purchase_date          VARCHAR(20),
      purchase_cost          DECIMAL(14,2),
      vendor_id              VARCHAR(60),
      vendor_name            VARCHAR(255),
      warranty_expiry        VARCHAR(20),
      min_stock_level        DECIMAL(12,3),
      reorder_qty            DECIMAL(12,3),
      notes                  TEXT,
      tags                   TEXT,
      photo_path             VARCHAR(255),
      procurement_request_id VARCHAR(60),
      created_at             VARCHAR(40),
      INDEX idx_location  (location_id),
      INDEX idx_category  (category_id),
      INDEX idx_condition (condition_status),
      UNIQUE INDEX idx_item_code (item_code),
      FULLTEXT INDEX ft_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Atomic counters — used to mint sequential, human-readable item codes
    // (e.g. INV-000123) without racing on MAX(x)+1. See nextItemCode() below.
    await conn.query(`CREATE TABLE IF NOT EXISTS id_sequences (
      name     VARCHAR(40) PRIMARY KEY,
      next_val INT         NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Scrap register — a disposed item's row stays in `items` (condition_status
    // stays 'disposed', condition/purchase history, transfers, purchase_logs
    // etc all keep pointing at a real item_id), but it's mirrored here so it
    // can be listed, valued and revalued (depreciated) entirely separately
    // from the live inventory list and the dashboard's inventory valuation.
    await conn.query(`CREATE TABLE IF NOT EXISTS scrap_items (
      id                    VARCHAR(60)  PRIMARY KEY,
      item_id               VARCHAR(60)  NOT NULL,
      item_code             VARCHAR(40),
      name                  VARCHAR(255) NOT NULL,
      category_id           VARCHAR(60),
      category_name         VARCHAR(255),
      quantity               DECIMAL(12,3),
      unit                  VARCHAR(60),
      location_id           VARCHAR(60),
      location_name         VARCHAR(255),
      original_unit_cost    DECIMAL(14,2),
      original_value        DECIMAL(14,2),
      depreciated_value     DECIMAL(14,2),
      condition_at_disposal VARCHAR(40),
      disposed_at           VARCHAR(40),
      disposed_by_id        VARCHAR(60),
      disposed_by_name      VARCHAR(255),
      revalued_by_id        VARCHAR(60),
      revalued_by_name      VARCHAR(255),
      revalued_at           VARCHAR(40),
      notes                 TEXT,
      bill_path             VARCHAR(500),
      bill_filename         VARCHAR(255),
      INDEX idx_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // FIFO/LIFO stock batch ledger
    await conn.query(`CREATE TABLE IF NOT EXISTS stock_batches (
      id                    VARCHAR(60)  PRIMARY KEY,
      item_id               VARCHAR(60)  NOT NULL,
      item_name             VARCHAR(255),
      quantity_received     DECIMAL(12,3) NOT NULL,
      quantity_remaining    DECIMAL(12,3) NOT NULL,
      unit_cost             DECIMAL(14,2),
      received_date         VARCHAR(20),
      received_at           DATETIME     DEFAULT CURRENT_TIMESTAMP,
      procurement_request_id VARCHAR(60),
      batch_number          VARCHAR(60),
      vendor_id             VARCHAR(60),
      vendor_name           VARCHAR(255),
      received_by_id        VARCHAR(60),
      received_by_name      VARCHAR(255),
      INDEX idx_item (item_id),
      INDEX idx_date (received_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Immutable purchase audit log — bill image stored here forever
    await conn.query(`CREATE TABLE IF NOT EXISTS purchase_logs (
      id                    VARCHAR(60)  PRIMARY KEY,
      item_id               VARCHAR(60),
      item_name             VARCHAR(255),
      procurement_id        VARCHAR(60),
      quantity              DECIMAL(12,3),
      unit                  VARCHAR(60),
      unit_cost             DECIMAL(14,2),
      total_cost            DECIMAL(14,2),
      bill_path             VARCHAR(255),
      bill_filename         VARCHAR(255),
      received_at           VARCHAR(40),
      received_by_id        VARCHAR(60),
      received_by_name      VARCHAR(255),
      vendor_id             VARCHAR(60),
      vendor_name           VARCHAR(255),
      location_id           VARCHAR(60),
      location_name         VARCHAR(255),
      notes                 TEXT,
      INDEX idx_item        (item_id),
      INDEX idx_procurement (procurement_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS transfers (
      id                    VARCHAR(60) PRIMARY KEY,
      item_id               VARCHAR(60) NOT NULL,
      item_name             VARCHAR(255),
      from_location_id      VARCHAR(60),
      from_location_name    VARCHAR(255),
      to_location_id        VARCHAR(60),
      to_location_name      VARCHAR(255),
      quantity              DECIMAL(12,3),
      requested_by_id       VARCHAR(60),
      requested_by_name     VARCHAR(255),
      reason                TEXT,
      manager_decision      VARCHAR(30)  DEFAULT 'not_required',
      manager_reviewed_by   VARCHAR(255),
      manager_reviewed_at   VARCHAR(40),
      admin_decision        VARCHAR(30)  DEFAULT 'pending',
      admin_reviewed_by     VARCHAR(255),
      admin_reviewed_at     VARCHAR(40),
      status                VARCHAR(30)  DEFAULT 'pending',
      created_at            VARCHAR(40),
      completed_at          VARCHAR(40),
      INDEX idx_item   (item_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS procurement_requests (
      id                    VARCHAR(60)  PRIMARY KEY,
      requested_by_id       VARCHAR(60),
      requested_by_name     VARCHAR(255),
      division              TEXT,
      item_name             VARCHAR(255) NOT NULL,
      category_id           VARCHAR(60),
      category_name         VARCHAR(255),
      quantity              DECIMAL(12,3),
      unit                  VARCHAR(60),
      estimated_cost        DECIMAL(14,2),
      vendor_id             VARCHAR(60),
      vendor_name           VARCHAR(255),
      justification         TEXT,
      is_restock            TINYINT      DEFAULT 0,
      existing_item_id      VARCHAR(60),
      bill_path             VARCHAR(255),
      bill_filename         VARCHAR(255),
      manager_decision      VARCHAR(30)  DEFAULT 'not_required',
      manager_reviewed_by   VARCHAR(255),
      manager_reviewed_at   VARCHAR(40),
      admin_decision        VARCHAR(30)  DEFAULT 'pending',
      admin_reviewed_by     VARCHAR(255),
      admin_reviewed_at     VARCHAR(40),
      status                VARCHAR(30)  DEFAULT 'pending',
      received_item_id      VARCHAR(60),
      stocking_plan_id      VARCHAR(60),
      created_at            VARCHAR(40),
      ordered_at            VARCHAR(40),
      received_at           VARCHAR(40),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS repair_requests (
      id                   VARCHAR(60)  PRIMARY KEY,
      item_id              VARCHAR(60)  NOT NULL,
      item_name            VARCHAR(255),
      location_id          VARCHAR(60),
      location_name        VARCHAR(255),
      reported_by_id       VARCHAR(60),
      reported_by_name     VARCHAR(255),
      issue                TEXT,
      priority             VARCHAR(20)  DEFAULT 'medium',
      status               VARCHAR(30)  DEFAULT 'reported',
      assigned_vendor_id   VARCHAR(60),
      assigned_vendor_name VARCHAR(255),
      estimated_cost       DECIMAL(14,2),
      actual_cost          DECIMAL(14,2),
      resolution_notes     TEXT,
      reported_at          VARCHAR(40),
      resolved_at          VARCHAR(40),
      INDEX idx_item   (item_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS condition_logs (
      id                  VARCHAR(60) PRIMARY KEY,
      item_id             VARCHAR(60) NOT NULL,
      item_name           VARCHAR(255),
      previous_condition  VARCHAR(40),
      new_condition       VARCHAR(40),
      note                TEXT,
      logged_by_id        VARCHAR(60),
      logged_by_name      VARCHAR(255),
      logged_at           VARCHAR(40),
      INDEX idx_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Stocking plans: annual budgets, weekly orders, petty cash allocation
    await conn.query(`CREATE TABLE IF NOT EXISTS stocking_plans (
      id               VARCHAR(60)  PRIMARY KEY,
      plan_type        VARCHAR(20)  NOT NULL DEFAULT 'annual',
      title            VARCHAR(255) NOT NULL,
      description      TEXT,
      budget           DECIMAL(14,2),
      spent            DECIMAL(14,2) DEFAULT 0,
      department_id    VARCHAR(60),
      department_name  VARCHAR(255),
      fiscal_year      VARCHAR(20),
      week_number      SMALLINT,
      week_start_date  VARCHAR(20),
      items_plan       TEXT,
      status           VARCHAR(30)  DEFAULT 'active',
      created_by_id    VARCHAR(60),
      created_by_name  VARCHAR(255),
      created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
      approved_by_id   VARCHAR(60),
      approved_by_name VARCHAR(255),
      approved_at      DATETIME,
      INDEX idx_type   (plan_type),
      INDEX idx_dept   (department_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Petty cash expenses
    await conn.query(`CREATE TABLE IF NOT EXISTS petty_expenses (
      id               VARCHAR(60)  PRIMARY KEY,
      description      VARCHAR(255) NOT NULL,
      amount           DECIMAL(14,2) NOT NULL,
      category         VARCHAR(100),
      paid_by_id       VARCHAR(60),
      paid_by_name     VARCHAR(255),
      department_id    VARCHAR(60),
      department_name  VARCHAR(255),
      stocking_plan_id VARCHAR(60),
      receipt_path     VARCHAR(255),
      receipt_filename VARCHAR(255),
      approved_by_id   VARCHAR(60),
      approved_by_name VARCHAR(255),
      status           VARCHAR(30)  DEFAULT 'pending',
      expense_date     VARCHAR(20),
      created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
      notes            TEXT,
      INDEX idx_status (status),
      INDEX idx_dept   (department_id),
      INDEX idx_plan   (stocking_plan_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS password_reset_otps (
      id         VARCHAR(60)  PRIMARY KEY,
      user_id    VARCHAR(60)  NOT NULL,
      email      VARCHAR(255) NOT NULL,
      otp        VARCHAR(10)  NOT NULL,
      expires_at DATETIME     NOT NULL,
      used       TINYINT      DEFAULT 0,
      created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS app_settings (
      id              VARCHAR(10)  PRIMARY KEY DEFAULT 'app',
      school_name     VARCHAR(255) NOT NULL DEFAULT 'Silver Oak School',
      tagline         TEXT,
      logo_path       VARCHAR(255),
      primary_color   VARCHAR(20)  DEFAULT '2E4A93',
      stocking_method VARCHAR(10)  DEFAULT 'fifo',
      petty_cash_limit DECIMAL(14,2) DEFAULT 5000,
      fiscal_year_start VARCHAR(5) DEFAULT '04-01'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Use conn.query() directly here, NOT the module-level queryOne() helper
    // — that helper calls pool.execute(), which would try to check out a
    // SECOND connection from the pool while this function is still holding
    // the first one. With a small connectionLimit (a realistic setting on
    // constrained shared hosting), that second acquisition would wait
    // forever for a connection that only frees up when THIS function
    // returns — a self-deadlock. Verified live at connectionLimit=1.
    const [existingRows] = await conn.query(`SELECT id FROM app_settings WHERE id='app'`);
    if (!existingRows.length) {
      await conn.query(`INSERT INTO app_settings (id,school_name,tagline,primary_color,stocking_method,petty_cash_limit,fiscal_year_start)
                        VALUES ('app','Silver Oak School','AssetTrack — Inventory & Asset Management','2E4A93','fifo',5000,'04-01')`);
    }

    // Safe ADD COLUMN migrations for existing installs
    const safeAdd = async (tbl, col, def) => {
      try { await conn.query(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
    };
    await safeAdd('items', 'stocking_method', `VARCHAR(10) DEFAULT 'fifo'`);
    await safeAdd('items', 'reorder_qty', 'DECIMAL(12,3) DEFAULT NULL');
    await safeAdd('app_settings', 'stocking_method', `VARCHAR(10) DEFAULT 'fifo'`);
    await safeAdd('app_settings', 'petty_cash_limit', 'DECIMAL(14,2) DEFAULT 5000');
    await safeAdd('app_settings', 'fiscal_year_start', `VARCHAR(5) DEFAULT '04-01'`);
    await safeAdd('departments', 'annual_budget', 'DECIMAL(14,2) DEFAULT NULL');
    await safeAdd('procurement_requests', 'stocking_plan_id', 'VARCHAR(60) DEFAULT NULL');
    await safeAdd('items', 'model_number', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('items', 'manufacturer', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('items', 'color', 'VARCHAR(100) DEFAULT NULL');
    await safeAdd('items', 'dimensions', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('items', 'weight', 'VARCHAR(100) DEFAULT NULL');
    // item_code: unique human-readable identifier (INV-000123). Added via
    // safeAdd for upgrades from pre-v3.2 installs where the CREATE TABLE
    // above never ran; existing rows are backfilled with a generated code
    // further down so the UNIQUE index can be added safely afterwards.
    await safeAdd('items', 'item_code', 'VARCHAR(40) DEFAULT NULL');
    await safeAdd('users', 'scrap_access', `VARCHAR(20) DEFAULT NULL`);
    await safeAdd('scrap_items', 'bill_path', 'VARCHAR(500) DEFAULT NULL');
    await safeAdd('scrap_items', 'bill_filename', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('repair_requests', 'bill_path', 'VARCHAR(500) DEFAULT NULL');
    await safeAdd('repair_requests', 'bill_filename', 'VARCHAR(255) DEFAULT NULL');

    // Backfill item_code for any pre-existing rows (upgrade path), then make
    // sure the unique index exists. Done here rather than in the CREATE
    // TABLE block above so it also covers installs upgrading from a version
    // that predates item_code entirely.
    const [uncoded] = await conn.query(`SELECT id FROM items WHERE item_code IS NULL OR item_code=''`);
    if (uncoded.length) {
      for (const row of uncoded) {
        const [seqRows] = await conn.query(`SELECT next_val FROM id_sequences WHERE name='item' FOR UPDATE`);
        let val;
        if (seqRows.length) {
          val = seqRows[0].next_val;
          await conn.query(`UPDATE id_sequences SET next_val=next_val+1 WHERE name='item'`);
        } else {
          val = 1;
          await conn.query(`INSERT INTO id_sequences (name,next_val) VALUES ('item',2)`);
        }
        await conn.query(`UPDATE items SET item_code=? WHERE id=?`, [`INV-${String(val).padStart(6,'0')}`, row.id]);
      }
    } else {
      const [seqRows] = await conn.query(`SELECT next_val FROM id_sequences WHERE name='item'`);
      if (!seqRows.length) await conn.query(`INSERT INTO id_sequences (name,next_val) VALUES ('item',1)`);
    }
    try { await conn.query(`ALTER TABLE items ADD UNIQUE INDEX idx_item_code (item_code)`); } catch (e) { if (e.code !== 'ER_DUP_KEYNAME' && e.code !== 'ER_DUP_FIELDNAME') { /* ignore if already present from CREATE TABLE */ } }
    // Filesystem-storage path columns (v3.1) — images/documents now live on
    // disk under uploads/, not as LONGBLOB columns. Safe to add on upgrade;
    // any old *_data/*_mime columns from a pre-3.1 install are simply left
    // unused rather than migrated automatically (re-upload after upgrading).
    await safeAdd('users', 'avatar_path', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('items', 'photo_path', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('app_settings', 'logo_path', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('procurement_requests', 'bill_path', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('purchase_logs', 'bill_path', 'VARCHAR(255) DEFAULT NULL');
    await safeAdd('petty_expenses', 'receipt_path', 'VARCHAR(255) DEFAULT NULL');
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function getSettings() {
  const r = await queryOne(`SELECT id, school_name, tagline, primary_color, stocking_method,
                                   petty_cash_limit, fiscal_year_start, logo_path
                            FROM app_settings WHERE id='app'`);
  if (!r) return { schoolName:'School', tagline:'', primaryColor:'2E4A93', hasLogo:false, logoPath:null, stockingMethod:'fifo', pettyCashLimit:5000, fiscalYearStart:'04-01' };
  return {
    schoolName:       r.school_name,
    tagline:          r.tagline,
    primaryColor:     r.primary_color,
    hasLogo:          !!r.logo_path,
    logoPath:         r.logo_path,
    stockingMethod:   r.stocking_method || 'fifo',
    pettyCashLimit:   Number(r.petty_cash_limit || 5000),
    fiscalYearStart:  r.fiscal_year_start || '04-01'
  };
}

async function saveSettings(updates = {}) {
  const cur = await getSettings();
  await run(`UPDATE app_settings SET school_name=?,tagline=?,primary_color=?,stocking_method=?,petty_cash_limit=?,fiscal_year_start=? WHERE id='app'`, [
    (updates.schoolName ?? cur.schoolName) || 'School',
    updates.tagline      !== undefined ? updates.tagline      : cur.tagline,
    updates.primaryColor !== undefined ? updates.primaryColor : cur.primaryColor,
    updates.stockingMethod !== undefined ? updates.stockingMethod : cur.stockingMethod,
    updates.pettyCashLimit !== undefined ? updates.pettyCashLimit : cur.pettyCashLimit,
    updates.fiscalYearStart !== undefined ? updates.fiscalYearStart : cur.fiscalYearStart,
  ]);
  return getSettings();
}

async function setLogoPath(relPath) { await run(`UPDATE app_settings SET logo_path=? WHERE id='app'`,[relPath]); }
async function getLogoPath()        { const r = await queryOne(`SELECT logo_path FROM app_settings WHERE id='app'`); return r ? r.logo_path : null; }
async function clearLogoPath()      { await run(`UPDATE app_settings SET logo_path=NULL WHERE id='app'`); }

// ---------------------------------------------------------------------------
// File path helpers — each pair stores/reads/clears a relative path (as
// written by fileStorage.js) on the owning row. The actual file I/O lives
// in fileStorage.js; these just persist "where is it" alongside the record.
// ---------------------------------------------------------------------------
async function getAvatarPath(uid)                    { const r = await queryOne(`SELECT avatar_path FROM users WHERE id=?`,[uid]); return r ? r.avatar_path : null; }
async function setAvatarPath(uid, relPath)            { await run(`UPDATE users SET avatar_path=? WHERE id=?`,[relPath,uid]); }
async function clearAvatarPath(uid)                   { await run(`UPDATE users SET avatar_path=NULL WHERE id=?`,[uid]); }

async function getItemPhotoPath(id)                   { const r = await queryOne(`SELECT photo_path FROM items WHERE id=?`,[id]); return r ? r.photo_path : null; }
async function setItemPhotoPath(id, relPath)          { await run(`UPDATE items SET photo_path=? WHERE id=?`,[relPath,id]); }
async function clearItemPhotoPath(id)                 { await run(`UPDATE items SET photo_path=NULL WHERE id=?`,[id]); }

async function getProcurementBillPath(id)             { return queryOne(`SELECT bill_path,bill_filename FROM procurement_requests WHERE id=?`,[id]); }
async function setProcurementBillPath(id, relPath, fn){ await run(`UPDATE procurement_requests SET bill_path=?,bill_filename=? WHERE id=?`,[relPath,fn||'bill',id]); }
async function clearProcurementBillPath(id)           { await run(`UPDATE procurement_requests SET bill_path=NULL,bill_filename=NULL WHERE id=?`,[id]); }
async function getPurchaseLogBillPath(id)             { return queryOne(`SELECT bill_path,bill_filename FROM purchase_logs WHERE id=?`,[id]); }
async function getPurchaseLogsByProcurementId(procurementId) {
  return query(`SELECT id,bill_path,bill_filename FROM purchase_logs WHERE procurement_id=?`, [procurementId]);
}
async function setPurchaseLogBillPath(id, billPath, billFilename) {
  await run(`UPDATE purchase_logs SET bill_path=?, bill_filename=? WHERE id=?`, [billPath, billFilename, id]);
}
async function getPettyReceiptPath(id)                { return queryOne(`SELECT receipt_path,receipt_filename FROM petty_expenses WHERE id=?`,[id]); }
async function setPettyReceiptPath(id, relPath, fn)   { await run(`UPDATE petty_expenses SET receipt_path=?,receipt_filename=? WHERE id=?`,[relPath,fn||'receipt',id]); }

// ---------------------------------------------------------------------------
// OTP helpers
// ---------------------------------------------------------------------------
async function createOtp(userId, email, otp, expiresAt) {
  const id = `otp_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  await run(`DELETE FROM password_reset_otps WHERE email=?`,[email]);
  await run(`INSERT INTO password_reset_otps (id,user_id,email,otp,expires_at) VALUES (?,?,?,?,?)`,[id,userId,email,otp,expiresAt]);
  return id;
}
async function verifyOtp(email,otp)  { return queryOne(`SELECT * FROM password_reset_otps WHERE email=? AND otp=? AND used=0 AND expires_at>?`,[email,otp,new Date()]); }
async function consumeOtp(id)        { await run(`UPDATE password_reset_otps SET used=1 WHERE id=?`,[id]); }
async function cleanOtps()           { await run(`DELETE FROM password_reset_otps WHERE expires_at<? OR used=1`,[new Date()]); }

// ---------------------------------------------------------------------------
// Item codes — a stable, human-readable identifier (INV-000123) that lets
// staff tell apart two inventory rows that share the same name (e.g. two
// "Desk" rows in two different classes, or a batch spun off from another
// via transfer). Minted from a row-locked counter so concurrent creates
// under load never collide, and immutable once assigned — nothing in
// server.js's PATCH /api/items allow-list includes itemCode.
// ---------------------------------------------------------------------------
async function nextItemCode() {
  return withTx(async conn => {
    await conn.execute(`INSERT INTO id_sequences (name,next_val) VALUES ('item',1) ON DUPLICATE KEY UPDATE next_val=next_val`);
    const [rows] = await conn.execute(`SELECT next_val FROM id_sequences WHERE name='item' FOR UPDATE`);
    const val = rows[0].next_val;
    await conn.execute(`UPDATE id_sequences SET next_val=next_val+1 WHERE name='item'`);
    return `INV-${String(val).padStart(6, '0')}`;
  });
}

// ---------------------------------------------------------------------------
// Scrap register — disposed items, valued separately from live inventory
// ---------------------------------------------------------------------------
async function getScrapByItemId(itemId) {
  return queryOne(`SELECT * FROM scrap_items WHERE item_id=?`, [itemId]);
}

function scrapFromRow(r) {
  return {
    id: r.id, itemId: r.item_id, itemCode: r.item_code, name: r.name,
    categoryId: r.category_id, categoryName: r.category_name,
    quantity: r.quantity != null ? Number(r.quantity) : null, unit: r.unit,
    locationId: r.location_id, locationName: r.location_name,
    originalUnitCost: r.original_unit_cost != null ? Number(r.original_unit_cost) : null,
    originalValue: r.original_value != null ? Number(r.original_value) : 0,
    depreciatedValue: r.depreciated_value != null ? Number(r.depreciated_value) : null,
    conditionAtDisposal: r.condition_at_disposal,
    disposedAt: r.disposed_at, disposedByName: r.disposed_by_name,
    revaluedByName: r.revalued_by_name, revaluedAt: r.revalued_at,
    notes: r.notes, hasBill: !!r.bill_path, billFilename: r.bill_filename || null
  };
}

async function insertScrapRecord(s) {
  const id = uid('scr');
  await run(
    `INSERT INTO scrap_items (id,item_id,item_code,name,category_id,category_name,quantity,unit,location_id,location_name,original_unit_cost,original_value,depreciated_value,condition_at_disposal,disposed_at,disposed_by_id,disposed_by_name,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, s.itemId, s.itemCode||null, s.name, s.categoryId||null, s.categoryName||null, s.quantity??null, s.unit||null,
     s.locationId||null, s.locationName||null, s.originalUnitCost??null, s.originalValue??0, null,
     s.conditionAtDisposal||null, s.disposedAt||null, s.disposedById||null, s.disposedByName||null, s.notes||null]
  );
  return id;
}

async function removeScrapRecord(itemId) { await run(`DELETE FROM scrap_items WHERE item_id=?`, [itemId]); }
async function deleteScrapById(id) { await run(`DELETE FROM scrap_items WHERE id=?`, [id]); }
async function getScrapById(id) { const r = await queryOne(`SELECT * FROM scrap_items WHERE id=?`, [id]); return r ? scrapFromRow(r) : null; }
async function getScrapBillPath(id) { return queryOne(`SELECT bill_path,bill_filename FROM scrap_items WHERE id=?`, [id]); }
async function setScrapBillPath(id, billPath, billFilename) { await run(`UPDATE scrap_items SET bill_path=?, bill_filename=? WHERE id=?`, [billPath, billFilename, id]); }
async function clearScrapBillPath(id) { await run(`UPDATE scrap_items SET bill_path=NULL, bill_filename=NULL WHERE id=?`, [id]); }

async function getRepairBillPath(id) { return queryOne(`SELECT bill_path,bill_filename FROM repair_requests WHERE id=?`, [id]); }
async function setRepairBillPath(id, billPath, billFilename) { await run(`UPDATE repair_requests SET bill_path=?, bill_filename=? WHERE id=?`, [billPath, billFilename, id]); }
async function clearRepairBillPath(id) { await run(`UPDATE repair_requests SET bill_path=NULL, bill_filename=NULL WHERE id=?`, [id]); }

async function clearPettyReceiptPath(id) { await run(`UPDATE petty_expenses SET receipt_path=NULL, receipt_filename=NULL WHERE id=?`, [id]); }

async function listScraps() {
  const rows = await query(`SELECT * FROM scrap_items ORDER BY disposed_at DESC`);
  return rows.map(scrapFromRow);
}

async function updateScrapValue(id, { depreciatedValue, notes, revaluedById, revaluedByName }) {
  const fields = []; const vals = [];
  if (depreciatedValue !== undefined) { fields.push('depreciated_value=?'); vals.push(depreciatedValue === '' || depreciatedValue === null ? null : Number(depreciatedValue)); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes || null); }
  fields.push('revalued_by_id=?','revalued_by_name=?','revalued_at=?');
  vals.push(revaluedById||null, revaluedByName||null, new Date().toISOString());
  vals.push(id);
  await run(`UPDATE scrap_items SET ${fields.join(',')} WHERE id=?`, vals);
  return queryOne(`SELECT * FROM scrap_items WHERE id=?`, [id]).then(r => r ? scrapFromRow(r) : null);
}

// ---------------------------------------------------------------------------
// FIFO / LIFO stock batch helpers
// ---------------------------------------------------------------------------
const uid = p => `${p}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

async function addStockBatch(conn, { itemId, itemName, qtyReceived, unitCost, receivedDate, procurementId, vendorId, vendorName, receivedById, receivedByName }) {
  const id = uid('bat');
  await conn.execute(
    `INSERT INTO stock_batches (id,item_id,item_name,quantity_received,quantity_remaining,unit_cost,received_date,procurement_request_id,vendor_id,vendor_name,received_by_id,received_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, itemId, itemName, qtyReceived, qtyReceived, unitCost||null, receivedDate||null, procurementId||null, vendorId||null, vendorName||null, receivedById||null, receivedByName||null]
  );
  return id;
}

// Deduct qty from batches using FIFO or LIFO; returns weighted average unit cost
async function deductFromBatches(conn, itemId, qty, method = 'fifo') {
  const order = method === 'lifo' ? 'DESC' : 'ASC';
  const [batches] = await conn.execute(
    `SELECT id, quantity_remaining, unit_cost FROM stock_batches WHERE item_id=? AND quantity_remaining>0 ORDER BY received_date ${order}, received_at ${order} FOR UPDATE`,
    [itemId]
  );
  let remaining = qty;
  let totalCost = 0;
  let deducted  = 0;
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(Number(b.quantity_remaining), remaining);
    await conn.execute(`UPDATE stock_batches SET quantity_remaining=quantity_remaining-? WHERE id=?`, [take, b.id]);
    totalCost += take * Number(b.unit_cost || 0);
    deducted  += take;
    remaining -= take;
  }
  return { deducted, avgCost: deducted ? totalCost / deducted : 0 };
}

// Get current batch breakdown for display (FIFO/LIFO order)
async function getStockBatches(itemId, method = 'fifo') {
  const order = method === 'lifo' ? 'DESC' : 'ASC';
  return query(
    `SELECT id, quantity_received, quantity_remaining, unit_cost, received_date, received_by_name, vendor_name, procurement_request_id
     FROM stock_batches WHERE item_id=? AND quantity_remaining>0 ORDER BY received_date ${order}, received_at ${order}`,
    [itemId]
  );
}

// Get all batches for item (history including exhausted)
async function getAllStockBatches(itemId) {
  return query(
    `SELECT * FROM stock_batches WHERE item_id=? ORDER BY received_at DESC`,
    [itemId]
  );
}

// ---------------------------------------------------------------------------
// Purchase log helpers
// ---------------------------------------------------------------------------
async function createPurchaseLog(conn, { id, itemId, itemName, procurementId, quantity, unit, unitCost, totalCost, billPath, billFilename, receivedAt, receivedById, receivedByName, vendorId, vendorName, locationId, locationName, notes }) {
  await conn.execute(
    `INSERT INTO purchase_logs (id,item_id,item_name,procurement_id,quantity,unit,unit_cost,total_cost,bill_path,bill_filename,received_at,received_by_id,received_by_name,vendor_id,vendor_name,location_id,location_name,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,itemId,itemName,procurementId,quantity,unit,unitCost||null,totalCost||null,billPath||null,billFilename||null,receivedAt,receivedById,receivedByName,vendorId||null,vendorName||null,locationId||null,locationName||null,notes||null]
  );
}
async function getPurchaseLogsForItem(itemId) {
  const rows = await query(`SELECT id,procurement_id,quantity,unit,unit_cost,total_cost,bill_path,bill_filename,received_at,received_by_name,vendor_name,location_name,notes FROM purchase_logs WHERE item_id=? ORDER BY received_at DESC`, [itemId]);
  return rows.map(r => ({
    id: r.id, procurementId: r.procurement_id, quantity: r.quantity != null ? Number(r.quantity) : null,
    unit: r.unit, unitCost: r.unit_cost != null ? Number(r.unit_cost) : null,
    totalCost: r.total_cost != null ? Number(r.total_cost) : null,
    billPath: r.bill_path, billFilename: r.bill_filename, receivedAt: r.received_at,
    receivedByName: r.received_by_name, vendorName: r.vendor_name, locationName: r.location_name,
    notes: r.notes
  }));
}

// ---------------------------------------------------------------------------
// Stocking plans
// ---------------------------------------------------------------------------
async function listStockingPlans({ planType, departmentId, status } = {}) {
  let sql = `SELECT id,plan_type,title,description,budget,spent,department_id,department_name,fiscal_year,week_number,week_start_date,status,created_by_name,created_at,approved_by_name,approved_at FROM stocking_plans WHERE 1`;
  const p = [];
  if (planType)     { sql += ` AND plan_type=?`;    p.push(planType); }
  if (departmentId) { sql += ` AND department_id=?`; p.push(departmentId); }
  if (status)       { sql += ` AND status=?`;        p.push(status); }
  sql += ` ORDER BY created_at DESC`;
  const rows = await query(sql, p);
  return rows.map(r => ({
    id: r.id, planType: r.plan_type, title: r.title, description: r.description,
    budget: r.budget != null ? Number(r.budget) : null,
    spent: Number(r.spent || 0),
    departmentId: r.department_id, departmentName: r.department_name,
    fiscalYear: r.fiscal_year, weekNumber: r.week_number, weekStartDate: r.week_start_date,
    status: r.status, createdByName: r.created_by_name,
    createdAt: r.created_at, approvedByName: r.approved_by_name, approvedAt: r.approved_at,
    remaining: r.budget != null ? Number(r.budget) - Number(r.spent||0) : null
  }));
}

async function insertStockingPlan(plan) {
  await run(
    `INSERT INTO stocking_plans (id,plan_type,title,description,budget,department_id,department_name,fiscal_year,week_number,week_start_date,status,created_by_id,created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [plan.id,plan.planType,plan.title,plan.description||null,plan.budget||null,plan.departmentId||null,plan.departmentName||null,plan.fiscalYear||null,plan.weekNumber||null,plan.weekStartDate||null,plan.status||'active',plan.createdById,plan.createdByName]
  );
}

async function updateStockingPlan(id, updates) {
  const fields = []; const vals = [];
  if (updates.title       !== undefined) { fields.push('title=?');        vals.push(updates.title); }
  if (updates.description !== undefined) { fields.push('description=?');   vals.push(updates.description); }
  if (updates.budget      !== undefined) { fields.push('budget=?');        vals.push(updates.budget); }
  if (updates.status      !== undefined) { fields.push('status=?');        vals.push(updates.status); }
  if (updates.approvedById!== undefined) { fields.push('approved_by_id=?,approved_by_name=?,approved_at=?'); vals.push(updates.approvedById); vals.push(updates.approvedByName); vals.push(new Date()); }
  if (!fields.length) return;
  vals.push(id);
  await run(`UPDATE stocking_plans SET ${fields.join(',')} WHERE id=?`, vals);
}

async function addSpentToplan(conn, planId, amount) {
  if (!planId || !amount) return;
  await conn.execute(`UPDATE stocking_plans SET spent=spent+? WHERE id=?`, [amount, planId]);
}

// ---------------------------------------------------------------------------
// Petty expenses
// ---------------------------------------------------------------------------
async function listPettyExpenses({ departmentId, status, planId } = {}) {
  let sql = `SELECT id,description,amount,category,paid_by_name,department_id,department_name,stocking_plan_id,receipt_path,receipt_filename,approved_by_name,status,expense_date,created_at,notes FROM petty_expenses WHERE 1`;
  const p = [];
  if (departmentId) { sql += ` AND department_id=?`;   p.push(departmentId); }
  if (status)       { sql += ` AND status=?`;           p.push(status); }
  if (planId)       { sql += ` AND stocking_plan_id=?`; p.push(planId); }
  sql += ` ORDER BY created_at DESC`;
  const rows = await query(sql, p);
  return rows.map(r => ({
    id:r.id, description:r.description, amount:Number(r.amount), category:r.category,
    paidByName:r.paid_by_name, departmentId:r.department_id, departmentName:r.department_name,
    stockingPlanId:r.stocking_plan_id, receiptPath:r.receipt_path||null, hasReceipt:!!(r.receipt_path), receiptFilename:r.receipt_filename,
    approvedByName:r.approved_by_name, status:r.status, expenseDate:r.expense_date,
    createdAt:r.created_at, notes:r.notes
  }));
}

async function insertPettyExpense(e) {
  await run(
    `INSERT INTO petty_expenses (id,description,amount,category,paid_by_id,paid_by_name,department_id,department_name,stocking_plan_id,status,expense_date,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.id,e.description,e.amount,e.category||null,e.paidById,e.paidByName,e.departmentId||null,e.departmentName||null,e.stockingPlanId||null,e.status||'pending',e.expenseDate||null,e.notes||null]
  );
}

async function updatePettyExpense(id, updates) {
  const fields = []; const vals = [];
  if (updates.status !== undefined) { fields.push('status=?'); vals.push(updates.status); }
  if (updates.approvedById !== undefined) { fields.push('approved_by_id=?,approved_by_name=?'); vals.push(updates.approvedById,updates.approvedByName); }
  if (!fields.length) return;
  vals.push(id);
  await run(`UPDATE petty_expenses SET ${fields.join(',') } WHERE id=?`, vals);
}

// ---------------------------------------------------------------------------
// Generic load/save (table-map pattern from v2, kept for compatibility)
// ---------------------------------------------------------------------------
const COL = {
  departments: {
    toRow(d) { return { id:d.id, name:d.name, notes:d.notes||null, annual_budget:d.annualBudget||null }; },
    fromRow(r){ return { id:r.id, name:r.name, notes:r.notes, annualBudget:r.annual_budget!=null?Number(r.annual_budget):null }; }
  },
  users: {
    skip: ['avatar_path'],
    toRow(u) {
      return { id:u.id,name:u.name,email:u.email,password_hash:u.passwordHash,role:u.role||'staff',
               division:u.division||null,department_ids:JSON.stringify(u.departmentIds||[]),
               location_id:u.locationId||null,manager_id:u.managerId||null,phone:u.phone||null,
               avatar_color:u.avatarColor||null,status:u.status||'active',created_at:u.createdAt||null,
               dashboard_access:u.dashboardAccess||null,scrap_access:u.scrapAccess||null,email_notifications:u.emailNotifications===false?0:1 };
    },
    fromRow(r){ return { id:r.id,name:r.name,email:r.email,passwordHash:r.password_hash,role:r.role,division:r.division,
                         departmentIds:(()=>{try{return r.department_ids?JSON.parse(r.department_ids):[];}catch{return [];}})(),
                         locationId:r.location_id,managerId:r.manager_id,phone:r.phone,avatarColor:r.avatar_color,
                         avatarPath:r.avatar_path||null,hasAvatar:!!(r.avatar_path),status:r.status,createdAt:r.created_at,dashboardAccess:r.dashboard_access||null,
                         scrapAccess:r.scrap_access||null,
                         emailNotifications:r.email_notifications!==0 }; }
  },
  locations: {
    toRow(l){ return { id:l.id,name:l.name,type:l.type||null,building:l.building||null,floor:l.floor||null,
                       department_id:l.departmentId||null,department_name:l.departmentName||null,
                       custodian_id:l.custodianId||null,custodian_name:l.custodianName||null,notes:l.notes||null,shared_access:l.sharedAccess?1:0 }; },
    fromRow(r){ return { id:r.id,name:r.name,type:r.type,building:r.building,floor:r.floor,
                         departmentId:r.department_id,departmentName:r.department_name,
                         custodianId:r.custodian_id,custodianName:r.custodian_name,notes:r.notes,sharedAccess:!!r.shared_access }; }
  },
  categories: {
    toRow(c){ return { id:c.id,name:c.name,tracking_type:c.trackingType||'asset',default_unit:c.defaultUnit||'pcs' }; },
    fromRow(r){ return { id:r.id,name:r.name,trackingType:r.tracking_type,defaultUnit:r.default_unit }; }
  },
  vendors: {
    toRow(v){ return { id:v.id,name:v.name,contact_person:v.contactPerson||null,phone:v.phone||null,
                       email:v.email||null,address:v.address||null,supplies:v.supplies||null,notes:v.notes||null }; },
    fromRow(r){ return { id:r.id,name:r.name,contactPerson:r.contact_person,phone:r.phone,email:r.email,address:r.address,supplies:r.supplies,notes:r.notes }; }
  },
  items: {
    skip:['photo_path'],
    toRow(i){ return {
      id:i.id,item_code:i.itemCode||null,name:i.name,category_id:i.categoryId||null,category_name:i.categoryName||null,
      tracking_type:i.trackingType||'asset',asset_tag:i.assetTag||null,serial_number:i.serialNumber||null,
      model_number:i.modelNumber||null,manufacturer:i.manufacturer||null,color:i.color||null,
      dimensions:i.dimensions||null,weight:i.weight||null,department_id:i.departmentId||null,
      department_name:i.departmentName||null,location_id:i.locationId||null,location_name:i.locationName||null,
      quantity:i.quantity??1,unit:i.unit||'pcs',condition_status:i.condition||'good',
      stocking_method:i.stockingMethod||'fifo',purchase_date:i.purchaseDate||null,
      purchase_cost:i.purchaseCost??null,vendor_id:i.vendorId||null,vendor_name:i.vendorName||null,
      warranty_expiry:i.warrantyExpiry||null,min_stock_level:i.minStockLevel??null,
      reorder_qty:i.reorderQty??null,notes:i.notes||null,
      tags:Array.isArray(i.tags)?JSON.stringify(i.tags):(i.tags||null),
      procurement_request_id:i.procurementRequestId||null,created_at:i.createdAt||null
    }; },
    fromRow(r){ return {
      id:r.id,itemCode:r.item_code,name:r.name,categoryId:r.category_id,categoryName:r.category_name,trackingType:r.tracking_type,
      assetTag:r.asset_tag,serialNumber:r.serial_number,modelNumber:r.model_number,manufacturer:r.manufacturer,
      color:r.color,dimensions:r.dimensions,weight:r.weight,departmentId:r.department_id,departmentName:r.department_name,
      locationId:r.location_id,locationName:r.location_name,quantity:Number(r.quantity),unit:r.unit,
      condition:r.condition_status,stockingMethod:r.stocking_method||'fifo',purchaseDate:r.purchase_date,
      purchaseCost:r.purchase_cost!=null?Number(r.purchase_cost):null,vendorId:r.vendor_id,vendorName:r.vendor_name,
      warrantyExpiry:r.warranty_expiry,minStockLevel:r.min_stock_level!=null?Number(r.min_stock_level):null,
      reorderQty:r.reorder_qty!=null?Number(r.reorder_qty):null,notes:r.notes,
      tags:(()=>{try{return r.tags?JSON.parse(r.tags):[];}catch{return[];}})(),
      photoPath:r.photo_path||null,hasPhoto:!!(r.photo_path),procurementRequestId:r.procurement_request_id,createdAt:r.created_at
    }; }
  },
  transfers: {
    toRow(t){ return { id:t.id,item_id:t.itemId,item_name:t.itemName,from_location_id:t.fromLocationId||null,from_location_name:t.fromLocationName||null,to_location_id:t.toLocationId||null,to_location_name:t.toLocationName||null,quantity:t.quantity??null,requested_by_id:t.requestedById,requested_by_name:t.requestedByName,reason:t.reason,manager_decision:t.managerDecision||'not_required',manager_reviewed_by:t.managerReviewedBy||null,manager_reviewed_at:t.managerReviewedAt||null,admin_decision:t.adminDecision||'pending',admin_reviewed_by:t.adminReviewedBy||null,admin_reviewed_at:t.adminReviewedAt||null,status:t.status||'pending',created_at:t.createdAt||null,completed_at:t.completedAt||null }; },
    fromRow(r){ return { id:r.id,itemId:r.item_id,itemName:r.item_name,fromLocationId:r.from_location_id,fromLocationName:r.from_location_name,toLocationId:r.to_location_id,toLocationName:r.to_location_name,quantity:r.quantity!=null?Number(r.quantity):null,requestedById:r.requested_by_id,requestedByName:r.requested_by_name,reason:r.reason,managerDecision:r.manager_decision,managerReviewedBy:r.manager_reviewed_by,managerReviewedAt:r.manager_reviewed_at,adminDecision:r.admin_decision,adminReviewedBy:r.admin_reviewed_by,adminReviewedAt:r.admin_reviewed_at,status:r.status,createdAt:r.created_at,completedAt:r.completed_at }; }
  },
  procurementRequests: {
    sqlTable:'procurement_requests', skip:['bill_path'],
    toRow(p){ return { id:p.id,requested_by_id:p.requestedById,requested_by_name:p.requestedByName,division:p.division||null,item_name:p.itemName,category_id:p.categoryId||null,category_name:p.categoryName||null,quantity:p.quantity??null,unit:p.unit||null,estimated_cost:p.estimatedCost??null,vendor_id:p.vendorId||null,vendor_name:p.vendorName||null,justification:p.justification,is_restock:p.isRestock?1:0,existing_item_id:p.existingItemId||null,bill_filename:p.billFilename||null,manager_decision:p.managerDecision||'not_required',manager_reviewed_by:p.managerReviewedBy||null,manager_reviewed_at:p.managerReviewedAt||null,admin_decision:p.adminDecision||'pending',admin_reviewed_by:p.adminReviewedBy||null,admin_reviewed_at:p.adminReviewedAt||null,status:p.status||'pending',received_item_id:p.receivedItemId||null,stocking_plan_id:p.stockingPlanId||null,created_at:p.createdAt||null,ordered_at:p.orderedAt||null,received_at:p.receivedAt||null }; },
    fromRow(r){ return { id:r.id,requestedById:r.requested_by_id,requestedByName:r.requested_by_name,division:r.division,itemName:r.item_name,categoryId:r.category_id,categoryName:r.category_name,quantity:r.quantity!=null?Number(r.quantity):null,unit:r.unit,estimatedCost:r.estimated_cost!=null?Number(r.estimated_cost):null,vendorId:r.vendor_id,vendorName:r.vendor_name,justification:r.justification,isRestock:!!r.is_restock,existingItemId:r.existing_item_id,billPath:r.bill_path||null,hasBill:!!(r.bill_path),billFilename:r.bill_filename,managerDecision:r.manager_decision,managerReviewedBy:r.manager_reviewed_by,managerReviewedAt:r.manager_reviewed_at,adminDecision:r.admin_decision,adminReviewedBy:r.admin_reviewed_by,adminReviewedAt:r.admin_reviewed_at,status:r.status,receivedItemId:r.received_item_id,stockingPlanId:r.stocking_plan_id,createdAt:r.created_at,orderedAt:r.ordered_at,receivedAt:r.received_at }; }
  },
  repairRequests: {
    sqlTable:'repair_requests', skip:['bill_path'],
    toRow(r){ return { id:r.id,item_id:r.itemId,item_name:r.itemName,location_id:r.locationId||null,location_name:r.locationName||null,reported_by_id:r.reportedById,reported_by_name:r.reportedByName,issue:r.issue,priority:r.priority||'medium',status:r.status||'reported',assigned_vendor_id:r.assignedVendorId||null,assigned_vendor_name:r.assignedVendorName||null,estimated_cost:r.estimatedCost??null,actual_cost:r.actualCost??null,resolution_notes:r.resolutionNotes||null,bill_filename:r.billFilename||null,reported_at:r.reportedAt||null,resolved_at:r.resolvedAt||null }; },
    fromRow(r){ return { id:r.id,itemId:r.item_id,itemName:r.item_name,locationId:r.location_id,locationName:r.location_name,reportedById:r.reported_by_id,reportedByName:r.reported_by_name,issue:r.issue,priority:r.priority,status:r.status,assignedVendorId:r.assigned_vendor_id,assignedVendorName:r.assigned_vendor_name,estimatedCost:r.estimated_cost!=null?Number(r.estimated_cost):null,actualCost:r.actual_cost!=null?Number(r.actual_cost):null,resolutionNotes:r.resolution_notes,hasBill:!!r.bill_path,billFilename:r.bill_filename,reportedAt:r.reported_at,resolvedAt:r.resolved_at }; }
  },
  conditionLogs: {
    sqlTable:'condition_logs',
    toRow(c){ return { id:c.id,item_id:c.itemId,item_name:c.itemName,previous_condition:c.previousCondition||null,new_condition:c.newCondition,note:c.note||null,logged_by_id:c.loggedById||null,logged_by_name:c.loggedByName||null,logged_at:c.loggedAt||null }; },
    fromRow(r){ return { id:r.id,itemId:r.item_id,itemName:r.item_name,previousCondition:r.previous_condition,newCondition:r.new_condition,note:r.note,loggedById:r.logged_by_id,loggedByName:r.logged_by_name,loggedAt:r.logged_at }; }
  }
};

function sqlTable(name) { return COL[name]?.sqlTable || name; }

async function load(name) {
  const t = COL[name]; if (!t) return [];
  const tbl = sqlTable(name);
  let sql;
  if (name==='users') sql=`SELECT id,name,email,password_hash,role,division,department_ids,location_id,manager_id,phone,avatar_color,avatar_path,status,created_at,dashboard_access,scrap_access,email_notifications FROM users ORDER BY name ASC`;
  else if (name==='items') sql=`SELECT id,item_code,name,category_id,category_name,tracking_type,asset_tag,serial_number,model_number,manufacturer,color,dimensions,weight,department_id,department_name,location_id,location_name,quantity,unit,condition_status,stocking_method,purchase_date,purchase_cost,vendor_id,vendor_name,warranty_expiry,min_stock_level,reorder_qty,notes,tags,photo_path,procurement_request_id,created_at FROM items ORDER BY name ASC`;
  else if (name==='procurementRequests') sql=`SELECT id,requested_by_id,requested_by_name,division,item_name,category_id,category_name,quantity,unit,estimated_cost,vendor_id,vendor_name,justification,is_restock,existing_item_id,bill_path,bill_filename,manager_decision,manager_reviewed_by,manager_reviewed_at,admin_decision,admin_reviewed_by,admin_reviewed_at,status,received_item_id,stocking_plan_id,created_at,ordered_at,received_at FROM procurement_requests ORDER BY created_at DESC`;
  else { const order = { departments:'name ASC',locations:'name ASC',categories:'name ASC',vendors:'name ASC',transfers:'created_at DESC',repairRequests:'reported_at DESC',conditionLogs:'logged_at DESC' }; sql=`SELECT * FROM ${tbl} ORDER BY ${order[name]||'rowid DESC'}`; }
  const rows = await query(sql);
  return rows.map(r => t.fromRow(r));
}

// save() persists the given in-memory array back to its table. Call sites
// follow a "load the array, mutate or filter one item, save the whole
// array back" pattern throughout server.js. To make that both correct and
// fast on a real relational table:
//   1. Rows present in `data` are UPSERTed (INSERT ... ON DUPLICATE KEY
//      UPDATE) touching ONLY the columns in COL[name].toRow() — this never
//      references LONGBLOB columns (photo/avatar/bill/receipt), so images
//      set via the dedicated setXxxImage()/setXxxBill() helpers are never
//      overwritten or wiped out by an unrelated save() elsewhere.
//   2. Rows whose id is no longer present in `data` are deleted — this is
//      what makes the common "save(list.filter(x => x.id !== id))" deletion
//      pattern work.
//   3. The upsert runs as one multi-row INSERT per CHUNK_SIZE rows rather
//      than one statement per row, since call sites always pass the whole
//      array back even when only a single row changed — without batching,
//      a table with a few hundred historical rows would need a few hundred
//      sequential round-trips just to approve one transfer.
// Never uses DELETE-all + bulk-INSERT, since that would null out every
// blob column for every row in the table on every save() call.
const SAVE_CHUNK_SIZE = 200;
async function save(name, data) {
  const t = COL[name]; if (!t) return;
  const tbl = sqlTable(name);
  if (!data?.length) { await run(`DELETE FROM ${tbl}`); return; }
  const cols = Object.keys(t.toRow(data[0]));
  const updateCols = cols.filter(c => c !== 'id');
  const updateClause = updateCols.map(c => `${c}=VALUES(${c})`).join(',');
  const rowPlaceholder = `(${cols.map(() => '?').join(',')})`;
  const ids = data.map(d => d.id);
  return withTx(async conn => {
    // Remove rows that are no longer in the array (deletion pattern)
    const placeholders = ids.map(() => '?').join(',');
    await conn.execute(`DELETE FROM ${tbl} WHERE id NOT IN (${placeholders})`, ids);
    // Upsert in batches — a handful of multi-row round-trips instead of one
    // round-trip per row.
    for (let i = 0; i < data.length; i += SAVE_CHUNK_SIZE) {
      const batch = data.slice(i, i + SAVE_CHUNK_SIZE);
      const values = [];
      for (const item of batch) {
        const row = t.toRow(item);
        values.push(...cols.map(c => row[c] !== undefined ? row[c] : null));
      }
      const sql = `INSERT INTO ${tbl} (${cols.join(',')}) VALUES ${batch.map(() => rowPlaceholder).join(',')}
                   ON DUPLICATE KEY UPDATE ${updateClause}`;
      await conn.execute(sql, values);
    }
  });
}

async function insertOne(name, obj) {
  const t = COL[name]; if (!t) throw new Error('Unknown:'+name);
  const tbl = sqlTable(name);
  const row = t.toRow(obj); const cols = Object.keys(row);
  await run(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`, cols.map(c=>row[c]??null));
}

async function updateOne(name, obj) {
  const t = COL[name]; if (!t) throw new Error('Unknown:'+name);
  const tbl = sqlTable(name);
  const row = t.toRow(obj); const cols = Object.keys(row).filter(c=>c!=='id');
  await run(`UPDATE ${tbl} SET ${cols.map(c=>`${c}=?`).join(',')} WHERE id=?`, [...cols.map(c=>row[c]??null), obj.id]);
}

async function deleteOne(name, id) { const tbl = sqlTable(name); await run(`DELETE FROM ${tbl} WHERE id=?`,[id]); }

module.exports = {
  pool, query, queryOne, run, withTx, init, uid,
  getSettings, saveSettings, setLogoPath, getLogoPath, clearLogoPath,
  getAvatarPath, setAvatarPath, clearAvatarPath,
  getItemPhotoPath, setItemPhotoPath, clearItemPhotoPath,
  getProcurementBillPath, setProcurementBillPath, clearProcurementBillPath,
  getPurchaseLogBillPath, getPettyReceiptPath, setPettyReceiptPath, clearPettyReceiptPath,
  getRepairBillPath, setRepairBillPath, clearRepairBillPath,
  createOtp, verifyOtp, consumeOtp, cleanOtps,
  addStockBatch, deductFromBatches, getStockBatches, getAllStockBatches,
  createPurchaseLog, getPurchaseLogsForItem, getPurchaseLogsByProcurementId, setPurchaseLogBillPath,
  nextItemCode, getScrapByItemId, insertScrapRecord, removeScrapRecord, listScraps, updateScrapValue,
  deleteScrapById, getScrapById, getScrapBillPath, setScrapBillPath, clearScrapBillPath,
  listStockingPlans, insertStockingPlan, updateStockingPlan, addSpentToplan,
  listPettyExpenses, insertPettyExpense, updatePettyExpense,
  load, save, insertOne, updateOne, deleteOne
};
