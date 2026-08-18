// app.js — AssetTrack v2 School Inventory Management System
'use strict';

let ME = null;
let LOCATIONS = [], CATEGORIES = [], VENDORS = [], USERS = [], DEPARTMENTS = [], ALL_ITEMS = [];
let MY_LOCATION_REPAIRS = [];
let CURRENT_ITEM = null;
let TRANSFER_ITEMS = [];
let REPAIRS_CACHE = [];
let transferFilter = '', procurementFilter = '', repairFilter = '';
let TEAM_TAB = 'transfer';
let TEAM_DATA = { transfers: [], procurement: [] };
let RECEIVE_PR_ID = null;
// Single shared bill/receipt viewer — used consistently for procurement
// bills, permanent purchase-log bills, petty cash receipts, and scrap
// bills, so preview/remove behaves identically everywhere it appears
// instead of each call site reimplementing its own version.
let BILL_VIEWER_ON_DELETE = null;
function openBillViewer(url, filename, onDelete) {
  const img = document.getElementById('bill-viewer-img');
  const pdf = document.getElementById('bill-viewer-pdf');
  const dl  = document.getElementById('bill-viewer-download');
  const isPdf = (filename||'').toLowerCase().endsWith('.pdf');
  img.style.display = isPdf ? 'none' : 'block';
  pdf.style.display = isPdf ? 'block' : 'none';
  if (isPdf) { pdf.src = url; img.src = ''; } else { img.src = url; pdf.src = ''; }
  dl.href = url;
  BILL_VIEWER_ON_DELETE = onDelete || null;
  const deleteBtn = document.getElementById('bill-viewer-delete-btn');
  if (deleteBtn) deleteBtn.style.display = onDelete ? '' : 'none';
  document.getElementById('bill-viewer-modal').classList.remove('hidden');
}
async function confirmDeleteViewerBill() {
  if (BILL_VIEWER_ON_DELETE) await BILL_VIEWER_ON_DELETE();
}

let CURRENT_BILL_PR_ID = null;
let searchTimer = null;
let invSortDir = 'asc';
let PR_SOURCE = 'new';   // 'new' | 'restock'
let CART = [];           // procurement cart
let TAGS_INPUT = null;   // tags input widget instance

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  document.getElementById('footer-year').textContent = new Date().getFullYear();
  try {
    const data = await api('/api/auth/me');
    ME = data.user;
  } catch {
    window.location.href = '/index.html';
    return;
  }
  document.getElementById('sb-name').textContent = ME.name;
  document.getElementById('sb-role').textContent =
    titleCase(ME.role) + (ME.departmentNames?.length ? ' · ' + ME.departmentNames.join(', ') : '');
  renderSidebarAvatar();
  await applyBranding();
  applyRoleVisibility();
  await loadLookups();
  if (ME.isManager) refreshTeamBadge();
  if (ME.hasFullDashboardAccess) refreshRepairsBadge();
  showView('overview');
}

