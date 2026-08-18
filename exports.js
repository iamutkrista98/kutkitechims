// exports.js — Excel (exceljs) report builders for the school inventory
// system. Branding (school name / tagline) is pulled live from app
// settings so the same builders work for any school using this system.
const ExcelJS = require('exceljs');
const { getSettings } = require('./db');

const BRAND = { navy900: '0C1633', navy800: '12204A', navy600: '22397A', navy500: '2E4A93', brass: '5FA82E', brassLight: '8CC63F', ink: '101526', muted: '666F8C', line: 'DCE2F0', canvas: 'EEF2FA' };

const CONDITION_COLORS = {
  new: { fg: 'FFFFFF', bg: '2F8F5B' }, good: { fg: 'FFFFFF', bg: '2F8F5B' },
  fair: { fg: 'FFFFFF', bg: 'C2841F' }, damaged: { fg: 'FFFFFF', bg: 'C0463A' },
  under_repair: { fg: 'FFFFFF', bg: 'C2841F' }, disposed: { fg: '4A5568', bg: 'E9EDF7' }
};
const STATUS_COLORS = {
  pending: { fg: 'FFFFFF', bg: '2C6FA8' }, approved: { fg: 'FFFFFF', bg: '2F8F5B' },
  rejected: { fg: 'FFFFFF', bg: 'C0463A' }, completed: { fg: 'FFFFFF', bg: '2F8F5B' },
  reported: { fg: 'FFFFFF', bg: '2C6FA8' }, in_review: { fg: 'FFFFFF', bg: '2C6FA8' },
  in_repair: { fg: 'FFFFFF', bg: 'C2841F' }, repaired: { fg: 'FFFFFF', bg: '2F8F5B' },
  not_repairable: { fg: 'FFFFFF', bg: 'C0463A' }, cancelled: { fg: '4A5568', bg: 'E9EDF7' }
};

function titleCase(s) { return String(s || '—').split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' '); }
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtMoney(n) { return n === null || n === undefined ? '—' : `Rs. ${Number(n).toLocaleString('en-IN')}`; }
// A row's monetary value is always cost x quantity — an asset bought in a
// batch (e.g. 30 desks logged as one row with quantity 30) is worth just as
// much per-unit as a stock item; there's no reason to special-case tracking
// type here, matching the fix applied to the dashboard valuation.
function rowValue(i) { return (i.purchaseCost || 0) * (i.quantity || 1); }

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------
function styleHeaderRow(row, fillHex) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + fillHex } };
    cell.alignment = { vertical: 'middle' };
  });
  row.height = 22;
}