function renderSidebarAvatar() {
  const el = document.getElementById('sb-avatar');
  if (ME.hasAvatar) {
    el.innerHTML = `<img src="/api/images/avatar/${ME.id}?t=${Date.now()}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    el.textContent = initials(ME.name);
    el.style.background = ME.avatarColor || 'var(--navy-600)';
  }
}

function applyRoleVisibility() {
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', ME.role !== 'admin'));
  document.querySelectorAll('.manager-or-admin').forEach(el => el.classList.toggle('hidden', !['admin','manager'].includes(ME.role)));
  document.getElementById('nav-team').classList.toggle('hidden', !ME.isManager);
  document.querySelectorAll('.dashboard-gated').forEach(el => el.classList.toggle('hidden', !ME.hasFullDashboardAccess));
  document.querySelectorAll('.scrap-gated').forEach(el => el.classList.toggle('hidden', !ME.hasScrapAccess));
  if (!ME.hasFullDashboardAccess) {
    document.getElementById('limited-access-banner')?.classList.remove('hidden');
    loadMyLocation();
  }
}

async function applyBranding() {
  try {
    const { settings } = await api('/api/settings/public', { cache: 'no-store' });
    document.title = `AssetTrack — ${settings.schoolName}`;
    document.querySelectorAll('.brand-schoolname').forEach(el => el.textContent = settings.schoolName);
    document.querySelectorAll('.brand-tagline').forEach(el => el.textContent = settings.schoolName.toUpperCase());
    setBrandMarks('.brand-mark', settings.schoolName, settings.hasLogo);
  } catch {}
}

async function loadLookups() {
  const [loc, cat, ven, dep] = await Promise.all([
    api('/api/locations'), api('/api/categories'), api('/api/vendors'), api('/api/departments')
  ]);
  LOCATIONS = loc.locations; CATEGORIES = cat.categories; VENDORS = ven.vendors; DEPARTMENTS = dep.departments;
  if (ME.role === 'admin') { const u = await api('/api/users'); USERS = u.users; }
}

async function loadMyLocation() {
  const data = await api('/api/my-location');
  MY_LOCATION_REPAIRS = data.repairs;
  const sub = document.getElementById('my-loc-sub');
  if (data.locations.length) sub.textContent = `Custodian of ${data.locations.map(l=>l.name).join(', ')}. Report issues and request transfers for items here.`;
  const tbody = document.querySelector('#my-loc-table tbody');
  tbody.innerHTML = data.items.length ? data.items.map(i => `
    <tr style="cursor:pointer;" onclick="openItem('${i.id}')">
      <td><b>${i.name}</b></td>
      <td>${fmtQty(i)}</td>
      <td>${statusBadge(i.condition)}</td>
      <td>${renderTags(i.tags)}</td>
      <td><div class="flex gap-8">
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openRepairModal('${i.id}')">Report issue</button>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openTransferModal('${i.id}')">Transfer</button>
      </div></td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty-state" style="padding:20px;">No items at your location yet.</td></tr>`;
  const rtbody = document.querySelector('#my-loc-repairs-table tbody');
  rtbody.innerHTML = data.repairs.length ? data.repairs.map(r => `
    <tr><td>${r.itemName}</td><td style="max-width:200px;white-space:normal;">${r.issue}</td>
    <td>${priorityBadge(r.priority)}</td><td>${statusBadge(r.status)}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openMyLocationRepairUpdate('${r.id}')">Update</button></td></tr>`)
    .join('') : `<tr><td colspan="5" class="empty-state" style="padding:20px;">No repairs at your location.</td></tr>`;
}
function openMyLocationRepairUpdate(id) { REPAIRS_CACHE = MY_LOCATION_REPAIRS; openRepairUpdate(id); }

async function logout() {
  await api('/api/auth/logout', { method:'POST' });
  window.location.href = '/index.html';
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────
function showView(view) {
  const gated = ['inventory','transfers','procurement','repairs','reports','team'];
  if (gated.includes(view) && !ME.hasFullDashboardAccess && view !== 'team') view = 'overview';
  if (view === 'scraps' && !ME.hasScrapAccess) view = 'overview';
  document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById('view-' + view);
  if (el) el.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const titles = {
    overview:'Overview', inventory:'Inventory', item:'Item detail', transfers:'Transfers',
    procurement:'Procurement', repairs:'Repairs & Maintenance', team:'Team Approvals',
    departments:'Departments', locations:'Locations', categories:'Categories',
    vendors:'Vendors', users:'Staff & Users', branding:'Branding', reports:'Reports', profile:'My Profile',
    stocking:'Stocking Plans', petty:'Petty Cash', scraps:'Scraps'
  };
  const subs = {
    overview:"Here's what's happening across the school",
    inventory:'Every item and consumable currently tracked',
    transfers:'Move items and stock between locations',
    procurement:'Request and track new purchases for the school',
    repairs:'Report and track equipment issues',
    team:'Review requests from your team',
    departments:'Locations and staff are scoped to these',
    locations:'Rooms, labs and stores across campus',
    categories:'How inventory is grouped and tracked',
    vendors:'Suppliers the school purchases from',
    users:'Manage staff accounts and access levels',
    branding:'School name, logo and tagline',
    reports:'Export data as Excel, filtered by date range',
    profile:'Your account, photo and password',
    stocking:'Annual budgets, weekly orders and departmental allocations',
    petty:'Track small day-to-day purchases against petty cash limits',
    scraps:'Disposed goods, valued separately from live inventory'
  };
  document.getElementById('page-title').textContent = view === 'item' ? (CURRENT_ITEM?.name || 'Item') : (titles[view] || titleCase(view));
  document.getElementById('page-sub').textContent = view === 'item' ? (CURRENT_ITEM?.categoryName || '') : (subs[view] || '');
  toggleSidebar(false);
  const loaders = {
    overview:loadOverview, inventory:loadInventory, transfers:loadTransfers, procurement:loadProcurement,
    repairs:loadRepairs, team:loadTeam, departments:loadDepartments, locations:loadLocations,
    categories:loadCategories, vendors:loadVendors, users:loadUsers, branding:loadBrandingView, profile:loadProfile,
    stocking:loadStocking, petty:loadPetty, scraps:loadScraps
  };
  if (loaders[view]) loaders[view]();
}

function toggleSidebar(force) {
  const sb = document.querySelector('.sidebar');
  if (force === false) sb.classList.remove('open');
  else sb.classList.toggle('open');
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const d = await api('/api/overview');
    document.getElementById('ov-date-strip').textContent =
      fmtDate(d.date) + (d.dateMiti ? ` · ${d.dateMiti} BS` : '') + (d.fiscalYear ? ` · FY ${d.fiscalYear.label}` : '');
    document.getElementById('ov-total').textContent = d.totalItems;
    document.getElementById('ov-value').textContent = fmtMoney(d.totalValue);
    document.getElementById('ov-repair').textContent = d.underRepair;
    document.getElementById('ov-lowstock').textContent = d.lowStockCount;
    document.getElementById('ov-pending').textContent = d.pendingApprovals;
    if (d.scrapSummary) document.getElementById('ov-scrap-value').textContent = fmtMoney(d.scrapSummary.totalScrapValue);

    // Categories bar chart
    document.getElementById('ov-categories').innerHTML = d.byCategory.length ? d.byCategory.map(c => `
      <div style="margin-bottom:14px;">
        <div class="flex between" style="font-size:13px;margin-bottom:5px;">
          <span style="font-weight:600;">${esc(c.category)}</span>
          <span class="muted">${c.count} · ${fmtMoney(c.value)}</span>
        </div>
        <div class="progress-bar"><div class="fill" style="width:${d.totalItems ? Math.min(100,(c.count/d.totalItems)*100) : 0}%"></div></div>
      </div>`).join('') : '<div class="empty-state">No items yet.</div>';

    // Low stock
    document.getElementById('ov-lowstock-list').innerHTML = d.lowStock.length ? d.lowStock.map(i => `
      <div class="alert-card" onclick="openItem('${i.id}')">
        <div style="flex:1;">
          <div class="alert-name">${esc(i.name)}</div>
          <div class="alert-meta">${esc(i.locationName||'—')} · ${i.quantity} ${i.unit} remaining</div>
        </div>
        <span class="badge badge-low">${i.quantity} ${i.unit} left</span>
      </div>`).join('') : '<div class="empty-state">All stock above reorder levels. ✓</div>';

    // Warranty alerts
    document.getElementById('ov-warranty-list').innerHTML = d.warrantyAlerts.length ? d.warrantyAlerts.map(i => `
      <div class="alert-card ${i.warrantyExpired?'danger':''}" onclick="openItem('${i.id}')">
        <div style="flex:1;">
          <div class="alert-name">${esc(i.name)}</div>
          <div class="alert-meta">Expires: ${i.warrantyExpiryMiti ? i.warrantyExpiryMiti+' BS · ' : ''}${fmtDate(i.warrantyExpiry)}</div>
        </div>
        <span class="badge ${i.warrantyExpired?'badge-damaged':'badge-low'}">${i.warrantyExpired?'Expired':'Expiring'}</span>
      </div>`).join('') : '<div class="empty-state">No warranties expiring soon. ✓</div>';

    // Activity feed — clickable
    document.getElementById('ov-activity').innerHTML = d.activity.length ? d.activity.map(a => `
      <div class="activity-item" onclick="navigateToActivity('${a.targetView}','${a.targetId||''}')">
        <div class="activity-dot ${a.type}"></div>
        <div class="activity-text">${esc(a.text)}</div>
        <div class="activity-date">${a.miti||''}<br><span style="font-size:10px;">${timeAgo(a.date)}</span></div>
        ${statusBadge(a.status)}
      </div>`).join('') : '<div class="empty-state">No recent activity.</div>';

    // Quick review panel (admin only)
    if (ME.role === 'admin') {
      document.getElementById('ov-quick-review').classList.remove('hidden');
      renderQuickReview(d);
    }
  } catch(err) { toast('Could not load overview: ' + err.message, 'error'); }
}

function navigateToActivity(view, id) {
  if (!view) return;
  showView(view);
}

function renderQuickReview(d) {
  // Pending transfers
  const tc = d.pendingTransferList?.length || 0;
  document.getElementById('qr-transfer-count').textContent = d.pendingTransfers || 0;
  document.getElementById('qr-transfers-list').innerHTML = tc ? d.pendingTransferList.map(t => `
    <div class="qr-item">
      <div><div class="qr-name">${esc(t.itemName)}</div><div class="qr-sub">${esc(t.requestedByName)} → ${esc(t.toLocationName||'?')} · ${t.createdAtMiti||''}</div></div>
      <div class="qr-actions">
        <button class="btn btn-xs btn-gold" onclick="quickDecideTransfer('${t.id}','approved')">✓</button>
        <button class="btn btn-xs btn-danger-ghost" onclick="quickDecideTransfer('${t.id}','rejected')">✕</button>
      </div>
    </div>`).join('') : '<div class="qr-empty">No pending transfers</div>';

  // Pending procurement
  const pc = d.pendingProcurementList?.length || 0;
  document.getElementById('qr-procurement-count').textContent = d.pendingProcurement || 0;
  document.getElementById('qr-procurement-list').innerHTML = pc ? d.pendingProcurementList.map(p => `
    <div class="qr-item">
      <div><div class="qr-name">${esc(p.itemName)}</div><div class="qr-sub">${esc(p.requestedByName)} · ${p.quantity} ${p.unit||''} · ${p.createdAtMiti||''}</div></div>
      <div class="qr-actions">
        <button class="btn btn-xs btn-gold" onclick="quickDecideProcurement('${p.id}','approved')">✓</button>
        <button class="btn btn-xs btn-danger-ghost" onclick="quickDecideProcurement('${p.id}','rejected')">✕</button>
      </div>
    </div>`).join('') : '<div class="qr-empty">No pending procurement</div>';

  // Open repairs
  const rc = d.pendingRepairList?.length || 0;
  document.getElementById('qr-repairs-count').textContent = d.openRepairs || 0;
  document.getElementById('qr-repairs-list').innerHTML = rc ? d.pendingRepairList.map(r => `
    <div class="qr-item" onclick="showView('repairs')">
      <div><div class="qr-name">${esc(r.itemName)}</div><div class="qr-sub">${esc(r.reportedByName)} · ${priorityBadge(r.priority)} · ${r.reportedAtMiti||''}</div></div>
    </div>`).join('') : '<div class="qr-empty">No open repair reports</div>';
}

async function quickDecideTransfer(id, decision) {
  try {
    await api(`/api/admin/transfers/${id}/decide`, { method:'POST', body:JSON.stringify({ decision }) });
    toast(decision === 'approved' ? 'Transfer approved.' : 'Transfer declined.', 'success');
    loadOverview();
  } catch(err) { toast(err.message, 'error'); }
}
async function quickDecideProcurement(id, decision) {
  try {
    await api(`/api/admin/procurement/${id}/decide`, { method:'POST', body:JSON.stringify({ decision }) });
    toast(decision === 'approved' ? 'Procurement approved.' : 'Procurement declined.', 'success');
    loadOverview();
  } catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory
// ─────────────────────────────────────────────────────────────────────────────
let activeTagFilter = null;

function debouncedLoadInventory() { clearTimeout(searchTimer); searchTimer = setTimeout(loadInventory, 300); }

function populateFilterSelect(id, list, allLabel) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = `<option value="">${allLabel}</option>` + list.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  el.value = current;
}

function toggleSortDir() {
  invSortDir = invSortDir === 'asc' ? 'desc' : 'asc';
  document.getElementById('inv-sort-dir').textContent = invSortDir === 'asc' ? '↑' : '↓';
  loadInventory();
}

function filterByTag(tag) {
  activeTagFilter = tag;
  renderTagFilterChips();
  loadInventory();
}

function removeTagFilter() {
  activeTagFilter = null;
  renderTagFilterChips();
  loadInventory();
}

function renderTagFilterChips() {
  const wrap = document.getElementById('inv-tag-filters');
  if (!wrap) return;
  wrap.innerHTML = activeTagFilter
    ? `<span class="filter-tag-chip">#${esc(activeTagFilter)}<button onclick="removeTagFilter()" title="Remove filter">✕</button></span>`
    : '';
}

async function loadInventory() {
  populateFilterSelect('inv-filter-location', LOCATIONS, 'All locations');
  populateFilterSelect('inv-filter-category', CATEGORIES, 'All categories');
  const params = new URLSearchParams();
  const loc = document.getElementById('inv-filter-location').value;
  const cat = document.getElementById('inv-filter-category').value;
  const cond = document.getElementById('inv-filter-condition').value;
  const type = document.getElementById('inv-filter-type').value;
  const search = document.getElementById('inv-search').value.trim();
  const sortBy = document.getElementById('inv-sort').value;
  if (loc)    params.set('location', loc);
  if (cat)    params.set('category', cat);
  if (cond)   params.set('condition', cond);
  if (type)   params.set('trackingType', type);
  if (search) params.set('search', search);
  if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', invSortDir); }
  if (activeTagFilter) params.set('tag', activeTagFilter);
  try {
    const data = await api('/api/items?' + params.toString());
    ALL_ITEMS = data.items;
    document.getElementById('inv-count').textContent = `${data.items.length} item(s)`;
    renderInventoryTable();
    makeSortable('inventory-table', ALL_ITEMS, {
      name: i => i.name, qty: i => i.quantity || 0, cost: i => i.purchaseCost || 0
    }, renderInventoryTable);
    renderInventoryView();
    renderSearchSummary(search, data.summary, data.groups);
  } catch(err) { toast('Failed to load inventory: ' + err.message, 'error'); }
}

// At-a-glance total for the current search/filter — and, when the same
// item name shows up more than once (e.g. split across locations by a
// transfer, or two separate restocks), a per-name breakdown so it's clear
// at a glance how much of a given item exists in total.
function renderSearchSummary(search, summary, groups) {
  const host = document.getElementById('inv-search-summary');
  if (!host) return;
  if (!summary || !summary.totalCount) { host.innerHTML = ''; return; }
  const groupsHtml = (groups && groups.length) ? groups.map(g => `
    <div class="ss-group">
      <span class="ss-group-name">${esc(g.name)}</span>
      <span class="ss-group-meta">${g.count} record(s) across ${g.locations.length} location(s) · total ${g.totalQuantity} · ${fmtMoney(g.totalValue)}</span>
    </div>`).join('') : '';
  host.innerHTML = `<div class="search-summary">
    <div class="ss-totals">${search ? `Matching “${esc(search)}”: ` : ''}${summary.totalCount} item(s) · total quantity ${summary.totalQuantity} · total value ${fmtMoney(summary.totalValue)}</div>
    ${groupsHtml}
  </div>`;
}
function renderInventoryTable() {
  const tbody = document.querySelector('#inventory-table tbody');
  tbody.innerHTML = ALL_ITEMS.length ? ALL_ITEMS.map(i => `
    <tr style="cursor:pointer;" onclick="openItem('${i.id}')">
      <td>${itemThumbHtml(i)}</td>
      <td><div style="font-weight:600;">${esc(i.name)} ${itemCodeBadge(i)}</div>${i.modelNumber?`<div class="muted" style="font-size:11.5px;">${esc(i.modelNumber)}</div>`:''}</td>
      <td>${esc(i.categoryName||'—')}</td>
      <td><span class="badge badge-${i.trackingType}">${titleCase(i.trackingType)}</span></td>
      <td class="mono">${esc(i.assetTag||i.serialNumber||'—')}</td>
      <td>${esc(i.locationName||'—')}</td>
      <td>${fmtQty(i)}</td>
      <td>${unitPriceCell(i)}</td>
      <td>${statusBadge(i.condition)}</td>
      <td>${renderTagBadges(i.tags)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openItem('${i.id}')">View</button></td>
    </tr>`).join('') : `<tr><td colspan="11" class="empty-state" style="padding:30px;">No items match these filters.</td></tr>`;
}

// Per-unit price shown alongside quantity everywhere the inventory list
// appears — kept clearly distinct from the row's total value (unit × qty)
// so it's never ambiguous which figure is which at a glance or on export.
function unitPriceCell(i) {
  if (i.purchaseCost == null) return '<span class="muted">—</span>';
  return `<div>${fmtMoney(i.purchaseCost)}<span class="muted" style="font-size:11px;"> /${esc(i.unit||'unit')}</span></div><div class="muted" style="font-size:11px;">Total: ${fmtMoney(+(i.purchaseCost*(i.quantity||1)).toFixed(2))}</div>`;
}

// Unique, immutable per-row identifier — shown next to the item name in
// every view so two rows sharing a name (split via transfer, restocked via
// procurement, etc.) can always be told apart at a glance.
function itemCodeBadge(i) {
  if (!i.itemCode) return '';
  return `<span class="badge badge-code" title="Unique inventory code — stays with this record through transfers and restocks">${esc(i.itemCode)}</span>`;
}

function renderTagBadges(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return tags.map(t => `<span class="badge badge-tag" style="cursor:pointer;" onclick="event.stopPropagation();filterByTag('${esc(t)}')">#${esc(t)}</span>`).join(' ');
}

function itemThumbHtml(i) {
  if (i.hasPhoto) return `<img class="item-thumb" src="/api/images/item/${i.id}?t=${Date.now()}" loading="lazy">`;
  return `<div class="item-thumb-ph"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7 12 3 4 7v10l8 4 8-4V7Z"/></svg></div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scraps — disposed goods, valued and revalued separately from live
// inventory. View/interact both gated server-side by scrap access.
// ─────────────────────────────────────────────────────────────────────────────
async function loadScraps() {
  try {
    const data = await api('/api/scraps');
    document.getElementById('scrap-count').textContent = data.summary.count;
    document.getElementById('scrap-original-value').textContent = fmtMoney(data.summary.totalOriginalValue);
    document.getElementById('scrap-current-value').textContent = fmtMoney(data.summary.totalCurrentValue);
    const tbody = document.querySelector('#scraps-table tbody');
    tbody.innerHTML = data.scraps.length ? data.scraps.map(s => `
      <tr>
        <td><div style="font-weight:600;">${esc(s.name)} ${s.itemCode ? `<span class="badge badge-code">${esc(s.itemCode)}</span>` : ''}</div></td>
        <td>${esc(s.categoryName||'—')}</td>
        <td>${esc(s.locationName||'—')}</td>
        <td>${s.quantity ?? '—'} ${esc(s.unit||'')}</td>
        <td>${fmtDate(s.disposedAt)}<div class="muted" style="font-size:11px;">by ${esc(s.disposedByName||'—')}</div></td>
        <td>${fmtMoney(s.originalValue)}</td>
        <td>${ME.role === 'admin'
          ? `<input type="number" min="0" step="0.01" class="select scrap-value-input" value="${s.depreciatedValue ?? ''}" placeholder="${s.originalValue}" onchange="submitScrapValue('${s.id}', this.value)">`
          : (s.depreciatedValue != null ? fmtMoney(s.depreciatedValue) : '—')}
          ${s.revaluedAt ? `<div class="muted" style="font-size:11px;">Revalued ${fmtDate(s.revaluedAt)}</div>` : ''}
        </td>
        <td>${s.hasBill
            ? `<button class="btn btn-ghost btn-xs" onclick="viewScrapBill('${s.id}','${esc(s.billFilename||'bill')}')">📄 View</button>`
            : `<label class="btn btn-ghost btn-xs" style="cursor:pointer;">📎 Upload<input type="file" accept="image/*,application/pdf" style="display:none;" onchange="uploadScrapBill('${s.id}',this)"></label>`}
        </td>
        <td>${ME.role === 'admin' ? `<button class="btn btn-ghost btn-xs" title="Remove from scraps — restores the item to active inventory" onclick="removeScrapItem('${s.id}','${esc(s.name)}')">↩ Restore</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty-state" style="padding:30px;">No disposed items yet.</td></tr>';
  } catch(err) { toast('Failed to load scraps: ' + err.message, 'error'); }
}

async function submitScrapValue(id, value) {
  try {
    await api(`/api/scraps/${id}`, { method:'PATCH', body:JSON.stringify({ depreciatedValue: value === '' ? null : Number(value) }) });
    toast('Scrap value updated.', 'success');
    loadScraps();
  } catch(err) { toast(err.message, 'error'); loadScraps(); }
}

async function uploadScrapBill(id, input) {
  const rawFile = input.files[0];
  if (!rawFile) return;
  const file = await compressImageFile(rawFile);
  const fd = new FormData();
  fd.append('bill', file);
  try {
    await api(`/api/scraps/${id}/bill`, { method:'POST', body: fd });
    toast('Bill uploaded.', 'success');
    loadScraps();
  } catch(err) { toast(err.message, 'error'); }
}

function viewScrapBill(id, filename) {
  const url = `/api/images/scrap/${id}/bill?t=${Date.now()}`;
  openBillViewer(url, filename, () => deleteScrapBill(id));
}

async function deleteScrapBill(id) {
  const ok = await confirmDialog({ title:'Remove this bill?', message:'The bill/receipt will be permanently deleted. The scrap record itself is unaffected.', confirmText:'Remove', type:'danger' });
  if (!ok) return;
  try {
    await api(`/api/scraps/${id}/bill`, { method:'DELETE' });
    toast('Bill removed.', 'success');
    closeModal('bill-viewer-modal');
    loadScraps();
  } catch(err) { toast(err.message, 'error'); }
}

async function removeScrapItem(id, name) {
  const ok = await confirmDialog({
    title: `Restore "${name}"?`,
    message: 'This removes it from the scrap list and returns it to active inventory with its condition just before disposal.',
    confirmText: 'Restore item',
    type: 'info'
  });
  if (!ok) return;
  try {
    await api(`/api/scraps/${id}`, { method:'DELETE' });
    toast('Removed from scraps — item restored to active inventory.', 'success');
    loadScraps();
  } catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Item detail
// ─────────────────────────────────────────────────────────────────────────────
async function openItem(id) {
  try {
    const data = await api('/api/items/' + id);
    CURRENT_ITEM = data.item;
    showView('item');
    const i = CURRENT_ITEM;
    document.getElementById('item-name').innerHTML = `${esc(i.name)} ${itemCodeBadge(i)}`;
    document.getElementById('item-sub').textContent = `${i.locationName||'Unassigned'} · ${fmtQty(i)}`;
    document.getElementById('item-badges').innerHTML = `${statusBadge(i.condition)} ${statusBadge(i.trackingType)} ${i.trackingType === 'stock' ? `<span class="badge badge-tag" title="Which batch gets issued first when stock is used or transferred">${(i.stockingMethod||'fifo').toUpperCase()}</span>` : ''}`;
    document.getElementById('item-tags-display').innerHTML = i.tags?.length ? `<div style="margin-top:4px;">${renderTagBadges(i.tags)}</div>` : '';
    // Photo
    const photoWrap = document.getElementById('item-photo-wrap');
    const removeBtn = document.getElementById('item-remove-photo-btn');
    if (i.hasPhoto) {
      photoWrap.innerHTML = `<div style="width:90px;height:90px;border-radius:14px;background:var(--surface-soft);display:flex;align-items:center;justify-content:center;overflow:hidden;"><img src="/api/images/item/${i.id}?t=${Date.now()}" style="width:100%;height:100%;object-fit:contain;object-position:center;"></div>`;
      if (removeBtn) removeBtn.style.display = 'inline-flex';
    } else {
      photoWrap.innerHTML = `<div style="width:90px;height:90px;border-radius:14px;background:var(--surface-soft);display:flex;align-items:center;justify-content:center;color:var(--muted);">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 7 12 3 4 7v10l8 4 8-4V7Z"/></svg></div>`;
      if (removeBtn) removeBtn.style.display = 'none';
    }
    const disposeBtn = document.getElementById('item-dispose-btn');
    if (disposeBtn) disposeBtn.style.display = i.condition === 'disposed' ? 'none' : '';
    // Info list with all new fields
    document.getElementById('item-info').innerHTML = [
      ['Item code',       `<span class="mono">${esc(i.itemCode||'—')}</span>`],
      ['Category',        i.categoryName||'—'],
      ['Location',        i.locationName||'—'],
      ['Asset tag',       i.assetTag||'—'],
      ['Serial number',   i.serialNumber||'—'],
      ['Model number',    i.modelNumber||'—'],
      ['Manufacturer',    i.manufacturer||'—'],
      ['Color',           i.color||'—'],
      ['Dimensions',      i.dimensions||'—'],
      ['Weight',          i.weight||'—'],
      ['Purchase date',   fmtDate(i.purchaseDate) + (i.purchaseDateMiti ? ` <span class="muted">(${i.purchaseDateMiti} BS)</span>` : '')],
      ['Unit cost',        i.purchaseCost != null ? `${fmtMoney(i.purchaseCost)} / ${i.unit||'unit'}` : '—'],
      ['Total value',      i.purchaseCost != null ? fmtMoney(+(i.purchaseCost * (i.quantity||1)).toFixed(2)) : '—'],
      ['Vendor',          i.vendorName||'—'],
      ['Warranty expiry', fmtDate(i.warrantyExpiry) + (i.warrantyExpiryMiti ? ` <span class="muted">(${i.warrantyExpiryMiti} BS)</span>` : '')],
      ['Min stock level', i.minStockLevel != null ? `${i.minStockLevel} ${i.unit||''}`.trim() : '—'],
      ['Notes',           esc(i.notes||'—')],
      ['Added on',        fmtDate(i.createdAt)]
    ].map(([k,v]) => `<div class="info-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
    // History
    document.getElementById('item-history').innerHTML = data.history?.length ? data.history.map(h => `
      <div style="padding:10px 0;border-bottom:1px solid var(--line-soft);">
        <div style="font-size:13px;">${esc(h.text)}</div>
        <div class="muted" style="font-size:11px;margin-top:2px;">${h.miti?h.miti+' BS · ':''}${fmtDateTime(h.date)} · ${esc(h.by||'System')}</div>
      </div>`).join('') : '<div class="empty-state">No history yet.</div>';
    document.getElementById('page-title').textContent = i.name;
    document.getElementById('page-sub').textContent = i.categoryName||'';
    // Reset tabs to Activity Log; show Stock Batches tab only for stock items
    document.querySelectorAll('#view-item .section-tabs .stab').forEach(t => t.classList.remove('active'));
    document.querySelector('#view-item .section-tabs .stab')?.classList.add('active');
    document.getElementById('item-history').classList.remove('hidden');
    document.getElementById('item-purchases').classList.add('hidden');
    document.getElementById('item-batches').classList.add('hidden');
    const batchesTab = document.getElementById('item-batches-tab');
    if (batchesTab) batchesTab.classList.toggle('hidden', i.trackingType !== 'stock');
    applyRoleVisibility();
  } catch(err) { toast('Could not load item: ' + err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Item detail tabs — Activity Log / Purchase History / Stock Batches (FIFO/LIFO)
// ─────────────────────────────────────────────────────────────────────────────
async function setItemTab(tab) {
  document.querySelectorAll('#view-item .section-tabs .stab').forEach(t => t.classList.remove('active'));
  const map = { history:0, purchases:1, batches:2 };
  document.querySelectorAll('#view-item .section-tabs .stab')[map[tab]]?.classList.add('active');
  ['history','purchases','batches'].forEach(t => document.getElementById('item-' + t).classList.toggle('hidden', t !== tab));
  if (!CURRENT_ITEM) return;
  if (tab === 'purchases') await loadItemPurchaseHistory();
  if (tab === 'batches')   await loadItemStockBatches();
}

async function loadItemPurchaseHistory() {
  const host = document.getElementById('item-purchases');
  host.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const data = await api(`/api/items/${CURRENT_ITEM.id}/purchase-history`);
    const logs = data.logs || [];
    if (!logs.length) { host.innerHTML = '<div class="empty-state">No purchase records yet. Purchases are logged automatically when procurement is received into inventory.</div>'; return; }
    host.innerHTML = `<div class="alert-banner info" style="margin-bottom:14px;">
      <span class="ab-icon">🛡</span>
      <div>This is a permanent, unchangeable record — every purchase kept with its bill for accountability, even if the item itself is later edited or removed.</div>
    </div>` + logs.map(l => `
      <div style="padding:12px 0;border-bottom:1px solid var(--line-soft);display:flex;gap:12px;align-items:flex-start;">
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:600;">${l.quantity} ${esc(l.unit||'')} received ${l.unitCost != null ? '@ ' + fmtMoney(l.unitCost) + ' each' : ''}</div>
          <div class="muted" style="font-size:11.5px;margin-top:2px;">${fmtDateTime(l.receivedAt)} · by ${esc(l.receivedByName||'—')} ${l.vendorName ? '· from ' + esc(l.vendorName) : ''} ${l.locationName ? '· to ' + esc(l.locationName) : ''}</div>
          ${l.totalCost != null ? `<div style="font-size:12.5px;margin-top:3px;font-weight:600;color:var(--navy-700);">Total: ${fmtMoney(l.totalCost)}</div>` : ''}
        </div>
        ${l.billPath ? `<button class="btn btn-ghost btn-xs" onclick="viewPurchaseLogBill('${l.id}','${esc(l.billFilename||'bill')}')">📄 View bill</button>` : '<span class="muted" style="font-size:11.5px;">No bill</span>'}
      </div>`).join('');
  } catch(err) { host.innerHTML = `<div class="empty-state">Could not load purchase history: ${esc(err.message)}</div>`; }
}

function viewPurchaseLogBill(id, filename) {
  const url = `/api/images/purchase-log/${id}/bill?t=${Date.now()}`;
  openBillViewer(url, filename, null); // purchase log bills are permanent — cannot be deleted
}

async function loadItemStockBatches() {
  const host = document.getElementById('item-batches');
  host.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const data = await api(`/api/items/${CURRENT_ITEM.id}/stock-batches`);
    const method = data.method || 'fifo';
    const rows = data.batches || [];
    let html = `<div class="flex between center" style="margin-bottom:12px;">
      <span class="badge badge-tag" style="text-transform:uppercase;">${method}</span>
      <span class="muted" style="font-size:12px;">${method === 'fifo' ? 'First received, first issued' : 'Last received, first issued'}</span>
    </div>`;
    html += rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Received</th><th>Qty received</th><th>Remaining</th><th>Unit cost</th><th>Vendor</th><th>By</th></tr></thead>
      <tbody>${rows.map(b => `<tr>
        <td>${fmtDate(b.received_date)}</td>
        <td>${Number(b.quantity_received)}</td>
        <td><b>${Number(b.quantity_remaining)}</b></td>
        <td>${fmtMoney(b.unit_cost)}</td>
        <td>${esc(b.vendor_name||'—')}</td>
        <td>${esc(b.received_by_name||'—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty-state">No active stock batches. All received stock has been fully issued.</div>';
    host.innerHTML = html;
  } catch(err) { host.innerHTML = `<div class="empty-state">Could not load stock batches: ${esc(err.message)}</div>`; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory view modes — list / grid / compact
// ─────────────────────────────────────────────────────────────────────────────
let INV_VIEW = 'list';
function setInvView(mode) {
  INV_VIEW = mode;
  ['list','grid','compact'].forEach(m => document.getElementById('vt-' + m)?.classList.toggle('active', m === mode));
  document.getElementById('inv-list-wrap').classList.toggle('hidden', mode !== 'list');
  document.getElementById('inv-grid-wrap').classList.toggle('hidden', mode !== 'grid');
  document.getElementById('inv-compact-wrap').classList.toggle('hidden', mode !== 'compact');
  renderInventoryView();
}

function renderInventoryView() {
  const items = ALL_ITEMS;
  if (INV_VIEW === 'grid') {
    document.getElementById('inv-grid-wrap').innerHTML = items.length ? items.map(i => `
      <div class="inv-grid-card" onclick="openItem('${i.id}')">
        ${i.hasPhoto ? `<img class="card-img" src="/api/images/item/${i.id}?t=${Date.now()}" loading="lazy">` : `<div class="card-img-ph"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 7 12 3 4 7v10l8 4 8-4V7Z"/></svg></div>`}
        <div class="card-body">
          <div class="card-name">${esc(i.name)} ${itemCodeBadge(i)}</div>
          <div class="card-sub">${esc(i.categoryName||'Uncategorized')} · ${esc(i.locationName||'Unassigned')}</div>
          ${i.purchaseCost != null ? `<div class="muted" style="font-size:11.5px;margin-top:2px;">${fmtMoney(i.purchaseCost)}/${esc(i.unit||'unit')} · Total ${fmtMoney(+(i.purchaseCost*(i.quantity||1)).toFixed(2))}</div>` : ''}
          <div class="card-foot">
            ${statusBadge(i.condition)}
            <span class="card-qty">${fmtQty(i)}</span>
          </div>
        </div>
      </div>`).join('') : '<div class="empty-state" style="grid-column:1/-1;padding:30px;">No items match these filters.</div>';
  } else if (INV_VIEW === 'compact') {
    document.getElementById('inv-compact-wrap').innerHTML = items.length ? items.map(i => `
      <div class="flex between center" style="padding:9px 14px;border-bottom:1px solid var(--line-soft);cursor:pointer;" onclick="openItem('${i.id}')">
        <div class="flex center gap-8" style="min-width:0;">
          ${itemThumbHtml(i)}
          <span style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(i.name)}</span>
          ${itemCodeBadge(i)}
          <span class="muted" style="font-size:11.5px;white-space:nowrap;">${esc(i.locationName||'—')}</span>
        </div>
        <div class="flex center gap-8" style="flex-shrink:0;">
          ${i.purchaseCost != null ? `<span class="muted" style="font-size:11.5px;white-space:nowrap;">${fmtMoney(i.purchaseCost)}/${esc(i.unit||'unit')}</span>` : ''}
          <span style="font-size:12px;color:var(--muted);">${fmtQty(i)}</span>
          ${statusBadge(i.condition)}
        </div>
      </div>`).join('') : '<div class="empty-state" style="padding:30px;">No items match these filters.</div>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Add / Edit Item
// ─────────────────────────────────────────────────────────────────────────────
function populateSelect(id, list, placeholder, selected) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : '') +
    list.map(x => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

// Same as populateSelect, but for pickers where the user is choosing an
// INVENTORY ITEM specifically (restock, transfer, repair). Several rows can
// share the same name (two "Badminton Racket" rows, a name split across
// locations by a transfer, etc.), so the label always includes the item
// code and location to make clear exactly which record is being picked.
function itemPickerLabel(x) {
  const bits = [];
  if (x.itemCode) bits.push(x.itemCode);
  if (x.locationName) bits.push(x.locationName);
  return bits.length ? `${x.name} — ${bits.join(' · ')}` : x.name;
}
function populateItemSelect(id, list, placeholder, selected) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : '') +
    list.map(x => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(itemPickerLabel(x))}</option>`).join('');
}

function updateItemCostPreview() {
  const cost = Number(document.getElementById('im-cost').value) || 0;
  const qty  = Number(document.getElementById('im-quantity').value) || 0;
  const el = document.getElementById('im-cost-preview');
  if (!el) return;
  el.textContent = cost > 0 ? `Total value for this record: ${fmtMoney(+(cost * (qty || 1)).toFixed(2))} (unit cost × quantity)` : '\u00A0';
}

function toggleTrackingFields() {
  const t = document.getElementById('im-tracking').value;
  document.getElementById('im-asset-fields').style.display = t !== 'asset' ? 'none' : '';
  document.getElementById('im-stock-fields').style.display = t !== 'stock' ? 'none' : '';
}

function openAddItem() {
  document.getElementById('item-modal-title').textContent = 'Add an item to inventory';
  document.getElementById('im-id').value = '';
  document.getElementById('im-code-field').classList.add('hidden');
  ['im-name','im-tag','im-serial','im-model','im-manufacturer','im-color','im-dimensions','im-weight','im-unit','im-notes'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('im-quantity').value = 1;
  document.getElementById('im-minstock').value = '';
  document.getElementById('im-reorder-qty').value = '';
  document.getElementById('im-stocking-method').value = 'fifo';
  document.getElementById('im-cost').value = '';
  document.getElementById('im-purchase-date').value = '';
  document.getElementById('im-warranty').value = '';
  document.getElementById('im-tracking').value = 'asset';
  document.getElementById('im-condition').value = 'new';
  populateSelect('im-category', CATEGORIES, '— Select category —');
  populateSelect('im-location', LOCATIONS, '— Select location —');
  populateSelect('im-department', DEPARTMENTS, '— Inherit from location —');
  populateSelect('im-vendor', VENDORS, '—');
  toggleTrackingFields();
  TAGS_INPUT = buildTagsInput('im-tags-input', []);
  updateItemCostPreview();
  document.getElementById('item-modal').classList.remove('hidden');
}

function openEditItem() {
  const i = CURRENT_ITEM;
  document.getElementById('item-modal-title').textContent = 'Edit item';
  document.getElementById('im-id').value = i.id;
  const codeField = document.getElementById('im-code-field');
  if (i.itemCode) { codeField.classList.remove('hidden'); document.getElementById('im-code').value = i.itemCode; }
  else codeField.classList.add('hidden');
  document.getElementById('im-name').value = i.name;
  document.getElementById('im-tag').value = i.assetTag||'';
  document.getElementById('im-serial').value = i.serialNumber||'';
  document.getElementById('im-model').value = i.modelNumber||'';
  document.getElementById('im-manufacturer').value = i.manufacturer||'';
  document.getElementById('im-color').value = i.color||'';
  document.getElementById('im-dimensions').value = i.dimensions||'';
  document.getElementById('im-weight').value = i.weight||'';
  document.getElementById('im-quantity').value = i.quantity;
  document.getElementById('im-unit').value = i.unit||'';
  document.getElementById('im-minstock').value = i.minStockLevel??'';
  document.getElementById('im-reorder-qty').value = i.reorderQty??'';
  document.getElementById('im-stocking-method').value = i.stockingMethod||'fifo';
  document.getElementById('im-condition').value = i.condition;
  document.getElementById('im-purchase-date').value = i.purchaseDate||'';
  document.getElementById('im-cost').value = i.purchaseCost??'';
  document.getElementById('im-warranty').value = i.warrantyExpiry||'';
  document.getElementById('im-notes').value = i.notes||'';
  document.getElementById('im-tracking').value = i.trackingType;
  populateSelect('im-category', CATEGORIES, '— Select —', i.categoryId);
  populateSelect('im-location', LOCATIONS, '— Select —', i.locationId);
  populateSelect('im-department', DEPARTMENTS, '— Inherit —', i.departmentId);
  populateSelect('im-vendor', VENDORS, '—', i.vendorId);
  toggleTrackingFields();
  TAGS_INPUT = buildTagsInput('im-tags-input', i.tags||[]);
  updateItemCostPreview();
  document.getElementById('item-modal').classList.remove('hidden');
}

async function submitItem() {
  const id = document.getElementById('im-id').value;
  const payload = {
    name: document.getElementById('im-name').value.trim(),
    categoryId: document.getElementById('im-category').value,
    trackingType: document.getElementById('im-tracking').value,
    assetTag: document.getElementById('im-tag').value.trim(),
    serialNumber: document.getElementById('im-serial').value.trim(),
    modelNumber: document.getElementById('im-model').value.trim(),
    manufacturer: document.getElementById('im-manufacturer').value.trim(),
    color: document.getElementById('im-color').value.trim(),
    dimensions: document.getElementById('im-dimensions').value.trim(),
    weight: document.getElementById('im-weight').value.trim(),
    locationId: document.getElementById('im-location').value,
    departmentId: document.getElementById('im-department').value,
    quantity: document.getElementById('im-quantity').value,
    unit: document.getElementById('im-unit').value.trim(),
    minStockLevel: document.getElementById('im-minstock').value,
    reorderQty: document.getElementById('im-reorder-qty').value,
    stockingMethod: document.getElementById('im-stocking-method').value,
    condition: document.getElementById('im-condition').value,
    purchaseDate: document.getElementById('im-purchase-date').value,
    purchaseCost: document.getElementById('im-cost').value,
    vendorId: document.getElementById('im-vendor').value,
    warrantyExpiry: document.getElementById('im-warranty').value,
    notes: document.getElementById('im-notes').value.trim(),
    tags: TAGS_INPUT ? TAGS_INPUT.getTags() : []
  };
  if (!payload.name) { toast('Item name is required.', 'error'); return; }
  try {
    if (id) await api(`/api/items/${id}`, { method:'PATCH', body:JSON.stringify(payload) });
    else await api('/api/items', { method:'POST', body:JSON.stringify(payload) });
    toast('Item saved.', 'success');
    closeModal('item-modal');
    if (id) openItem(id);
    else loadInventory();
  } catch(err) { toast(err.message, 'error'); }
}

async function uploadItemPhoto() {
  const rawFile = document.getElementById('item-photo-input').files[0];
  if (!rawFile) return;
  const file = await compressImageFile(rawFile);
  const v = validateUploadFile(file, 'image');
  if (!v.ok) { toast(v.message, 'error', 5000); document.getElementById('item-photo-input').value = ''; return; }
  const fd = new FormData(); fd.append('image', file);
  try {
    const res = await fetch(`/api/items/${CURRENT_ITEM.id}/photo`, { method:'POST', body:fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('Photo updated.', 'success');
    openItem(CURRENT_ITEM.id);
  } catch(err) { toast(err.message, 'error'); }
  document.getElementById('item-photo-input').value = '';
}

async function removeItemPhoto() {
  const ok = await confirmDialog({ title:'Remove this photo?', message:'The item will show a placeholder icon instead.', confirmText:'Remove photo', type:'warning' });
  if (!ok) return;
  try {
    await api(`/api/items/${CURRENT_ITEM.id}/photo`, { method:'DELETE' });
    toast('Photo removed.', 'success');
    openItem(CURRENT_ITEM.id);
  } catch(err) { toast(err.message, 'error'); }
}

async function deleteItemConfirm() {
  const ok = await confirmDialog({ title:`Delete "${CURRENT_ITEM.name}"?`, message:'This permanently removes the item from inventory and cannot be undone.', confirmText:'Delete item', type:'danger' });
  if (!ok) return;
  try {
    await api(`/api/items/${CURRENT_ITEM.id}`, { method:'DELETE' });
    toast('Item deleted.', 'success');
    showView('inventory');
  } catch(err) { toast(err.message, 'error'); }
}

// Shortcut alongside Delete: mark the item disposed and move it to Scraps
// in one step, instead of opening the condition-log modal separately.
async function disposeItemConfirm() {
  const ok = await confirmDialog({
    title: `Dispose "${CURRENT_ITEM.name}"?`,
    message: 'This marks the item as disposed and moves it to the Scraps register, separate from live inventory. You can restore it from Scraps later if needed.',
    confirmText: 'Dispose item', type: 'danger'
  });
  if (!ok) return;
  try {
    await api(`/api/items/${CURRENT_ITEM.id}/dispose`, { method:'POST' });
    toast('Item disposed and moved to Scraps.', 'success');
    showView('inventory');
  } catch(err) { toast(err.message, 'error'); }
}

// Condition log
function openConditionModal() {
  document.getElementById('cond-new').value = CURRENT_ITEM.condition;
  document.getElementById('cond-note').value = '';
  document.getElementById('condition-modal').classList.remove('hidden');
}
async function submitCondition() {
  try {
    await api(`/api/items/${CURRENT_ITEM.id}/log-condition`, {
      method:'POST', body:JSON.stringify({ newCondition: document.getElementById('cond-new').value, note: document.getElementById('cond-note').value.trim() })
    });
    toast('Condition updated.', 'success');
    closeModal('condition-modal');
    openItem(CURRENT_ITEM.id);
  } catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfers
// ─────────────────────────────────────────────────────────────────────────────
async function openTransferModal(itemId) {
  try {
    const data = ME.hasFullDashboardAccess ? await api('/api/items') : await api('/api/my-location');
    TRANSFER_ITEMS = data.items;
    populateItemSelect('tr-item', data.items, '— Select item —', itemId);
    populateSelect('tr-location', LOCATIONS, '— Select destination —');
    document.getElementById('tr-qty').value = '';
    document.getElementById('tr-reason').value = '';
    onTransferItemChange();
    document.getElementById('transfer-modal').classList.remove('hidden');
  } catch(err) { toast(err.message, 'error'); }
}
function onTransferItemChange() {
  const id = document.getElementById('tr-item').value;
  const item = TRANSFER_ITEMS.find(i => i.id === id);
  document.getElementById('tr-qty-field').classList.toggle('hidden', !item || item.trackingType !== 'stock');
  if (item?.trackingType === 'stock') document.getElementById('tr-qty').max = item.quantity;
}
async function submitTransfer() {
  const itemId = document.getElementById('tr-item').value;
  const toLocationId = document.getElementById('tr-location').value;
  const quantity = document.getElementById('tr-qty').value;
  const reason = document.getElementById('tr-reason').value.trim();
  if (!itemId || !toLocationId) { toast('Choose an item and destination.', 'error'); return; }
  if (!reason) { toast('Please enter a reason.', 'error'); return; }
  try {
    await api('/api/transfers', { method:'POST', body:JSON.stringify({ itemId, toLocationId, quantity, reason }) });
    toast('Transfer request submitted.', 'success');
    closeModal('transfer-modal');
    if (!document.getElementById('view-transfers').classList.contains('hidden')) loadTransfers();
  } catch(err) { toast(err.message, 'error'); }
}
function setTransferFilter(status) {
  transferFilter = status;
  document.querySelectorAll('#transfers-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.status === status));
  loadTransfers();
}
let TRANSFERS_CACHE = [];
async function loadTransfers() {
  const params = new URLSearchParams();
  if (transferFilter) params.set('status', transferFilter);
  const from = document.getElementById('tr-filter-from').value;
  const to   = document.getElementById('tr-filter-to').value;
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  try {
    const data = await api('/api/transfers?' + params.toString());
    TRANSFERS_CACHE = data.transfers;
    renderTransfersTable();
    makeSortable('transfers-table', TRANSFERS_CACHE, {
      miti: t => t.createdAt, date: t => t.createdAt, item: t => t.itemName
    }, renderTransfersTable);
  } catch(err) { toast('Failed to load transfers: ' + err.message, 'error'); }
}
function renderTransfersTable() {
  const tbody = document.querySelector('#transfers-table tbody');
  tbody.innerHTML = TRANSFERS_CACHE.length ? TRANSFERS_CACHE.map(t => {
    const canDecide = ME.role === 'admin' && t.adminDecision === 'pending';
    return `<tr>
      <td class="mono">${t.createdAtMiti||'—'}</td>
      <td class="muted" style="font-size:12px;">${fmtDate(t.createdAt)}</td>
      <td><b>${esc(t.itemName)}</b></td>
      <td>${esc(t.fromLocationName||'—')}</td>
      <td>${esc(t.toLocationName||'—')}</td>
      <td>${t.quantity??'—'}</td>
      <td>${esc(t.requestedByName)}</td>
      <td style="max-width:180px;white-space:normal;">${esc(t.reason)}</td>
      <td>${statusBadge(t.managerDecision)}</td>
      <td>${statusBadge(t.adminDecision)}</td>
      <td>${statusBadge(t.status)}</td>
      <td>${canDecide ? `<div class="flex gap-8">
        <button class="btn btn-gold btn-sm" onclick="decideTransfer('${t.id}','approved')">Approve</button>
        <button class="btn btn-danger-ghost btn-sm" onclick="decideTransfer('${t.id}','rejected')">Decline</button>
      </div>` : ''}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="12" class="empty-state" style="padding:30px;">No transfer requests.</td></tr>`;
}
async function decideTransfer(id, decision) {
  const ok = await confirmDialog({ title: decision === 'approved' ? 'Approve this transfer?' : 'Decline this transfer?', message: decision === 'approved' ? 'The item will be moved to the destination location.' : 'The requester will be notified.', confirmText: decision === 'approved' ? 'Approve' : 'Decline', type: decision === 'approved' ? 'info' : 'danger' });
  if (!ok) return;
  try {
    await api(`/api/admin/transfers/${id}/decide`, { method:'POST', body:JSON.stringify({ decision }) });
    toast(decision === 'approved' ? 'Transfer approved.' : 'Transfer declined.', 'success');
    loadTransfers();
  } catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Procurement — cart-based with existing item restock
// ─────────────────────────────────────────────────────────────────────────────
async function openProcurementModal() {
  CART = [];
  PR_SOURCE = 'new';
  document.getElementById('pr-source-new').classList.add('active');
  document.getElementById('pr-source-restock').classList.remove('active');
  document.getElementById('pr-new-fields').classList.remove('hidden');
  document.getElementById('pr-restock-fields').classList.add('hidden');
  document.getElementById('pr-name').value = '';
  document.getElementById('pr-qty').value = 1;
  document.getElementById('pr-unit').value = '';
  document.getElementById('pr-cost').value = '';
  document.getElementById('pr-justification').value = '';
  updatePrCostPreview();
  populateSelect('pr-category', CATEGORIES, '—');
  populateSelect('pr-vendor', VENDORS, '—');
  // ALL_ITEMS is only populated once the Inventory view has loaded — fetch
  // fresh here too so the restock picker still shows items (with their
  // disambiguating code + location) even when opened before that.
  try {
    const itemsForRestock = ALL_ITEMS.length ? ALL_ITEMS : (await api('/api/items')).items;
    populateItemSelect('pr-existing-item', itemsForRestock, '— Choose item —');
  } catch { populateItemSelect('pr-existing-item', ALL_ITEMS, '— Choose item —'); }
  // Populate stocking plan link — only active annual/weekly plans make
  // sense here (petty cash has its own separate flow).
  try {
    const [a, w] = await Promise.all([
      api('/api/stocking-plans?planType=annual&status=active'),
      api('/api/stocking-plans?planType=weekly&status=active')
    ]);
    const plans = [...a.plans, ...w.plans].map(p => ({ id: p.id, name: `${p.title} (${titleCase(p.planType)}${p.budget != null ? ' · ' + fmtMoney(p.budget - p.spent) + ' left' : ''})` }));
    populateSelect('pr-stocking-plan', plans, '— Not linked to a plan —');
  } catch { populateSelect('pr-stocking-plan', [], '— Not linked to a plan —'); }
  renderCart();
  document.getElementById('procurement-modal').classList.remove('hidden');
}

function setProcurementSource(src) {
  PR_SOURCE = src;
  document.getElementById('pr-source-new').classList.toggle('active', src === 'new');
  document.getElementById('pr-source-restock').classList.toggle('active', src === 'restock');
  document.getElementById('pr-new-fields').classList.toggle('hidden', src !== 'new');
  document.getElementById('pr-restock-fields').classList.toggle('hidden', src !== 'restock');
}

function onExistingItemChange() {
  const id = document.getElementById('pr-existing-item').value;
  const item = ALL_ITEMS.find(i => i.id === id);
  if (item) {
    document.getElementById('pr-unit').value = item.unit||'';
    const catEl = document.getElementById('pr-category');
    if (item.categoryId) catEl.value = item.categoryId;
  }
}

function adjustPrQty(delta) {
  const inp = document.getElementById('pr-qty');
  const val = Math.max(1, (Number(inp.value)||1) + delta);
  inp.value = val;
  updatePrCostPreview();
}

function updatePrCostPreview() {
  const total = Number(document.getElementById('pr-cost').value) || 0;
  const qty = Number(document.getElementById('pr-qty').value) || 1;
  const el = document.getElementById('pr-cost-preview');
  if (!el) return;
  el.textContent = total > 0 ? `Unit cost: ${fmtMoney(+(total / qty).toFixed(2))} per ${document.getElementById('pr-unit').value.trim() || 'unit'}` : '\u00A0';
}

function addToCart() {
  let itemName, categoryId, isRestock = false, existingItemId = null;
  if (PR_SOURCE === 'restock') {
    existingItemId = document.getElementById('pr-existing-item').value;
    const item = ALL_ITEMS.find(i => i.id === existingItemId);
    if (!item) { toast('Choose an existing item to restock.', 'error'); return; }
    itemName = item.name;
    categoryId = item.categoryId;
    isRestock = true;
  } else {
    itemName = document.getElementById('pr-name').value.trim();
    categoryId = document.getElementById('pr-category').value;
    if (!itemName) { toast('Enter an item name.', 'error'); return; }
  }
  const restockItem = isRestock ? ALL_ITEMS.find(i => i.id === existingItemId) : null;
  const qty = Number(document.getElementById('pr-qty').value)||1;
  const unit = document.getElementById('pr-unit').value.trim();
  const cost = document.getElementById('pr-cost').value;
  const vendorId = document.getElementById('pr-vendor').value;
  const stockingPlanId = document.getElementById('pr-stocking-plan').value;
  CART.push({ itemName, categoryId, quantity: qty, unit, estimatedCost: cost ? Number(cost) : null, vendorId, isRestock, existingItemId, existingItemCode: restockItem?.itemCode || null, existingItemLocation: restockItem?.locationName || null, stockingPlanId: stockingPlanId || null });
  toast(`"${itemName}" added to cart.`, 'success');
  // Reset item fields (keep the plan selection — likely applies to the whole batch)
  document.getElementById('pr-name').value = '';
  document.getElementById('pr-qty').value = 1;
  document.getElementById('pr-cost').value = '';
  updatePrCostPreview();
  renderCart();
}

function renderCart() {
  const body = document.getElementById('pr-cart-body');
  document.getElementById('pr-cart-count').textContent = CART.length;
  if (!CART.length) { body.innerHTML = '<div class="cart-empty">No items added yet.</div>'; return; }
  body.innerHTML = CART.map((ci, idx) => `
    <div class="cart-item-row">
      <div style="flex:1;">
        <div class="cart-item-name">${esc(ci.itemName)} ${ci.isRestock ? '<span class="badge badge-tag" style="font-size:10px;">restock</span>' : ''}</div>
        <div class="cart-item-meta">${(CATEGORIES.find(c=>c.id===ci.categoryId)||{}).name||''} ${ci.isRestock ? `· ${[ci.existingItemCode, ci.existingItemLocation].filter(Boolean).join(' · ')}` : ''} ${ci.estimatedCost?`· Total Rs.${ci.estimatedCost} (Rs.${(ci.estimatedCost/(ci.quantity||1)).toFixed(2)}/unit)`:''} ${ci.stockingPlanId ? '· 📋 linked to plan' : ''}</div>
      </div>
      <div class="cart-item-qty">
        <button onclick="cartQty(${idx},-1)">−</button>
        <span class="qty-val">${ci.quantity}</span>
        <button onclick="cartQty(${idx},1)">+</button>
        <span style="font-size:12px;color:var(--muted);">${esc(ci.unit||'pcs')}</span>
      </div>
      <button class="btn btn-danger-ghost btn-xs" onclick="removeFromCart(${idx})">✕</button>
    </div>`).join('');
}

function cartQty(idx, delta) {
  CART[idx].quantity = Math.max(1, CART[idx].quantity + delta);
  renderCart();
}
function removeFromCart(idx) { CART.splice(idx, 1); renderCart(); }
function clearCart() { CART = []; renderCart(); }

async function submitProcurement() {
  const justification = document.getElementById('pr-justification').value.trim();
  if (!justification) { toast('Please enter a justification.', 'error'); return; }
  // If cart is empty but user has filled in fields, auto-add
  if (!CART.length) {
    const name = document.getElementById('pr-name').value.trim();
    if (name || PR_SOURCE === 'restock') {
      addToCart();
      if (!CART.length) return;
    } else {
      toast('Add at least one item to the cart first.', 'error'); return;
    }
  }
  try {
    if (CART.length === 1) {
      const ci = CART[0];
      await api('/api/procurement', { method:'POST', body:JSON.stringify({ ...ci, justification }) });
    } else {
      await api('/api/procurement/batch', { method:'POST', body:JSON.stringify({ items:CART, justification }) });
    }
    toast(`${CART.length} procurement request${CART.length>1?'s':''} submitted.`, 'success');
    closeModal('procurement-modal');
    if (!document.getElementById('view-procurement').classList.contains('hidden')) loadProcurement();
  } catch(err) { toast(err.message, 'error'); }
}

function setProcurementFilter(status) {
  procurementFilter = status;
  document.querySelectorAll('#procurement-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.status === status));
  loadProcurement();
}

let PROCUREMENT_CACHE = [];
let STOCKING_PLANS_LOOKUP = {}; // id -> plan object, populated lazily
async function ensureStockingPlansLookup() {
  if (Object.keys(STOCKING_PLANS_LOOKUP).length) return STOCKING_PLANS_LOOKUP;
  try {
    const [a, w, p] = await Promise.all([
      api('/api/stocking-plans?planType=annual&status='),
      api('/api/stocking-plans?planType=weekly&status='),
      api('/api/stocking-plans?planType=petty&status=')
    ]);
    [...a.plans, ...w.plans, ...p.plans].forEach(pl => { STOCKING_PLANS_LOOKUP[pl.id] = pl; });
  } catch {}
  return STOCKING_PLANS_LOOKUP;
}

async function loadProcurement() {
  const params = new URLSearchParams();
  if (procurementFilter) params.set('status', procurementFilter);
  const from = document.getElementById('pr-filter-from').value;
  const to   = document.getElementById('pr-filter-to').value;
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  try {
    await ensureStockingPlansLookup();
    const data = await api('/api/procurement?' + params.toString());
    PROCUREMENT_CACHE = data.requests;
    renderProcurementTable();
    makeSortable('procurement-table', PROCUREMENT_CACHE, {
      miti: p => p.createdAt, date: p => p.createdAt, item: p => p.itemName, cost: p => p.estimatedCost || 0
    }, renderProcurementTable);
  } catch(err) { toast('Failed to load procurement: ' + err.message, 'error'); }
}
function renderProcurementTable() {
  const tbody = document.querySelector('#procurement-table tbody');
  tbody.innerHTML = PROCUREMENT_CACHE.length ? PROCUREMENT_CACHE.map(p => {
    const canDecide  = ME.role === 'admin' && p.adminDecision === 'pending';
    const canReceive = ME.role === 'admin' && p.status === 'approved' && !p.receivedItemId;
    const plan = p.stockingPlanId ? STOCKING_PLANS_LOOKUP[p.stockingPlanId] : null;
    return `<tr>
      <td class="mono">${p.createdAtMiti||'—'}</td>
      <td class="muted" style="font-size:12px;">${fmtDate(p.createdAt)}</td>
      <td><b>${esc(p.itemName)}</b>${plan ? `<div class="muted" style="font-size:11px;margin-top:2px;cursor:pointer;" onclick="event.stopPropagation();openPlanDetail('${plan.id}')">📋 ${esc(plan.title)}</div>` : ''}</td>
      <td>${p.quantity} ${esc(p.unit||'')}</td>
      <td>${fmtMoney(p.estimatedCost)}</td>
      <td>${p.isRestock ? '<span class="badge badge-tag">Restock</span>' : '<span class="badge badge-info">New</span>'}</td>
      <td>${esc(p.requestedByName)}</td>
      <td>${p.hasBill ? `<button class="btn btn-ghost btn-xs" onclick="viewBill('${p.id}','${esc(p.billFilename||'bill')}')">📄 View</button>` : '<span class="muted" style="font-size:12px;">None</span>'}</td>
      <td>${statusBadge(p.managerDecision)}</td>
      <td>${statusBadge(p.adminDecision)}</td>
      <td>${statusBadge(p.status)}${p.receivedItemId ? ' <span class="badge badge-completed">Received</span>' : ''}</td>
      <td>
        ${canDecide ? `<div class="flex gap-8">
          <button class="btn btn-gold btn-sm" onclick="decideProcurement('${p.id}','approved')">Approve</button>
          <button class="btn btn-danger-ghost btn-sm" onclick="decideProcurement('${p.id}','rejected')">Decline</button>
        </div>` : ''}
        ${canReceive ? `<button class="btn btn-primary btn-sm" onclick="openReceiveModal('${p.id}','${esc(p.itemName)}','${p.isRestock?1:0}','${p.existingItemId||''}')">Receive</button>` : ''}
        ${!p.hasBill && (ME.role==='admin'||p.requestedById===ME.id) ? `<label class="btn btn-ghost btn-xs" style="cursor:pointer;margin-left:4px;">📎 Bill<input type="file" accept="image/*,application/pdf" style="display:none;" onchange="uploadBill('${p.id}',this)"></label>` : ''}
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="12" class="empty-state" style="padding:30px;">No procurement requests.</td></tr>`;
}

async function uploadBill(prId, input) {
  const rawFile = input.files[0];
  if (!rawFile) return;
  const file = await compressImageFile(rawFile);
  const v = validateUploadFile(file, 'doc');
  if (!v.ok) { toast(v.message, 'error', 5000); input.value = ''; return; }
  const fd = new FormData(); fd.append('bill', file);
  try {
    const res = await fetch(`/api/procurement/${prId}/bill`, { method:'POST', body:fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('Bill uploaded.', 'success');
    loadProcurement();
  } catch(err) { toast(err.message, 'error'); }
  input.value = '';
}

function viewBill(prId, filename) {
  CURRENT_BILL_PR_ID = prId;
  const url = `/api/images/procurement/${prId}/bill?t=${Date.now()}`;
  openBillViewer(url, filename, (ME.role === 'admin') ? deleteProcurementBill : null);
}

async function deleteProcurementBill() {
  const ok = await confirmDialog({ title:'Remove this bill?', message:'The bill/receipt will be permanently deleted.', confirmText:'Remove', type:'danger' });
  if (!ok || !CURRENT_BILL_PR_ID) return;
  try {
    await api(`/api/procurement/${CURRENT_BILL_PR_ID}/bill`, { method:'DELETE' });
    toast('Bill removed.', 'success');
    closeModal('bill-viewer-modal');
    loadProcurement();
  } catch(err) { toast(err.message, 'error'); }
}

async function decideProcurement(id, decision) {
  const ok = await confirmDialog({ title: decision === 'approved' ? 'Approve this procurement request?' : 'Decline this procurement request?', confirmText: decision === 'approved' ? 'Approve' : 'Decline', type: decision === 'approved' ? 'info' : 'danger' });
  if (!ok) return;
  try {
    await api(`/api/admin/procurement/${id}/decide`, { method:'POST', body:JSON.stringify({ decision }) });
    toast(decision === 'approved' ? 'Request approved.' : 'Request declined.', 'success');
    loadProcurement();
  } catch(err) { toast(err.message, 'error'); }
}

function openReceiveModal(id, itemName, isRestock, existingItemId) {
  RECEIVE_PR_ID = id;
  RECEIVE_IS_RESTOCK = isRestock === '1' || isRestock === 1 || isRestock === true;
  RC_BILL_FILE = null;
  RC_PHOTO_FILE = null;
  document.getElementById('receive-sub').textContent = `"${itemName}" — choose the location where it was received.`;
  populateSelect('rc-location', LOCATIONS, '— Select location —');
  document.getElementById('rc-tag').value = '';
  document.getElementById('rc-serial').value = '';
  document.getElementById('rc-condition').value = 'new';
  document.getElementById('rc-bill-input').value = '';
  document.getElementById('rc-bill-preview').classList.add('hidden');
  document.getElementById('rc-photo-input').value = '';
  document.getElementById('rc-photo-preview').classList.add('hidden');
  // Extra detail fields (model, manufacturer, tags, etc.) only make sense
  // for a brand-new item — a restock adds quantity to an item that already
  // has these set, so there's nothing meaningful to fill in here.
  document.getElementById('rc-photo-field').classList.toggle('hidden', RECEIVE_IS_RESTOCK);
  document.getElementById('rc-details-toggle-row').classList.toggle('hidden', RECEIVE_IS_RESTOCK);
  document.getElementById('rc-details-fields').classList.add('hidden');
  document.getElementById('rc-details-toggle-label').textContent = '+ Add more details (model, manufacturer, tags…)';
  document.getElementById('rc-model').value = '';
  document.getElementById('rc-manufacturer').value = '';
  document.getElementById('rc-color').value = '';
  document.getElementById('rc-dimensions').value = '';
  document.getElementById('rc-weight').value = '';
  document.getElementById('rc-minstock').value = '';
  document.getElementById('rc-reorder-qty').value = '';
  document.getElementById('rc-warranty').value = '';
  document.getElementById('rc-notes').value = '';
  RC_TAGS_INPUT = buildTagsInput('rc-tags-input', []);
  document.getElementById('receive-modal').classList.remove('hidden');
}

let RC_BILL_FILE = null;
let RC_PHOTO_FILE = null;
let RECEIVE_IS_RESTOCK = false;
let RC_TAGS_INPUT = null;

function toggleReceiveDetails() {
  const fields = document.getElementById('rc-details-fields');
  const nowHidden = fields.classList.toggle('hidden');
  document.getElementById('rc-details-toggle-label').textContent = nowHidden
    ? '+ Add more details (model, manufacturer, tags…)'
    : '− Hide additional details';
}

async function onReceivePhotoChange() {
  const input = document.getElementById('rc-photo-input');
  const rawFile = input.files[0];
  const preview = document.getElementById('rc-photo-preview');
  if (rawFile) {
    const file = await compressImageFile(rawFile);
    const v = validateUploadFile(file, 'image');
    if (!v.ok) { toast(v.message, 'error', 5000); input.value = ''; RC_PHOTO_FILE = null; return; }
    RC_PHOTO_FILE = file;
    document.getElementById('rc-photo-name').textContent = file.name;
    preview.classList.remove('hidden');
    document.getElementById('rc-photo-upload-area').classList.add('has-file');
  }
}
function clearReceivePhoto() {
  RC_PHOTO_FILE = null;
  document.getElementById('rc-photo-input').value = '';
  document.getElementById('rc-photo-preview').classList.add('hidden');
  document.getElementById('rc-photo-upload-area').classList.remove('has-file');
}

async function onReceiveBillChange() {
  const input = document.getElementById('rc-bill-input');
  const rawFile = input.files[0];
  const preview = document.getElementById('rc-bill-preview');
  if (rawFile) {
    const file = await compressImageFile(rawFile);
    const v = validateUploadFile(file, 'doc');
    if (!v.ok) { toast(v.message, 'error', 5000); input.value = ''; RC_BILL_FILE = null; return; }
    RC_BILL_FILE = file;
    document.getElementById('rc-bill-name').textContent = file.name;
    preview.classList.remove('hidden');
    document.getElementById('rc-bill-upload-area').classList.add('has-file');
  }
}
function clearReceiveBill() {
  RC_BILL_FILE = null;
  document.getElementById('rc-bill-input').value = '';
  document.getElementById('rc-bill-preview').classList.add('hidden');
  document.getElementById('rc-bill-upload-area').classList.remove('has-file');
}

async function submitReceive() {
  const locationId = document.getElementById('rc-location').value;
  if (!locationId) { toast('Choose a location.', 'error'); return; }
  const payload = {
    locationId,
    assetTag: document.getElementById('rc-tag').value.trim(),
    serialNumber: document.getElementById('rc-serial').value.trim(),
    condition: document.getElementById('rc-condition').value
  };
  if (!RECEIVE_IS_RESTOCK) {
    Object.assign(payload, {
      modelNumber: document.getElementById('rc-model').value.trim(),
      manufacturer: document.getElementById('rc-manufacturer').value.trim(),
      color: document.getElementById('rc-color').value.trim(),
      dimensions: document.getElementById('rc-dimensions').value.trim(),
      weight: document.getElementById('rc-weight').value.trim(),
      minStockLevel: document.getElementById('rc-minstock').value,
      reorderQty: document.getElementById('rc-reorder-qty').value,
      warrantyExpiry: document.getElementById('rc-warranty').value,
      notes: document.getElementById('rc-notes').value.trim(),
      tags: RC_TAGS_INPUT ? RC_TAGS_INPUT.getTags() : []
    });
  }
  try {
    const data = await api(`/api/admin/procurement/${RECEIVE_PR_ID}/receive`, { method:'POST', body:JSON.stringify(payload) });
    // Bill and photo are uploaded as separate follow-up requests since the
    // receive call itself is JSON — both already compressed at selection
    // time (see onReceiveBillChange / onReceivePhotoChange). Neither
    // failure blocks the receive itself, which has already succeeded.
    if (RC_BILL_FILE) {
      const fd = new FormData(); fd.append('bill', RC_BILL_FILE);
      await fetch(`/api/procurement/${RECEIVE_PR_ID}/bill`, { method:'POST', body:fd }).catch(()=>{});
    }
    if (RC_PHOTO_FILE && data.item?.id) {
      const fd = new FormData(); fd.append('image', RC_PHOTO_FILE);
      await fetch(`/api/items/${data.item.id}/photo`, { method:'POST', body:fd }).catch(()=>{});
    }
    toast('Item added to inventory.', 'success');
    closeModal('receive-modal');
    loadProcurement();
  } catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Repairs
// ─────────────────────────────────────────────────────────────────────────────
async function openRepairModal(itemId) {
  try {
    const data = ME.hasFullDashboardAccess ? await api('/api/items') : await api('/api/my-location');
    populateItemSelect('rp-item', data.items, '— Select item —', itemId);
    document.getElementById('rp-issue').value = '';
    document.getElementById('rp-priority').value = 'medium';
    document.getElementById('repair-modal').classList.remove('hidden');
  } catch(err) { toast(err.message, 'error'); }
}
async function submitRepair() {
  const itemId   = document.getElementById('rp-item').value;
  const issue    = document.getElementById('rp-issue').value.trim();
  const priority = document.getElementById('rp-priority').value;
  if (!itemId) { toast('Choose an item.', 'error'); return; }
  if (!issue)  { toast('Describe the issue.', 'error'); return; }
  try {
    await api('/api/repairs', { method:'POST', body:JSON.stringify({ itemId, issue, priority }) });
    toast('Issue reported.', 'success');
    closeModal('repair-modal');
    if (!document.getElementById('view-repairs').classList.contains('hidden')) loadRepairs();
    refreshRepairsBadge();
  } catch(err) { toast(err.message, 'error'); }
}
function setRepairFilter(status) {
  repairFilter = status;
  document.querySelectorAll('#repairs-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.status === status));
  loadRepairs();
}
async function loadRepairs() {
  const params = new URLSearchParams();
  if (repairFilter) params.set('status', repairFilter);
  const from = document.getElementById('rp-filter-from').value;
  const to   = document.getElementById('rp-filter-to').value;
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  try {
    const data = await api('/api/repairs?' + params.toString());
    REPAIRS_CACHE = data.repairs;
    renderRepairsTable();
    makeSortable('repairs-table', REPAIRS_CACHE, {
      miti: r => r.reportedAt, date: r => r.reportedAt, item: r => r.itemName
    }, renderRepairsTable);
  } catch(err) { toast('Failed to load repairs: ' + err.message, 'error'); }
}
function renderRepairsTable() {
  const tbody = document.querySelector('#repairs-table tbody');
  tbody.innerHTML = REPAIRS_CACHE.length ? REPAIRS_CACHE.map(r => {
    const loc = LOCATIONS.find(l => l.id === r.locationId);
    const canManage = ME.role === 'admin' || (loc && loc.custodianId === ME.id) || (ME.role === 'manager' && loc?.departmentId && (ME.departmentIds||[]).includes(loc.departmentId));
    return `<tr>
      <td class="mono">${r.reportedAtMiti||'—'}</td>
      <td class="muted" style="font-size:12px;">${fmtDate(r.reportedAt)}</td>
      <td><b>${esc(r.itemName)}</b></td>
      <td>${esc(r.locationName||'—')}</td>
      <td style="max-width:200px;white-space:normal;">${esc(r.issue)}</td>
      <td>${priorityBadge(r.priority)}</td>
      <td>${esc(r.reportedByName)}</td>
      <td>${esc(r.assignedVendorName||'—')}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${canManage ? `<button class="btn btn-ghost btn-sm" onclick="openRepairUpdate('${r.id}')">Update</button>` : ''}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="10" class="empty-state" style="padding:30px;">No repair requests.</td></tr>`;
}
function openRepairUpdate(id) {
  const r = REPAIRS_CACHE.find(x => x.id === id);
  if (!r) return;
  RU_REPAIR = r;
  document.getElementById('ru-id').value = r.id;
  document.getElementById('repair-update-sub').textContent = `${r.itemName} — ${r.issue}`;
  document.getElementById('ru-status').value = r.status;
  populateSelect('ru-vendor', VENDORS, '—', r.assignedVendorId);
  document.getElementById('ru-est-cost').value = r.estimatedCost??'';
  document.getElementById('ru-actual-cost').value = r.actualCost??'';
  document.getElementById('ru-notes').value = r.resolutionNotes||'';
  document.getElementById('ru-bill-input').value = '';
  document.getElementById('ru-bill-preview').classList.toggle('hidden', !r.hasBill);
  if (r.hasBill) document.getElementById('ru-bill-name').textContent = r.billFilename || 'Bill attached';
  // Server-side already guards against disposing an item twice (returns a
  // clear error), so this only needs a role check — no need to duplicate
  // the item's current condition into every repair list response.
  document.getElementById('ru-dispose-btn').style.display = ME.role === 'admin' ? '' : 'none';
  document.getElementById('repair-update-modal').classList.remove('hidden');
}

let RU_REPAIR = null;
async function uploadRepairBill(input) {
  const rawFile = input.files[0];
  if (!rawFile || !RU_REPAIR) return;
  const file = await compressImageFile(rawFile);
  const v = validateUploadFile(file, 'doc');
  if (!v.ok) { toast(v.message, 'error', 5000); input.value = ''; return; }
  const fd = new FormData(); fd.append('bill', file);
  try {
    await api(`/api/repairs/${RU_REPAIR.id}/bill`, { method:'POST', body:fd });
    toast('Bill uploaded.', 'success');
    RU_REPAIR.hasBill = true; RU_REPAIR.billFilename = file.name;
    document.getElementById('ru-bill-name').textContent = file.name;
    document.getElementById('ru-bill-preview').classList.remove('hidden');
    loadRepairs();
  } catch(err) { toast(err.message, 'error'); }
}
function viewRepairBill() {
  if (!RU_REPAIR) return;
  const url = `/api/images/repair/${RU_REPAIR.id}/bill?t=${Date.now()}`;
  openBillViewer(url, RU_REPAIR.billFilename || 'bill', () => removeRepairBill());
}
async function removeRepairBill() {
  if (!RU_REPAIR) return;
  const ok = await confirmDialog({ title:'Remove this bill?', message:'The bill/receipt will be permanently deleted.', confirmText:'Remove', type:'danger' });
  if (!ok) return;
  try {
    await api(`/api/repairs/${RU_REPAIR.id}/bill`, { method:'DELETE' });
    toast('Bill removed.', 'success');
    RU_REPAIR.hasBill = false; RU_REPAIR.billFilename = null;
    document.getElementById('ru-bill-preview').classList.add('hidden');
    closeModal('bill-viewer-modal');
    loadRepairs();
  } catch(err) { toast(err.message, 'error'); }
}

// Shortcut used from both the Repairs update modal and the Inventory item
// detail page: mark the underlying item disposed and move it to Scraps in
// one step, instead of opening the condition-log modal separately.
async function disposeRepairItemConfirm() {
  if (!RU_REPAIR) return;
  const ok = await confirmDialog({
    title: `Dispose "${RU_REPAIR.itemName}"?`,
    message: 'This marks the item as disposed and moves it to the Scraps register, separate from live inventory. The repair report will be closed as Not Repairable.',
    confirmText: 'Dispose item', type: 'danger'
  });
  if (!ok) return;
  try {
    await api(`/api/repairs/${RU_REPAIR.id}/dispose`, { method:'POST' });
    toast('Item disposed and moved to Scraps.', 'success');
    closeModal('repair-update-modal');
    loadRepairs();
  } catch(err) { toast(err.message, 'error'); }
}
async function submitRepairUpdate() {
  const id = document.getElementById('ru-id').value;
  try {
    await api(`/api/repairs/${id}`, {
      method:'PATCH', body:JSON.stringify({
        status: document.getElementById('ru-status').value,
        assignedVendorId: document.getElementById('ru-vendor').value,
        estimatedCost: document.getElementById('ru-est-cost').value,
        actualCost: document.getElementById('ru-actual-cost').value,
        resolutionNotes: document.getElementById('ru-notes').value
      })
    });
    toast('Repair updated.', 'success');
    closeModal('repair-update-modal');
    if (ME.hasFullDashboardAccess) { loadRepairs(); refreshRepairsBadge(); } else loadMyLocation();
  } catch(err) { toast(err.message, 'error'); }
}
async function refreshRepairsBadge() {
  try {
    const data = await api('/api/repairs');
    const open = data.repairs.filter(r => !['repaired','not_repairable','cancelled'].includes(r.status)).length;
    const badge = document.getElementById('repairs-badge');
    if (open > 0) { badge.textContent = open; badge.classList.remove('hidden'); } else badge.classList.add('hidden');
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Team approvals (managers)
// ─────────────────────────────────────────────────────────────────────────────
async function loadTeam() {
  try {
    TEAM_DATA = await api('/api/manager/approvals');
    renderTeamTable();
  } catch(err) { toast(err.message, 'error'); }
}
function switchTeamTab(type) {
  TEAM_TAB = type;
  document.getElementById('team-tab-transfer').classList.toggle('active', type === 'transfer');
  document.getElementById('team-tab-procurement').classList.toggle('active', type === 'procurement');
  document.getElementById('team-title').textContent = type === 'transfer' ? 'Transfer requests from your team' : 'Procurement requests from your team';
  renderTeamTable();
}
function renderTeamTable() {
  const thead = document.getElementById('team-thead');
  const tbody = document.querySelector('#team-table tbody');
  if (TEAM_TAB === 'transfer') {
    thead.innerHTML = '<tr><th>Employee</th><th>Item</th><th>From</th><th>To</th><th>Qty</th><th>Reason</th><th>Admin</th><th>Your decision</th><th></th></tr>';
    const rows = TEAM_DATA.transfers||[];
    tbody.innerHTML = rows.length ? rows.map(t => `
      <tr><td>${esc(t.requestedByName)}</td><td>${esc(t.itemName)}</td><td>${esc(t.fromLocationName||'—')}</td>
      <td>${esc(t.toLocationName||'—')}</td><td>${t.quantity??'—'}</td>
      <td style="max-width:160px;white-space:normal;">${esc(t.reason)}</td>
      <td>${statusBadge(t.adminDecision)}</td><td>${statusBadge(t.managerDecision)}</td>
      <td>${teamActionCell(t,'transfer')}</td></tr>`).join('')
      : `<tr><td colspan="9" class="empty-state" style="padding:30px;">No transfer requests from your team.</td></tr>`;
  } else {
    thead.innerHTML = '<tr><th>Employee</th><th>Item</th><th>Qty</th><th>Est. Cost</th><th>Justification</th><th>Admin</th><th>Your decision</th><th></th></tr>';
    const rows = TEAM_DATA.procurement||[];
    tbody.innerHTML = rows.length ? rows.map(p => `
      <tr><td>${esc(p.requestedByName)}</td><td>${esc(p.itemName)}</td>
      <td>${p.quantity} ${esc(p.unit||'')}</td><td>${fmtMoney(p.estimatedCost)}</td>
      <td style="max-width:160px;white-space:normal;">${esc(p.justification)}</td>
      <td>${statusBadge(p.adminDecision)}</td><td>${statusBadge(p.managerDecision)}</td>
      <td>${teamActionCell(p,'procurement')}</td></tr>`).join('')
      : `<tr><td colspan="8" class="empty-state" style="padding:30px;">No procurement requests from your team.</td></tr>`;
  }
}
function teamActionCell(item, type) {
  if (item.managerDecision !== 'pending') return '<span class="muted" style="font-size:12px;">Decided</span>';
  return `<div class="flex gap-8">
    <button class="btn btn-sm btn-gold" onclick="decideTeam('${item.id}','${type}','approved')">Approve</button>
    <button class="btn btn-sm btn-ghost" onclick="decideTeam('${item.id}','${type}','rejected')">Decline</button>
  </div>`;
}
async function decideTeam(id, type, decision) {
  try {
    await api(`/api/manager/approvals/${type}/${id}/decide`, { method:'POST', body:JSON.stringify({ decision }) });
    toast(decision === 'approved' ? 'Approved.' : 'Declined.', 'success');
    loadTeam(); refreshTeamBadge();
  } catch(err) { toast(err.message, 'error'); }
}
async function refreshTeamBadge() {
  try {
    const data = await api('/api/manager/approvals');
    const count = (data.transfers||[]).filter(t=>t.managerDecision==='pending').length + (data.procurement||[]).filter(p=>p.managerDecision==='pending').length;
    const badge = document.getElementById('team-badge');
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); } else badge.classList.add('hidden');
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Departments
// ─────────────────────────────────────────────────────────────────────────────
async function loadDepartments() {
  const [depData, locData, userData] = await Promise.all([api('/api/departments'), api('/api/locations'), api('/api/users')]);
  DEPARTMENTS = depData.departments;
  const tbody = document.querySelector('#departments-table tbody');
  tbody.innerHTML = DEPARTMENTS.length ? DEPARTMENTS.map(d => {
    const lc = locData.locations.filter(l => l.departmentId === d.id).length;
    const sc = userData.users.filter(u => (u.departmentIds||[]).includes(d.id)).length;
    return `<tr><td><b>${esc(d.name)}</b></td><td class="muted">${esc(d.notes||'—')}</td><td>${lc}</td><td>${sc}</td>
      <td><div class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openEditDepartment('${d.id}')">Edit</button>
      <button class="btn btn-danger-ghost btn-sm" onclick="deleteDepartment('${d.id}')">Delete</button></div></td></tr>`;
  }).join('') : `<tr><td colspan="5" class="empty-state" style="padding:30px;">No departments yet.</td></tr>`;
}
function openAddDepartment() {
  document.getElementById('department-modal-title').textContent = 'Add a department';
  document.getElementById('dep-id').value = '';
  document.getElementById('dep-name').value = '';
  document.getElementById('dep-notes').value = '';
  document.getElementById('department-modal').classList.remove('hidden');
}
function openEditDepartment(id) {
  const d = DEPARTMENTS.find(x => x.id === id);
  document.getElementById('department-modal-title').textContent = 'Edit department';
  document.getElementById('dep-id').value = d.id;
  document.getElementById('dep-name').value = d.name;
  document.getElementById('dep-notes').value = d.notes||'';
  document.getElementById('department-modal').classList.remove('hidden');
}
async function submitDepartment() {
  const id = document.getElementById('dep-id').value;
  const payload = { name: document.getElementById('dep-name').value.trim(), notes: document.getElementById('dep-notes').value.trim() };
  if (!payload.name) { toast('Name is required.', 'error'); return; }
  try {
    if (id) await api(`/api/departments/${id}`, { method:'PATCH', body:JSON.stringify(payload) });
    else    await api('/api/departments',         { method:'POST',  body:JSON.stringify(payload) });
    toast('Department saved.', 'success'); closeModal('department-modal'); loadDepartments();
  } catch(err) { toast(err.message, 'error'); }
}
async function deleteDepartment(id) {
  const ok = await confirmDialog({ title:'Delete this department?', message:'Only possible if no locations or staff are still assigned to it.', confirmText:'Delete', type:'danger' });
  if (!ok) return;
  try { await api(`/api/departments/${id}`, { method:'DELETE' }); toast('Deleted.', 'success'); loadDepartments(); }
  catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Locations
// ─────────────────────────────────────────────────────────────────────────────
async function loadLocations() {
  const [locData, itemData] = await Promise.all([api('/api/locations'), api('/api/items')]);
  LOCATIONS = locData.locations;
  document.getElementById('loc-count').textContent = `${LOCATIONS.length} location(s)`;
  const tbody = document.querySelector('#locations-table tbody');
  tbody.innerHTML = LOCATIONS.length ? LOCATIONS.map(l => {
    const count = itemData.items.filter(i => i.locationId === l.id).length;
    return `<tr><td><b>${esc(l.name)}</b></td><td>${esc(l.type||'—')}</td>
      <td>${[l.building, l.floor].filter(Boolean).map(esc).join(' · ')||'—'}</td>
      <td>${l.departmentName ? esc(l.departmentName) : (l.sharedAccess ? '<span class="badge badge-approved">Shared</span>' : '<span class="muted">Unassigned</span>')}</td>
      <td>${esc(l.custodianName||'—')}</td><td>${count}</td>
      <td><div class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openEditLocation('${l.id}')">Edit</button>
      <button class="btn btn-danger-ghost btn-sm" onclick="deleteLocation('${l.id}')">Delete</button></div></td></tr>`;
  }).join('') : `<tr><td colspan="7" class="empty-state" style="padding:30px;">No locations yet.</td></tr>`;
}
function openAddLocation() {
  document.getElementById('location-modal-title').textContent = 'Add a location';
  document.getElementById('loc-id').value = '';
  ['loc-name','loc-building','loc-floor','loc-notes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('loc-type').value = 'Room';
  document.getElementById('loc-shared-access').checked = false;
  populateSelect('loc-custodian', USERS, 'Unassigned');
  populateSelect('loc-department', DEPARTMENTS, 'Unassigned (shared)');
  document.getElementById('location-modal').classList.remove('hidden');
}
function openEditLocation(id) {
  const l = LOCATIONS.find(x => x.id === id);
  document.getElementById('location-modal-title').textContent = 'Edit location';
  document.getElementById('loc-id').value = l.id;
  document.getElementById('loc-name').value = l.name;
  document.getElementById('loc-type').value = l.type||'Room';
  document.getElementById('loc-building').value = l.building||'';
  document.getElementById('loc-floor').value = l.floor||'';
  document.getElementById('loc-notes').value = l.notes||'';
  document.getElementById('loc-shared-access').checked = !!l.sharedAccess;
  populateSelect('loc-custodian', USERS, 'Unassigned', l.custodianId);
  populateSelect('loc-department', DEPARTMENTS, 'Unassigned (shared)', l.departmentId);
  document.getElementById('location-modal').classList.remove('hidden');
}
async function submitLocation() {
  const id = document.getElementById('loc-id').value;
  const payload = {
    name: document.getElementById('loc-name').value.trim(),
    type: document.getElementById('loc-type').value,
    building: document.getElementById('loc-building').value.trim(),
    floor: document.getElementById('loc-floor').value.trim(),
    custodianId: document.getElementById('loc-custodian').value,
    departmentId: document.getElementById('loc-department').value,
    sharedAccess: document.getElementById('loc-shared-access').checked,
    notes: document.getElementById('loc-notes').value.trim()
  };
  if (!payload.name) { toast('Name is required.', 'error'); return; }
  try {
    if (id) await api(`/api/locations/${id}`, { method:'PATCH', body:JSON.stringify(payload) });
    else    await api('/api/locations',         { method:'POST',  body:JSON.stringify(payload) });
    toast('Location saved.', 'success'); closeModal('location-modal'); loadLocations();
  } catch(err) { toast(err.message, 'error'); }
}
async function deleteLocation(id) {
  const ok = await confirmDialog({ title:'Remove this location?', message:'All items at this location must be moved first.', confirmText:'Remove', type:'danger' });
  if (!ok) return;
  try { await api(`/api/locations/${id}`, { method:'DELETE' }); toast('Location removed.', 'success'); loadLocations(); }
  catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────────────────
async function loadCategories() {
  const [catData, itemData] = await Promise.all([api('/api/categories'), api('/api/items')]);
  CATEGORIES = catData.categories;
  document.getElementById('cat-count').textContent = `${CATEGORIES.length} categor${CATEGORIES.length===1?'y':'ies'}`;
  const tbody = document.querySelector('#categories-table tbody');
  tbody.innerHTML = CATEGORIES.length ? CATEGORIES.map(c => {
    const count = itemData.items.filter(i => i.categoryId === c.id).length;
    return `<tr><td><b>${esc(c.name)}</b></td><td>${statusBadge(c.trackingType)}</td><td>${esc(c.defaultUnit||'pcs')}</td><td>${count}</td>
      <td><div class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openEditCategory('${c.id}')">Edit</button>
      <button class="btn btn-danger-ghost btn-sm" onclick="deleteCategory('${c.id}')">Delete</button></div></td></tr>`;
  }).join('') : `<tr><td colspan="5" class="empty-state" style="padding:30px;">No categories yet.</td></tr>`;
}
function openAddCategory() {
  document.getElementById('category-modal-title').textContent = 'Add a category';
  document.getElementById('cat-id').value = '';
  document.getElementById('cat-name').value = '';
  document.getElementById('cat-tracking').value = 'asset';
  document.getElementById('cat-unit').value = '';
  document.getElementById('category-modal').classList.remove('hidden');
}
function openEditCategory(id) {
  const c = CATEGORIES.find(x => x.id === id);
  document.getElementById('category-modal-title').textContent = 'Edit category';
  document.getElementById('cat-id').value = c.id;
  document.getElementById('cat-name').value = c.name;
  document.getElementById('cat-tracking').value = c.trackingType;
  document.getElementById('cat-unit').value = c.defaultUnit||'';
  document.getElementById('category-modal').classList.remove('hidden');
}
async function submitCategory() {
  const id = document.getElementById('cat-id').value;
  const payload = { name: document.getElementById('cat-name').value.trim(), trackingType: document.getElementById('cat-tracking').value, defaultUnit: document.getElementById('cat-unit').value.trim() };
  if (!payload.name) { toast('Name is required.', 'error'); return; }
  try {
    if (id) await api(`/api/categories/${id}`, { method:'PATCH', body:JSON.stringify(payload) });
    else    await api('/api/categories',         { method:'POST',  body:JSON.stringify(payload) });
    toast('Category saved.', 'success'); closeModal('category-modal'); loadCategories();
  } catch(err) { toast(err.message, 'error'); }
}
async function deleteCategory(id) {
  const ok = await confirmDialog({ title:'Delete this category?', message:'Items using it must be recategorised first.', confirmText:'Delete', type:'danger' });
  if (!ok) return;
  try { await api(`/api/categories/${id}`, { method:'DELETE' }); toast('Deleted.', 'success'); loadCategories(); }
  catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendors
// ─────────────────────────────────────────────────────────────────────────────
async function loadVendors() {
  const data = await api('/api/vendors'); VENDORS = data.vendors;
  document.getElementById('ven-count').textContent = `${VENDORS.length} vendor(s)`;
  const tbody = document.querySelector('#vendors-table tbody');
  tbody.innerHTML = VENDORS.length ? VENDORS.map(v => `
    <tr><td><b>${esc(v.name)}</b></td><td>${esc(v.contactPerson||'—')}</td><td>${esc(v.phone||'—')}</td><td>${esc(v.email||'—')}</td><td>${esc(v.supplies||'—')}</td>
    <td><div class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openEditVendor('${v.id}')">Edit</button>
    <button class="btn btn-danger-ghost btn-sm" onclick="deleteVendor('${v.id}')">Delete</button></div></td></tr>`)
    .join('') : `<tr><td colspan="6" class="empty-state" style="padding:30px;">No vendors yet.</td></tr>`;
}
function openAddVendor() {
  document.getElementById('vendor-modal-title').textContent = 'Add a vendor';
  document.getElementById('ven-id').value = '';
  ['ven-name','ven-contact','ven-phone','ven-email','ven-address','ven-supplies'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('vendor-modal').classList.remove('hidden');
}
function openEditVendor(id) {
  const v = VENDORS.find(x => x.id === id);
  document.getElementById('vendor-modal-title').textContent = 'Edit vendor';
  document.getElementById('ven-id').value = v.id;
  document.getElementById('ven-name').value = v.name;
  document.getElementById('ven-contact').value = v.contactPerson||'';
  document.getElementById('ven-phone').value = v.phone||'';
  document.getElementById('ven-email').value = v.email||'';
  document.getElementById('ven-address').value = v.address||'';
  document.getElementById('ven-supplies').value = v.supplies||'';
  document.getElementById('vendor-modal').classList.remove('hidden');
}
async function submitVendor() {
  const id = document.getElementById('ven-id').value;
  const payload = { name: document.getElementById('ven-name').value.trim(), contactPerson: document.getElementById('ven-contact').value.trim(), phone: document.getElementById('ven-phone').value.trim(), email: document.getElementById('ven-email').value.trim(), address: document.getElementById('ven-address').value.trim(), supplies: document.getElementById('ven-supplies').value.trim() };
  if (!payload.name) { toast('Name is required.', 'error'); return; }
  try {
    if (id) await api(`/api/vendors/${id}`, { method:'PATCH', body:JSON.stringify(payload) });
    else    await api('/api/vendors',         { method:'POST',  body:JSON.stringify(payload) });
    toast('Vendor saved.', 'success'); closeModal('vendor-modal'); loadVendors();
  } catch(err) { toast(err.message, 'error'); }
}
async function deleteVendor(id) {
  const ok = await confirmDialog({ title:'Delete this vendor?', message:'This cannot be undone.', confirmText:'Delete', type:'danger' });
  if (!ok) return;
  try { await api(`/api/vendors/${id}`, { method:'DELETE' }); toast('Deleted.', 'success'); loadVendors(); }
  catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const data = await api('/api/users'); USERS = data.users;
  document.getElementById('usr-count').textContent = `${USERS.length} user(s)`;
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = USERS.map(u => `
    <tr>
      <td><div class="row-person">${avatarHtml(u)}<div><div class="nm">${esc(u.name)}</div><div class="sub">${esc(u.email)}</div></div></div></td>
      <td>${statusBadge(u.role)}</td>
      <td>${u.departmentNames?.length ? esc(u.departmentNames.join(', ')) : '<span class="muted">None</span>'}</td>
      <td>${esc(u.managerName||'—')}</td>
      <td>${u.role==='admin'||u.role==='manager' ? '<span class="muted">Full (role)</span>' : statusBadge(u.dashboardAccess||'auto')}</td>
      <td>${statusBadge(u.status)}</td>
      <td><div class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openEditUser('${u.id}')">Edit</button>
      <button class="btn btn-danger-ghost btn-sm" onclick="deleteUser('${u.id}')">Remove</button></div></td>
    </tr>`).join('');
}
function renderDepartmentCheckboxes(selectedIds = []) {
  const host = document.getElementById('usr-departments');
  if (!DEPARTMENTS.length) { host.innerHTML = '<div class="empty">No departments yet.</div>'; return; }
  host.innerHTML = DEPARTMENTS.map(d => `<label><input type="checkbox" value="${d.id}" ${selectedIds.includes(d.id)?'checked':''}> ${esc(d.name)}</label>`).join('');
}
function openAddUser() {
  document.getElementById('user-modal-title').textContent = 'Add a user';
  document.getElementById('usr-id').value = '';
  ['usr-name','usr-email','usr-phone'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('usr-role').value = 'staff';
  document.getElementById('usr-dashboard-access').value = '';
  document.getElementById('usr-scrap-access').value = '';
  populateSelect('usr-location', LOCATIONS, '—');
  populateSelect('usr-manager', USERS, 'No manager');
  renderDepartmentCheckboxes([]);
  const sf = document.getElementById('usr-status-field');
  if (sf) sf.style.display = 'none';
  document.getElementById('user-modal').classList.remove('hidden');
}
function openEditUser(id) {
  const u = USERS.find(x => x.id === id);
  document.getElementById('user-modal-title').textContent = 'Edit user';
  document.getElementById('usr-id').value = u.id;
  document.getElementById('usr-name').value = u.name;
  document.getElementById('usr-email').value = u.email;
  document.getElementById('usr-role').value = u.role;
  document.getElementById('usr-phone').value = u.phone||'';
  document.getElementById('usr-dashboard-access').value = u.dashboardAccess||'';
  document.getElementById('usr-scrap-access').value = u.scrapAccess||'';
  populateSelect('usr-location', LOCATIONS, '—', u.locationId);
  populateSelect('usr-manager', USERS.filter(x => x.id !== u.id), 'No manager', u.managerId);
  renderDepartmentCheckboxes(u.departmentIds||[]);
  const sf = document.getElementById('usr-status-field');
  if (sf) { sf.style.display = ''; document.getElementById('usr-status').value = u.status; }
  document.getElementById('user-modal').classList.remove('hidden');
}
async function submitUser() {
  const id = document.getElementById('usr-id').value;
  const departmentIds = Array.from(document.querySelectorAll('#usr-departments input[type="checkbox"]:checked')).map(cb => cb.value);
  const payload = {
    name: document.getElementById('usr-name').value.trim(),
    email: document.getElementById('usr-email').value.trim(),
    role: document.getElementById('usr-role').value,
    departmentIds,
    locationId: document.getElementById('usr-location').value,
    managerId: document.getElementById('usr-manager').value,
    phone: document.getElementById('usr-phone').value.trim(),
    dashboardAccess: document.getElementById('usr-dashboard-access').value,
    scrapAccess: document.getElementById('usr-scrap-access').value
  };
  if (id) payload.status = document.getElementById('usr-status')?.value||'active';
  if (!payload.name || !payload.email) { toast('Name and email are required.', 'error'); return; }
  try {
    if (id) { await api(`/api/users/${id}`, { method:'PATCH', body:JSON.stringify(payload) }); toast('User updated.', 'success'); }
    else    { const d = await api('/api/users', { method:'POST', body:JSON.stringify(payload) }); toast(`${payload.name} added — temporary password: ${d.tempPassword}`, 'success', 8000); }
    closeModal('user-modal'); loadUsers();
  } catch(err) { toast(err.message, 'error'); }
}
async function deleteUser(id) {
  const ok = await confirmDialog({ title:'Remove this user?', message:'This cannot be undone. Their requests will remain in the system.', confirmText:'Remove', type:'danger' });
  if (!ok) return;
  try { await api(`/api/users/${id}`, { method:'DELETE' }); toast('User removed.', 'success'); loadUsers(); }
  catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────
function reportDateParams() {
  const params = new URLSearchParams();
  const from = document.getElementById('rep-from').value;
  const to   = document.getElementById('rep-to').value;
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  return params;
}
// Downloads an export as a blob and triggers a normal file-save via a
// hidden <a download> link — deliberately never uses window.open() or
// navigates the page. window.open() is what was opening a second blank
// window in the Electron/Nativefier wrapper (it has no real browser tab
// chrome, so a new BrowserWindow appears instead) even though the file
// itself was already downloading correctly underneath it.
async function exportReport(kind) {
  const params = reportDateParams();
  const label = (REPORT_COLUMNS[kind]||{}).title || 'Report';
  toast(`Preparing ${label}…`);
  try {
    const res = await fetch(`/api/reports/${kind}/export?${params.toString()}`, { credentials: 'same-origin' });
    if (!res.ok) {
      let message = `Export failed (HTTP ${res.status}).`;
      try { const data = await res.clone().json(); if (data.error) message = data.error; } catch {}
      throw new Error(message);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = /filename="?([^"?]+)"?/.exec(cd);
    const filename = match ? match[1] : `${kind}-report.xlsx`;
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    toast(`${label} downloaded — ${filename}`, 'success');
  } catch (err) {
    toast(err.message || 'Export failed. Please try again.', 'error');
  }
}
const REPORT_COLUMNS = {
  inventory:   { title:'Inventory Report',         endpoint:'/api/items',       dataKey:'items',    cols:[['Name',i=>i.name],['Category',i=>i.categoryName||'—'],['Manufacturer',i=>i.manufacturer||'—'],['Model',i=>i.modelNumber||'—'],['Location',i=>i.locationName||'—'],['Qty',i=>fmtQty(i)],['Condition',i=>titleCase(i.condition)],['Cost',i=>fmtMoney(i.purchaseCost)],['Tags',i=>(i.tags||[]).join(', ')]] },
  transfers:   { title:'Transfer Log',             endpoint:'/api/transfers',   dataKey:'transfers', cols:[['Date',t=>fmtDate(t.createdAt)],['Item',t=>t.itemName],['From',t=>t.fromLocationName||'—'],['To',t=>t.toLocationName||'—'],['Requested by',t=>t.requestedByName],['Status',t=>titleCase(t.status)]] },
  procurement: { title:'Procurement Log',          endpoint:'/api/procurement', dataKey:'requests',  cols:[['Date',p=>fmtDate(p.createdAt)],['Item',p=>p.itemName],['Qty',p=>`${p.quantity} ${p.unit||''}`.trim()],['Cost',p=>fmtMoney(p.estimatedCost)],['Type',p=>p.isRestock?'Restock':'New'],['By',p=>p.requestedByName],['Status',p=>titleCase(p.status)]] },
  repairs:     { title:'Repair & Maintenance Log', endpoint:'/api/repairs',     dataKey:'repairs',   cols:[['Date',r=>fmtDate(r.reportedAt)],['Item',r=>r.itemName],['Location',r=>r.locationName||'—'],['Priority',r=>titleCase(r.priority)],['Vendor',r=>r.assignedVendorName||'—'],['Status',r=>titleCase(r.status)]] }
};
let REP_CURRENT_KIND = null;
async function viewReportDetails(kind) {
  REP_CURRENT_KIND = kind;
  document.querySelectorAll('.report-card').forEach(el => el.classList.toggle('active', el.id === `rep-card-${kind}`));
  const def = REPORT_COLUMNS[kind];
  const params = reportDateParams();
  const data = await api(def.endpoint + '?' + params.toString());
  const rows = data[def.dataKey]||[];
  document.getElementById('rep-preview-title').textContent = def.title;
  document.getElementById('rep-preview-sub').textContent = `${rows.length} record(s)`;
  const table = document.getElementById('rep-preview-table');
  table.querySelector('thead').innerHTML = '<tr>' + def.cols.map(c => `<th>${c[0]}</th>`).join('') + '</tr>';
  table.querySelector('tbody').innerHTML = rows.length
    ? rows.slice(0, 200).map(r => '<tr>' + def.cols.map(c => `<td>${esc(String(c[1](r)||'—'))}</td>`).join('') + '</tr>').join('')
    : `<tr><td colspan="${def.cols.length}" class="empty-state" style="padding:24px;">No records.</td></tr>`;
  document.getElementById('rep-preview-card').classList.remove('hidden');
  document.getElementById('rep-preview-card').scrollIntoView({ behavior:'smooth', block:'nearest' });
}
function loadReportPreview() { if (REP_CURRENT_KIND) viewReportDetails(REP_CURRENT_KIND); }

// ─────────────────────────────────────────────────────────────────────────────
// Branding
// ─────────────────────────────────────────────────────────────────────────────
async function loadBrandingView() {
  const { settings } = await api('/api/settings/public', { cache: 'no-store' });
  document.getElementById('brand-name').value = settings.schoolName||'';
  document.getElementById('brand-tagline-input').value = settings.tagline||'';
  document.getElementById('brand-petty-limit').value = settings.pettyCashLimit ?? '';
  setBrandMarks('#brand-logo-preview', settings.schoolName||'School', settings.hasLogo);
}
async function submitBranding() {
  try {
    await api('/api/settings', { method:'PATCH', body:JSON.stringify({ schoolName: document.getElementById('brand-name').value.trim(), tagline: document.getElementById('brand-tagline-input').value.trim() }) });
    toast('Branding updated.', 'success');
    await applyBranding();
    loadBrandingView();
  } catch(err) { toast(err.message, 'error'); }
}
async function submitPettyLimit() {
  const val = document.getElementById('brand-petty-limit').value;
  if (val === '' || Number(val) < 0) { toast('Enter a valid, non-negative petty cash limit.', 'error'); return; }
  try {
    await api('/api/settings', { method:'PATCH', body:JSON.stringify({ pettyCashLimit: Number(val) }) });
    toast('Petty cash limit updated.', 'success');
    loadBrandingView();
  } catch(err) { toast(err.message, 'error'); }
}
async function uploadBrandLogo() {
  const rawFile = document.getElementById('brand-logo-input').files[0];
  if (!rawFile) return;
  const file = await compressImageFile(rawFile);
  const v = validateUploadFile(file, 'image');
  if (!v.ok) { toast(v.message, 'error', 5000); document.getElementById('brand-logo-input').value = ''; return; }
  const fd = new FormData(); fd.append('image', file);
  try {
    const res = await fetch('/api/settings/logo', { method:'POST', body:fd });
    const data = await res.json(); if (!res.ok) throw new Error(data.error);
    toast('Logo updated.', 'success'); await applyBranding(); loadBrandingView();
  } catch(err) { toast(err.message, 'error'); }
  document.getElementById('brand-logo-input').value = '';
}
async function removeBrandLogo() {
  const ok = await confirmDialog({ title:'Remove the logo?', message:'The initials will be shown instead.', confirmText:'Remove', type:'warning' });
  if (!ok) return;
  try { await api('/api/settings/logo', { method:'DELETE' }); toast('Logo removed.', 'success'); await applyBranding(); loadBrandingView(); }
  catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────
async function loadProfile() {
  const profileWrap = document.getElementById('profile-avatar-wrap');
  const removeBtn   = document.getElementById('profile-avatar-remove-btn');
  if (ME.hasAvatar) {
    profileWrap.innerHTML = `<div class="avatar avatar-lg" style="background:${ME.avatarColor||'var(--navy-600)'}"><img src="/api/images/avatar/${ME.id}?t=${Date.now()}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`;
    if (removeBtn) removeBtn.style.opacity = '1';
  } else {
    profileWrap.innerHTML = `<div class="avatar avatar-lg" style="background:${ME.avatarColor||'var(--navy-600)'};font-size:22px;">${initials(ME.name)}</div>`;
    if (removeBtn) removeBtn.style.opacity = '0';
  }
  document.getElementById('profile-name').textContent = ME.name;
  document.getElementById('profile-role').textContent = titleCase(ME.role) + (ME.departmentNames?.length ? ' · ' + ME.departmentNames.join(', ') : '');
  document.getElementById('p-email').textContent    = ME.email;
  document.getElementById('p-division').textContent = ME.departmentNames?.length ? ME.departmentNames.join(', ') : 'None assigned';
  document.getElementById('p-manager').textContent  = ME.managerName||'No manager assigned';
  document.getElementById('p-phone').textContent    = ME.phone||'—';
  document.getElementById('p-status').textContent   = ME.status==='active' ? 'Active' : 'Inactive';
  document.getElementById('p-locations').textContent = ME.custodianLocations?.join(', ')||'None';
}
async function uploadProfilePhoto() {
  const rawFile = document.getElementById('profile-photo-input').files[0];
  if (!rawFile) return;
  const file = await compressImageFile(rawFile);
  const v = validateUploadFile(file, 'image');
  if (!v.ok) { toast(v.message, 'error', 5000); document.getElementById('profile-photo-input').value = ''; return; }
  const fd = new FormData(); fd.append('image', file);
  try {
    const res = await fetch('/api/auth/profile-image', { method:'POST', body:fd });
    const data = await res.json(); if (!res.ok) throw new Error(data.error);
    ME = { ...ME, ...data.user, hasAvatar: true };
    toast('Photo updated.', 'success');
    loadProfile(); renderSidebarAvatar();
  } catch(err) { toast(err.message, 'error'); }
  document.getElementById('profile-photo-input').value = '';
}
async function removeProfilePhoto() {
  const ok = await confirmDialog({ title:'Remove your profile photo?', message:'Your initials will be shown instead.', confirmText:'Remove photo', type:'warning' });
  if (!ok) return;
  try {
    await api('/api/auth/profile-image', { method:'DELETE' });
    ME = { ...ME, hasAvatar: false };
    toast('Photo removed.', 'success');
    loadProfile(); renderSidebarAvatar();
  } catch(err) { toast(err.message, 'error'); }
}
async function submitChangePassword() {
  const cur = document.getElementById('cur-password').value;
  const npw = document.getElementById('new-password-profile').value;
  const cnf = document.getElementById('confirm-password-profile').value;
  if (npw.length < 8) { toast('New password must be at least 8 characters.', 'error'); return; }
  if (npw !== cnf) { toast('Passwords do not match.', 'error'); return; }
  try {
    await api('/api/auth/change-password', { method:'POST', body:JSON.stringify({ currentPassword:cur, newPassword:npw }) });
    toast('Password updated.', 'success');
    ['cur-password','new-password-profile','confirm-password-profile'].forEach(id => document.getElementById(id).value = '');
  } catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stocking Plans — annual budgets, weekly stock orders, departmental allocation
// ─────────────────────────────────────────────────────────────────────────────
let STOCKING_TAB = 'annual';
let STOCKING_PLANS = [];

function setStockingTab(type) {
  STOCKING_TAB = type;
  document.querySelectorAll('#view-stocking .section-tabs .stab').forEach(t => t.classList.toggle('active', t.dataset.type === type));
  const titles = { annual: ['Annual Budget Plans', 'Fiscal year budget allocations by department'], weekly: ['Weekly Stock Orders', 'Recurring weekly consumable and supply orders'], petty: ['Petty Cash Allocations', 'Department-level petty cash budget plans'] };
  document.getElementById('stocking-title').textContent = titles[type][0];
  document.getElementById('stocking-sub').textContent = titles[type][1];
  loadStocking();
}

let STOCKING_STATUS_FILTER = 'active';
function setStockingStatusFilter(status) {
  STOCKING_STATUS_FILTER = status;
  document.querySelectorAll('#stocking-status-filter .tab').forEach(t => t.classList.toggle('active', t.dataset.status === status));
  loadStocking();
}

async function loadStocking() {
  populateFilterSelect('pln-department', DEPARTMENTS, 'All departments'); // pre-warm select for modal reuse
  try {
    const params = new URLSearchParams({ planType: STOCKING_TAB });
    if (STOCKING_STATUS_FILTER) params.set('status', STOCKING_STATUS_FILTER);
    const data = await api('/api/stocking-plans?' + params.toString());
    STOCKING_PLANS = data.plans || [];
    STOCKING_PLANS.forEach(p => { STOCKING_PLANS_LOOKUP[p.id] = p; }); // keep global lookup fresh too

    // Live summary stats across whatever's currently visible
    const totalBudget    = STOCKING_PLANS.reduce((s, p) => s + (p.budget || 0), 0);
    const totalSpent     = STOCKING_PLANS.reduce((s, p) => s + (p.spent || 0), 0);
    const totalRemaining = STOCKING_PLANS.reduce((s, p) => s + (p.budget != null ? Math.max(0, p.budget - p.spent) : 0), 0);
    const overCount      = STOCKING_PLANS.filter(p => p.budget != null && p.spent > p.budget).length;
    document.getElementById('sk-total-budget').textContent    = fmtMoney(totalBudget);
    document.getElementById('sk-total-spent').textContent     = fmtMoney(totalSpent);
    document.getElementById('sk-total-remaining').textContent = fmtMoney(totalRemaining);
    document.getElementById('sk-over-count').textContent      = overCount;

    const grid = document.getElementById('stocking-grid');
    if (!STOCKING_PLANS.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;padding:36px;">No ${STOCKING_TAB} plans ${STOCKING_STATUS_FILTER ? 'with status "' + STOCKING_STATUS_FILTER + '"' : ''} yet. ${['admin','manager'].includes(ME.role) ? 'Click "Create Plan" to add one.' : ''}</div>`;
      return;
    }
    const typeColors = { annual:{bg:'var(--info-tint)',fg:'var(--info)'}, weekly:{bg:'var(--brass-tint)',fg:'#4A7A22'}, petty:{bg:'var(--late-tint)',fg:'var(--late)'} };
    const c = typeColors[STOCKING_TAB] || typeColors.annual;
    grid.innerHTML = STOCKING_PLANS.map(p => {
      const pct = p.budget ? Math.min(100, Math.round((p.spent / p.budget) * 100)) : null;
      const over = p.budget != null && p.spent > p.budget;
      return `<div class="plan-card" onclick="openPlanDetail('${p.id}')" style="cursor:pointer;">
        <span class="plan-type-badge" style="background:${c.bg};color:${c.fg};">${titleCase(p.planType)}${p.status === 'active' ? '' : ' · ' + titleCase(p.status)}</span>
        <div class="plan-title">${esc(p.title)}</div>
        <div class="plan-sub">${esc(p.departmentName || 'All departments')} ${p.fiscalYear ? '· FY ' + esc(p.fiscalYear) : ''} ${p.weekNumber ? '· Week ' + p.weekNumber : ''}</div>
        ${p.description ? `<div class="muted" style="font-size:12px;margin-bottom:12px;">${esc(p.description)}</div>` : ''}
        ${p.budget != null ? `
          <div class="progress-bar"><div class="fill" style="width:${pct}%;${over?'background:var(--danger);':''}"></div></div>
          <div class="budget-labels"><span class="spent">${fmtMoney(p.spent)} spent</span><span>${fmtMoney(p.budget)} budget</span></div>
          ${over ? `<div style="color:var(--danger);font-size:11.5px;font-weight:600;margin-top:6px;">⚠ Over budget by ${fmtMoney(p.spent - p.budget)}</div>` : ''}
        ` : '<div class="muted" style="font-size:12px;">No fixed budget set.</div>'}
        <div class="flex between center" style="margin-top:14px;">
          <span class="muted" style="font-size:11px;">By ${esc(p.createdByName||'—')}</span>
          ${ME.role === 'admin' ? `<button class="btn btn-danger-ghost btn-xs" onclick="event.stopPropagation();deletePlan('${p.id}')">Delete</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch(err) { toast('Failed to load stocking plans: ' + err.message, 'error'); }
}

function openAddPlan() {
  document.getElementById('plan-modal-title').textContent = `Create a ${STOCKING_TAB} plan`;
  document.getElementById('pln-type').value = STOCKING_TAB;
  document.getElementById('pln-title').value = '';
  document.getElementById('pln-budget').value = '';
  document.getElementById('pln-description').value = '';
  document.getElementById('pln-fiscal-year').value = '';
  document.getElementById('pln-week-number').value = '';
  document.getElementById('pln-week-start').value = '';
  populateSelect('pln-department', DEPARTMENTS, 'All departments');
  document.getElementById('pln-annual-fields').classList.toggle('hidden', STOCKING_TAB !== 'annual');
  document.getElementById('pln-weekly-fields').classList.toggle('hidden', STOCKING_TAB !== 'weekly');
  document.getElementById('plan-modal').classList.remove('hidden');
}

async function submitPlan() {
  const planType = document.getElementById('pln-type').value;
  const title = document.getElementById('pln-title').value.trim();
  if (!title) { toast('A title is required.', 'error'); return; }
  const budgetVal = document.getElementById('pln-budget').value;
  if (budgetVal && Number(budgetVal) < 0) { toast('Budget cannot be negative.', 'error'); return; }
  const payload = {
    planType, title,
    description: document.getElementById('pln-description').value.trim(),
    budget: budgetVal,
    departmentId: document.getElementById('pln-department').value,
    fiscalYear: document.getElementById('pln-fiscal-year').value.trim(),
    weekNumber: document.getElementById('pln-week-number').value,
    weekStartDate: document.getElementById('pln-week-start').value
  };
  try {
    await api('/api/stocking-plans', { method:'POST', body:JSON.stringify(payload) });
    toast('Stocking plan created.', 'success');
    closeModal('plan-modal');
    STOCKING_PLANS_LOOKUP = {}; // invalidate — will refetch lazily next time it's needed
    loadStocking();
  } catch(err) { toast(err.message, 'error'); }
}

async function deletePlan(id) {
  const ok = await confirmDialog({ title:'Delete this stocking plan?', message:'Linked procurement requests and petty cash expenses will remain but lose their plan reference. This cannot be undone.', confirmText:'Delete plan', type:'danger' });
  if (!ok) return;
  try {
    await api(`/api/stocking-plans/${id}`, { method:'DELETE' });
    toast('Plan deleted.', 'success');
    delete STOCKING_PLANS_LOOKUP[id];
    closeModal('plan-detail-modal');
    loadStocking();
  } catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan detail — interactive view: live budget gauge, period context, and
// every procurement/petty-cash record linked to this plan.
// ─────────────────────────────────────────────────────────────────────────────
let CURRENT_PLAN = null;

async function openPlanDetail(id) {
  try {
    const data = await api(`/api/stocking-plans/${id}`);
    CURRENT_PLAN = data.plan;
    const p = CURRENT_PLAN;
    STOCKING_PLANS_LOOKUP[p.id] = p;

    document.getElementById('pd-type-badge').textContent = titleCase(p.planType);
    document.getElementById('pd-status-badge').className = `badge badge-${p.status === 'active' ? 'active' : 'inactive'}`;
    document.getElementById('pd-status-badge').textContent = titleCase(p.status);
    document.getElementById('pd-title').textContent = p.title;
    document.getElementById('pd-sub').textContent = [p.departmentName || 'All departments', p.fiscalYear ? `FY ${p.fiscalYear}` : null, p.weekNumber ? `Week ${p.weekNumber}` : null].filter(Boolean).join(' · ') + (p.description ? ' — ' + p.description : '');

    // Budget gauge
    const hasBudget = p.budget != null;
    const pct = hasBudget && p.budget > 0 ? Math.min(100, Math.round((p.spent / p.budget) * 100)) : 0;
    const over = hasBudget && p.spent > p.budget;
    document.getElementById('pd-pct').textContent = hasBudget ? `${pct}%` : '—';
    document.getElementById('pd-progress-fill').style.width = pct + '%';
    document.getElementById('pd-progress-fill').style.background = over ? 'var(--danger)' : '';
    document.getElementById('pd-spent').textContent = `${fmtMoney(p.spent)} spent`;
    document.getElementById('pd-budget').textContent = hasBudget ? `of ${fmtMoney(p.budget)} budget` : 'no fixed budget set';
    document.getElementById('pd-remaining-row').classList.toggle('hidden', !hasBudget);
    document.getElementById('pd-remaining').textContent = hasBudget ? fmtMoney(Math.max(0, p.budget - p.spent)) : '—';
    document.getElementById('pd-remaining').style.color = over ? 'var(--danger)' : '';
    document.getElementById('pd-overbudget-warning').classList.toggle('hidden', !over);

    // Period context — differs by plan type
    const ctx = document.getElementById('pd-period-context');
    if (p.planType === 'annual') {
      const fy = fiscalYearProgress(p.fiscalYear);
      ctx.innerHTML = `<div style="font-size:12.5px;font-weight:700;color:var(--muted);margin-bottom:8px;">FISCAL YEAR PROGRESS</div>
        ${fy ? `<div class="progress-bar" style="margin-bottom:8px;"><div class="fill" style="width:${fy.pct}%;"></div></div>
        <div class="muted" style="font-size:12px;">Month ${fy.monthOfYear} of 12 · ${fy.daysRemaining > 0 ? fy.daysRemaining + ' days remaining in FY ' + p.fiscalYear : 'Fiscal year ended'}</div>`
        : `<div class="muted" style="font-size:12px;">Fiscal year: ${esc(p.fiscalYear || 'not set')}</div>`}`;
    } else if (p.planType === 'weekly') {
      const wk = weekProgress(p.weekStartDate);
      ctx.innerHTML = `<div style="font-size:12.5px;font-weight:700;color:var(--muted);margin-bottom:8px;">WEEK ${p.weekNumber || '—'}</div>
        <div style="font-size:13px;font-weight:600;">${p.weekStartDate ? fmtDate(p.weekStartDate) + ' – ' + fmtDate(addDays(p.weekStartDate, 6)) : 'No start date set'}</div>
        ${wk ? `<div class="muted" style="font-size:12px;margin-top:4px;">${wk.label}</div>` : ''}`;
    } else {
      ctx.innerHTML = `<div style="font-size:12.5px;font-weight:700;color:var(--muted);margin-bottom:8px;">CREATED</div>
        <div style="font-size:13px;font-weight:600;">${fmtDateTime(p.createdAt)}</div>
        <div class="muted" style="font-size:12px;margin-top:4px;">by ${esc(p.createdByName || '—')}</div>`;
    }

    // Linked activity
    const activityTitle = document.getElementById('pd-activity-title');
    const activityList   = document.getElementById('pd-activity-list');
    if (p.planType === 'petty') {
      activityTitle.textContent = 'Linked petty cash expenses';
      const expenses = data.pettyExpenses || [];
      document.getElementById('pd-activity-sub').textContent = `${expenses.length} expense(s)`;
      activityList.innerHTML = expenses.length ? expenses.map(e => `
        <div class="qr-item" style="cursor:default;">
          <div style="flex:1;"><div class="qr-name">${esc(e.description)}</div><div class="qr-sub">${esc(e.paidByName)} · ${fmtDate(e.expenseDate)} · ${statusBadge(e.status)}</div></div>
          <span style="font-weight:700;font-size:13px;">${fmtMoney(e.amount)}</span>
        </div>`).join('') : '<div class="qr-empty">No expenses linked yet.</div>';
    } else {
      activityTitle.textContent = 'Linked procurement requests';
      const procurement = data.procurement || [];
      document.getElementById('pd-activity-sub').textContent = `${procurement.length} request(s)`;
      activityList.innerHTML = procurement.length ? procurement.map(pr => `
        <div class="qr-item" style="cursor:pointer;" onclick="closeModal('plan-detail-modal');showView('procurement');">
          <div style="flex:1;"><div class="qr-name">${esc(pr.itemName)}</div><div class="qr-sub">${esc(pr.requestedByName)} · ${pr.quantity} ${esc(pr.unit||'')} · ${statusBadge(pr.status)}</div></div>
          <span style="font-weight:700;font-size:13px;">${fmtMoney(pr.estimatedCost)}</span>
        </div>`).join('') : '<div class="qr-empty">No procurement requests linked yet.</div>';
    }

    // Admin actions
    document.getElementById('pd-admin-actions').classList.toggle('hidden', !['admin','manager'].includes(ME.role));
    document.querySelectorAll('#pd-admin-actions .admin-only').forEach(el => el.classList.toggle('hidden', ME.role !== 'admin'));
    const toggleBtn = document.getElementById('pd-toggle-status-btn');
    toggleBtn.textContent = p.status === 'active' ? 'Close plan' : 'Reactivate plan';

    document.getElementById('plan-detail-modal').classList.remove('hidden');
  } catch(err) { toast('Could not load plan: ' + err.message, 'error'); }
}

function fiscalYearProgress(fyLabel) {
  // fyLabel like "2082/83" (Nepali FY) — approximate progress using AD calendar
  // months since April (typical Nepali fiscal year start) as a best-effort visual.
  if (!fyLabel) return null;
  const now = new Date();
  const fyStartMonth = 3; // April (0-indexed)
  let monthsIn = now.getMonth() - fyStartMonth;
  if (monthsIn < 0) monthsIn += 12;
  const monthOfYear = monthsIn + 1;
  const pct = Math.min(100, Math.round((monthOfYear / 12) * 100));
  const daysRemaining = Math.max(0, Math.round((12 - monthOfYear) * 30.4));
  return { monthOfYear, pct, daysRemaining };
}
function weekProgress(startDateStr) {
  if (!startDateStr) return null;
  const start = new Date(startDateStr);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const now = new Date();
  if (now < start) return { label: `Starts ${fmtDate(startDateStr)}` };
  if (now > end)   return { label: 'This week has ended' };
  const daysLeft = Math.ceil((end - now) / 86400000);
  return { label: `${daysLeft} day(s) remaining this week` };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function openEditPlanBudget() {
  document.getElementById('pbg-id').value = CURRENT_PLAN.id;
  document.getElementById('pbg-budget').value = CURRENT_PLAN.budget ?? '';
  document.getElementById('pbg-spent-hint').textContent = `Already spent: ${fmtMoney(CURRENT_PLAN.spent)}. The budget cannot be set below this without going over.`;
  document.getElementById('plan-budget-modal').classList.remove('hidden');
}
async function submitPlanBudget() {
  const id = document.getElementById('pbg-id').value;
  const budget = document.getElementById('pbg-budget').value;
  if (budget !== '' && Number(budget) < 0) { toast('Budget cannot be negative.', 'error'); return; }
  try {
    await api(`/api/stocking-plans/${id}`, { method:'PATCH', body:JSON.stringify({ budget: budget === '' ? null : Number(budget) }) });
    toast('Budget updated.', 'success');
    closeModal('plan-budget-modal');
    delete STOCKING_PLANS_LOOKUP[id];
    await openPlanDetail(id);
    loadStocking();
  } catch(err) { toast(err.message, 'error'); }
}

async function togglePlanStatus() {
  const newStatus = CURRENT_PLAN.status === 'active' ? 'closed' : 'active';
  const ok = await confirmDialog({
    title: newStatus === 'closed' ? 'Close this plan?' : 'Reactivate this plan?',
    message: newStatus === 'closed' ? 'No new requests will be able to link to it while closed. You can reopen it later.' : 'This plan will accept new linked requests again.',
    confirmText: newStatus === 'closed' ? 'Close plan' : 'Reactivate', type: 'info'
  });
  if (!ok) return;
  try {
    await api(`/api/stocking-plans/${CURRENT_PLAN.id}`, { method:'PATCH', body:JSON.stringify({ status: newStatus }) });
    toast(newStatus === 'closed' ? 'Plan closed.' : 'Plan reactivated.', 'success');
    delete STOCKING_PLANS_LOOKUP[CURRENT_PLAN.id];
    await openPlanDetail(CURRENT_PLAN.id);
    loadStocking();
  } catch(err) { toast(err.message, 'error'); }
}

function deletePlanFromDetail() { deletePlan(CURRENT_PLAN.id); }

function startRequestFromPlan() {
  const plan = CURRENT_PLAN;
  closeModal('plan-detail-modal');
  if (plan.planType === 'petty') {
    openAddExpense().then(() => {
      const sel = document.getElementById('pe-plan');
      if (sel) sel.value = plan.id;
    });
  } else {
    openProcurementModal();
    setTimeout(() => {
      const sel = document.getElementById('pr-stocking-plan');
      if (sel) sel.value = plan.id;
    }, 50);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Petty Cash Expenses
// ─────────────────────────────────────────────────────────────────────────────
let PETTY_CASH_LIMIT = 5000;

async function loadPetty() {
  try {
    const settingsData = await api('/api/settings/public');
    PETTY_CASH_LIMIT = settingsData.settings.pettyCashLimit || 5000;
    document.getElementById('petty-limit-text').textContent = `Rs. ${PETTY_CASH_LIMIT.toLocaleString()} per expense.`;
    document.getElementById('petty-limit-banner').classList.remove('hidden');
  } catch {}
  populateFilterSelect('petty-filter-dept', DEPARTMENTS, 'All departments');
  const params = new URLSearchParams();
  const dept   = document.getElementById('petty-filter-dept').value;
  const status = document.getElementById('petty-filter-status').value;
  if (dept)   params.set('departmentId', dept);
  if (status) params.set('status', status);
  try {
    const data = await api('/api/petty-expenses?' + params.toString());
    const tbody = document.querySelector('#petty-table tbody');
    tbody.innerHTML = data.expenses.length ? data.expenses.map(e => `
      <tr>
        <td class="muted" style="font-size:12px;">${fmtDate(e.expenseDate)}</td>
        <td><b>${esc(e.description)}</b>${e.notes ? `<div class="muted" style="font-size:11px;">${esc(e.notes)}</div>` : ''}</td>
        <td>${e.category ? `<span class="expense-category">${esc(e.category)}</span>` : '—'}</td>
        <td>${esc(e.departmentName||'—')}</td>
        <td><span class="expense-amount">${fmtMoney(e.amount)}</span></td>
        <td>${e.stockingPlanId ? '<span class="badge badge-tag">Linked</span>' : '—'}</td>
        <td>${e.hasReceipt ? `<button class="btn btn-ghost btn-xs" onclick="viewPettyReceipt('${e.id}','${esc(e.receiptFilename||'receipt')}')">🧾 View</button>` : `<label class="btn btn-ghost btn-xs" style="cursor:pointer;">📎 Upload<input type="file" accept="image/*,application/pdf" style="display:none;" onchange="uploadPettyReceipt('${e.id}',this)"></label>`}</td>
        <td>${esc(e.paidByName)}</td>
        <td>${statusBadge(e.status)}</td>
        <td>${(ME.role === 'admin' && e.status === 'pending') ? `<div class="flex gap-8">
          <button class="btn btn-gold btn-xs" onclick="decidePetty('${e.id}','approved')">Approve</button>
          <button class="btn btn-danger-ghost btn-xs" onclick="decidePetty('${e.id}','rejected')">Decline</button>
        </div>` : (ME.role === 'admin' ? `<button class="btn btn-danger-ghost btn-xs" onclick="deletePetty('${e.id}')">Delete</button>` : '')}</td>
      </tr>`).join('') : `<tr><td colspan="10" class="empty-state" style="padding:30px;">No petty cash expenses recorded.</td></tr>`;
    refreshPettyBadge(data.expenses);
  } catch(err) { toast('Failed to load petty expenses: ' + err.message, 'error'); }
}

function refreshPettyBadge(expenses) {
  const badge = document.getElementById('petty-badge');
  if (!badge) return;
  const pending = (expenses||[]).filter(e => e.status === 'pending').length;
  if (ME.role === 'admin' && pending > 0) { badge.textContent = pending; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

let PE_RECEIPT_FILE = null;

async function openAddExpense() {
  document.getElementById('pe-description').value = '';
  document.getElementById('pe-amount').value = '';
  document.getElementById('pe-category').value = 'Stationery';
  document.getElementById('pe-notes').value = '';
  document.getElementById('pe-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('pe-limit-text').textContent = `Rs. ${PETTY_CASH_LIMIT.toLocaleString()}`;
  populateSelect('pe-department', DEPARTMENTS, '—');
  try {
    const data = await api('/api/stocking-plans?planType=petty');
    const plans = (data.plans||[]).map(p => ({ id: p.id, name: `${p.title}${p.budget != null ? ' · ' + fmtMoney(p.budget - p.spent) + ' left' : ''}${p.status !== 'active' ? ' · ' + titleCase(p.status) : ''}` }));
    populateSelect('pe-plan', plans, '— None —');
  } catch { populateSelect('pe-plan', [], '— None —'); }
  clearExpenseReceipt();
  document.getElementById('expense-modal').classList.remove('hidden');
}

async function onExpenseReceiptChange() {
  const input = document.getElementById('pe-receipt-input');
  const rawFile = input.files[0];
  if (rawFile) {
    const file = await compressImageFile(rawFile);
    const v = validateUploadFile(file, 'doc');
    if (!v.ok) { toast(v.message, 'error', 5000); input.value = ''; PE_RECEIPT_FILE = null; return; }
    PE_RECEIPT_FILE = file;
    document.getElementById('pe-receipt-name').textContent = file.name;
    document.getElementById('pe-receipt-preview').classList.remove('hidden');
    document.getElementById('pe-receipt-upload-area').classList.add('has-file');
  }
}
function clearExpenseReceipt() {
  PE_RECEIPT_FILE = null;
  document.getElementById('pe-receipt-input').value = '';
  document.getElementById('pe-receipt-preview').classList.add('hidden');
  document.getElementById('pe-receipt-upload-area').classList.remove('has-file');
}

async function submitExpense() {
  const description = document.getElementById('pe-description').value.trim();
  const amount = Number(document.getElementById('pe-amount').value);
  if (!description) { toast('Please enter a description.', 'error'); return; }
  if (!amount || amount <= 0) { toast('Please enter a valid amount.', 'error'); return; }
  if (amount > PETTY_CASH_LIMIT) { toast(`Amount exceeds the petty cash limit of Rs. ${PETTY_CASH_LIMIT.toLocaleString()}. Please submit a formal procurement request instead.`, 'error', 6000); return; }
  const payload = {
    description, amount,
    category: document.getElementById('pe-category').value,
    departmentId: document.getElementById('pe-department').value,
    stockingPlanId: document.getElementById('pe-plan').value,
    expenseDate: document.getElementById('pe-date').value,
    notes: document.getElementById('pe-notes').value.trim()
  };
  try {
    const data = await api('/api/petty-expenses', { method:'POST', body:JSON.stringify(payload) });
    if (PE_RECEIPT_FILE) {
      const fd = new FormData(); fd.append('receipt', PE_RECEIPT_FILE);
      await fetch(`/api/petty-expenses/${data.expense.id}/receipt`, { method:'POST', body:fd }).catch(()=>{});
    }
    toast('Expense recorded.', 'success');
    closeModal('expense-modal');
    loadPetty();
  } catch(err) { toast(err.message, 'error'); }
}

async function uploadPettyReceipt(id, input) {
  const rawFile = input.files[0];
  if (!rawFile) return;
  const file = await compressImageFile(rawFile);
  const fd = new FormData(); fd.append('receipt', file);
  try {
    const res = await fetch(`/api/petty-expenses/${id}/receipt`, { method:'POST', body:fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('Receipt uploaded.', 'success');
    loadPetty();
  } catch(err) { toast(err.message, 'error'); }
  input.value = '';
}

function viewPettyReceipt(id, filename) {
  const url = `/api/images/petty-expense/${id}/receipt?t=${Date.now()}`;
  const canRemove = ME.role === 'admin';
  openBillViewer(url, filename, canRemove ? () => removePettyReceipt(id) : null);
}
async function removePettyReceipt(id) {
  const ok = await confirmDialog({ title:'Remove this receipt?', message:'The receipt will be permanently deleted.', confirmText:'Remove', type:'danger' });
  if (!ok) return;
  try {
    await api(`/api/petty-expenses/${id}/receipt`, { method:'DELETE' });
    toast('Receipt removed.', 'success');
    closeModal('bill-viewer-modal');
    loadPetty();
  } catch(err) { toast(err.message, 'error'); }
}

async function decidePetty(id, decision) {
  const ok = await confirmDialog({ title: decision === 'approved' ? 'Approve this expense?' : 'Decline this expense?', message: decision === 'approved' ? 'This will count against any linked stocking plan budget.' : '', confirmText: decision === 'approved' ? 'Approve' : 'Decline', type: decision === 'approved' ? 'info' : 'danger' });
  if (!ok) return;
  try {
    await api(`/api/petty-expenses/${id}/approve`, { method:'POST', body:JSON.stringify({ decision }) });
    toast(decision === 'approved' ? 'Expense approved.' : 'Expense declined.', 'success');
    loadPetty();
  } catch(err) { toast(err.message, 'error'); }
}

async function deletePetty(id) {
  const ok = await confirmDialog({ title:'Delete this expense record?', message:'This cannot be undone.', confirmText:'Delete', type:'danger' });
  if (!ok) return;
  try { await api(`/api/petty-expenses/${id}`, { method:'DELETE' }); toast('Deleted.', 'success'); loadPetty(); }
  catch(err) { toast(err.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility / render helpers
// ─────────────────────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function statusBadge(status) {
  if (!status || status === '—') return '<span class="muted">—</span>';
  const s = String(status).toLowerCase().replace(/\s+/g,'_');
  return `<span class="badge badge-${s}">${titleCase(status)}</span>`;
}
function priorityBadge(p) {
  const cls = { urgent:'badge-urgent', high:'badge-high', medium:'badge-medium', low:'badge-low-priority' };
  return `<span class="badge ${cls[p]||'badge-neutral'}">${titleCase(p)}</span>`;
}

function avatarHtml(u) {
  if (u.hasAvatar) return `<div class="avatar" style="background:${u.avatarColor||'var(--navy-600)'}"><img src="/api/images/avatar/${u.id}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`;
  return `<div class="avatar" style="background:${u.avatarColor||'var(--navy-600)'}">${initials(u.name)}</div>`;
}

function fmtQty(i) {
  if (i.trackingType === 'asset') return `1 ${i.unit||'pcs'}`;
  return `${Number(i.quantity||0).toLocaleString()} ${i.unit||'pcs'}`;
}
function fmtMoney(v) {
  if (v == null) return '—';
  return 'Rs. ' + Number(v).toLocaleString('en-IN', { minimumFractionDigits:0, maximumFractionDigits:2 });
}
function fmtDate(str) {
  if (!str) return '—';
  try { return new Date(str).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); } catch { return str; }
}
function fmtDateTime(str) {
  if (!str) return '—';
  try { return new Date(str).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return str; }
}
function initials(name) {
  return (name||'?').split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
}

// boot
init();