async function buildInventoryExcel({ items, generatedBy, filterSummary }) {
  const school = await getSettings();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${school.schoolName} — AssetTrack`;
  wb.created = new Date();
  const ws = wb.addWorksheet('Inventory');
  ws.addRow([`${school.schoolName} — Inventory Report`]);
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.addRow([`Generated ${new Date().toLocaleString()} by ${generatedBy}${filterSummary ? ' · Filters: ' + filterSummary : ''}`]);
  ws.getCell('A2').font = { italic: true, size: 9.5, color: { argb: 'FF666F8C' } };
  const totalValue = items.reduce((s, i) => s + rowValue(i), 0);
  ws.addRow([`Total items: ${items.length}  ·  Total value: Rs. ${Math.round(totalValue).toLocaleString('en-IN')}`]);
  ws.addRow([]);

  const headers = ['Name', 'Category', 'Type', 'Asset Tag / Serial', 'Location', 'Qty', 'Unit', 'Condition', 'Purchase Date', 'Purchase Miti', 'Unit Cost', 'Total Value', 'Vendor', 'Warranty Expiry', 'Warranty Miti', 'Notes'];
  const headerRowIdx = 5;
  const headerRow = ws.addRow(headers);
  styleHeaderRow(headerRow, BRAND.navy600);

  items.forEach(i => {
    const row = ws.addRow([
      i.name, i.categoryName || '—', titleCase(i.trackingType), i.assetTag || i.serialNumber || '—',
      i.locationName || '—', i.quantity, i.unit, titleCase(i.condition), fmtDate(i.purchaseDate), i.purchaseDateMiti || '—',
      i.purchaseCost || 0, rowValue(i), i.vendorName || '—', fmtDate(i.warrantyExpiry), i.warrantyExpiryMiti || '—', i.notes || ''
    ]);
    const c = CONDITION_COLORS[i.condition] || CONDITION_COLORS.good;
    const cell = row.getCell(8);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + c.bg } };
    cell.font = { color: { argb: 'FF' + c.fg }, bold: true };
    cell.alignment = { horizontal: 'center' };
  });

  ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: ws.rowCount, column: headers.length } };
  const widths = [26, 16, 10, 18, 18, 8, 8, 12, 14, 13, 12, 13, 18, 14, 13, 26];
  ws.columns.forEach((col, i) => { col.width = widths[i] || 14; });

  return wb.xlsx.writeBuffer();
}

async function buildLogExcel({ kind, rows, title, generatedBy, filterSummary }) {
  const school = await getSettings();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${school.schoolName} — AssetTrack`;
  const ws = wb.addWorksheet(title.slice(0, 28));
  ws.addRow([`${school.schoolName} — ${title}`]);
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.addRow([`Generated ${new Date().toLocaleString()} by ${generatedBy}${filterSummary ? ' · Filters: ' + filterSummary : ''}`]);
  ws.getCell('A2').font = { italic: true, size: 9.5, color: { argb: 'FF666F8C' } };
  ws.addRow([]);

  let headers, mapRow, statusCol;
  if (kind === 'transfers') {
    headers = ['Date', 'Miti', 'Item', 'From', 'To', 'Qty', 'Requested By', 'Reason', 'Manager', 'Admin', 'Status'];
    statusCol = 11;
    mapRow = t => [fmtDate(t.createdAt), t.createdAtMiti || '—', t.itemName, t.fromLocationName || '—', t.toLocationName, t.quantity ?? '—', t.requestedByName, t.reason, titleCase(t.managerDecision), titleCase(t.adminDecision), titleCase(t.status)];
  } else if (kind === 'procurement') {
    headers = ['Date', 'Miti', 'Item', 'Qty', 'Unit', 'Est. Cost', 'Requested By', 'Division', 'Vendor', 'Manager', 'Admin', 'Status'];
    statusCol = 12;
    mapRow = p => [fmtDate(p.createdAt), p.createdAtMiti || '—', p.itemName, p.quantity, p.unit, fmtMoney(p.estimatedCost), p.requestedByName, p.division || '—', p.vendorName || '—', titleCase(p.managerDecision), titleCase(p.adminDecision), titleCase(p.status)];
  } else {
    headers = ['Reported', 'Miti', 'Item', 'Location', 'Issue', 'Priority', 'Status', 'Vendor', 'Est. Cost', 'Actual Cost', 'Resolved', 'Resolved Miti'];
    statusCol = 7;
    mapRow = r => [fmtDate(r.reportedAt), r.reportedAtMiti || '—', r.itemName, r.locationName || '—', r.issue, titleCase(r.priority), titleCase(r.status), r.assignedVendorName || '—', fmtMoney(r.estimatedCost), fmtMoney(r.actualCost), fmtDate(r.resolvedAt), r.resolvedAtMiti || '—'];
  }
  const headerRow = ws.addRow(headers);
  styleHeaderRow(headerRow, BRAND.navy600);

  rows.forEach(r => {
    const row = ws.addRow(mapRow(r));
    const statusVal = (r.status || r.priority || '').toString();
    const c = STATUS_COLORS[statusVal] || STATUS_COLORS.pending;
    const cell = row.getCell(statusCol);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + c.bg } };
    cell.font = { color: { argb: 'FF' + c.fg }, bold: true };
    cell.alignment = { horizontal: 'center' };
  });

  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: ws.rowCount, column: headers.length } };
  ws.columns.forEach(col => { col.width = 18; });
  return wb.xlsx.writeBuffer();
}

module.exports = { buildInventoryExcel, buildLogExcel, rowValue };
