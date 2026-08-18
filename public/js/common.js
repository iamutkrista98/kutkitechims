// common.js — Shared utilities: API wrapper, toast, themed confirm dialog, helpers
'use strict';

// ── API wrapper ──
// Friendly, resilient fetch wrapper:
//  - Never lets a raw "Unexpected end of JSON input" bubble up to the UI —
//    that's what a truncated/empty response looks like (e.g. a reverse
//    proxy timing out mid-response on cPanel), and on its own it's a
//    confusing error for anyone using the app.
//  - Adds a client-side timeout via AbortController so a genuinely hung
//    request doesn't leave a button spinning forever — the person gets a
//    clear "took too long" message and can retry.
//  - Gives specific, human messages for the HTTP statuses most associated
//    with hosting/proxy issues (408/502/503/504) rather than a bare
//    "HTTP 503".
//  - File uploads (FormData bodies) get a longer timeout than plain JSON
//    calls. On localhost every upload completes near-instantly over
//    loopback, so a short timeout never gets exercised — but over a real
//    network plus a reverse proxy hop (e.g. cPanel/Passenger), even a
//    modest image can take well past a few seconds to fully transfer,
//    especially for larger bill/receipt PDFs. An in-flight upload aborted
//    from the client side is what a server-side multer error reports as
//    "Request aborted", so uploads get real headroom here.
const API_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 120000;

function friendlyStatusMessage(status) {
  const map = {
    408: 'The request took too long and timed out. Please try again.',
    502: "The server didn't respond correctly. Please try again in a moment.",
    503: 'The server is busy right now. Please try again in a moment.',
    504: 'The server took too long to respond. Please try again in a moment.'
  };
  return map[status] || `Something went wrong (HTTP ${status}). Please try again.`;
}

async function parseJsonSafely(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function api(url, opts = {}) {
  const defaults = { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  const isUpload = opts.body instanceof FormData;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isUpload ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS);
  let merged;
  if (isUpload) {
    // Let browser set multipart boundary — don't set Content-Type
    const { headers, ...rest } = { ...defaults, ...opts };
    merged = { ...rest, headers: {}, signal: controller.signal };
  } else {
    merged = { ...defaults, ...opts, headers: { ...defaults.headers, ...(opts.headers || {}) }, signal: controller.signal };
  }

  let r;
  try {
    r = await fetch(url, merged);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(isUpload
      ? 'The upload took too long and was cancelled. Please check your connection and try again — larger files take longer on slower connections.'
      : 'The request took too long and was cancelled. Please check your connection and try again.');
    throw new Error('Could not reach the server. Please check your connection and try again.');
  }
  clearTimeout(timer);

  const data = await parseJsonSafely(r);

  if (!r.ok) {
    // Prefer the server's own error message when it sent proper JSON;
    // otherwise fall back to a friendly message for the status code
    // (covers proxy-generated error pages, which aren't JSON at all).
    throw new Error((data && data.error) || friendlyStatusMessage(r.status));
  }

  if (data === null) {
    // 2xx status but body wasn't valid JSON (or was empty) — this is
    // exactly the "failed to execute json" failure mode. Surface it as a
    // clear, actionable message instead of letting a raw parse error
    // reach the UI.
    throw new Error('The server sent back an unexpected response. Please try again — if this keeps happening, contact your administrator.');
  }

  return data;
}

// ── Toast notifications ──
function toast(msg, type = 'default', duration = 3500) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = `toast${type !== 'default' ? ' ' + type : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 320); }, duration);
}

// ── Themed confirm dialog (replaces browser confirm()) ──
function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', type = 'danger' } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';

    const iconSvg = {
      danger:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
      warning: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      info:    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    }[type] || '';

    const btnCls = type === 'danger' ? 'btn-danger-ghost' : type === 'warning' ? 'btn-gold' : 'btn-primary';

    backdrop.innerHTML = `
      <div class="confirm-dialog ${type}">
        ${iconSvg ? `<div class="icon">${iconSvg}</div>` : ''}
        <h4>${title}</h4>
        <p>${message || ''}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" id="cd-cancel">${cancelText}</button>
          <button class="btn ${btnCls}" id="cd-confirm">${confirmText}</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);
    const close = val => { backdrop.remove(); resolve(val); };
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(false); });
    backdrop.querySelector('#cd-cancel').addEventListener('click', () => close(false));
    backdrop.querySelector('#cd-confirm').addEventListener('click', () => close(true));
    setTimeout(() => { try { backdrop.querySelector('#cd-confirm').focus(); } catch {} }, 50);
  });
}

// ── Format helpers ──
function fmtCurrency(val) {
  if (val == null) return '—';
  return 'Rs. ' + Number(val).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function fmtDate(str) {
  if (!str) return '—';
  try { return new Date(str).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); } catch { return str; }
}
function fmtDateTime(str) {
  if (!str) return '—';
  try { return new Date(str).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return str; }
}
function timeAgo(str) {
  if (!str) return '';
  const diff = Date.now() - new Date(str).getTime();
  const m = Math.floor(diff / 60000), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d > 7) return fmtDate(str);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function badge(status) {
  const s = String(status || '').toLowerCase().replace(/\s+/g,'_');
  return `<span class="badge badge-${s}">${titleCase(status)}</span>`;
}
function titleCase(s) {
  return String(s || '—').split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}
function esc(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

// ── Tags rendering ──
function renderTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return tags.map(t => `<span class="badge badge-tag">${esc(t)}</span>`).join(' ');
}

// ── Tags input widget ──
function buildTagsInput(containerId, initialTags = []) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return { getTags: () => [] };
  let tags = [...(initialTags || [])];
  function render() {
    wrap.innerHTML = '';
    tags.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `${esc(t)}<button class="tag-remove" type="button" title="Remove">✕</button>`;
      chip.querySelector('.tag-remove').onclick = () => { tags.splice(i,1); render(); };
      wrap.appendChild(chip);
    });
    const inp = document.createElement('input');
    inp.placeholder = 'Add tag, press Enter…';
    inp.addEventListener('keydown', e => {
      const v = inp.value.trim();
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (v && !tags.includes(v)) { tags.push(v); render(); }
        else inp.value = '';
      }
      if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); render(); }
    });
    inp.addEventListener('blur', () => {
      const v = inp.value.trim();
      if (v && !tags.includes(v)) { tags.push(v); render(); }
    });
    wrap.appendChild(inp);
    wrap.onclick = () => inp.focus();
  }
  render();
  return { getTags: () => [...tags], setTags: (t) => { tags = Array.isArray(t) ? [...t] : []; render(); } };
}

// ── Photo upload helper ──
function bindPhotoUpload(boxId, imgId, fileInputId) {
  const box   = document.getElementById(boxId);
  const img   = document.getElementById(imgId);
  const input = document.getElementById(fileInputId);
  if (!box) return;
  box.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => { img.src = e.target.result; img.style.display = 'block'; box.querySelector('.upload-placeholder')?.classList.add('hidden'); };
    reader.readAsDataURL(file);
  });
}

// ── Options builder for <select> ──
function buildOptions(select, items, valueKey, labelKey, selectedVal, placeholder = '— Select —') {
  select.innerHTML = `<option value="">${placeholder}</option>`;
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item[valueKey];
    opt.textContent = item[labelKey];
    if (String(item[valueKey]) === String(selectedVal)) opt.selected = true;
    select.appendChild(opt);
  });
}

// ── Image URL helper ──
function avatarUrl(userId, hasAvatar, color) {
  if (hasAvatar) return `/api/images/avatar/${userId}?t=${Date.now()}`;
  return null;
}
function itemPhotoUrl(itemId, hasPhoto) {
  if (hasPhoto) return `/api/images/item/${itemId}?t=${Date.now()}`;
  return null;
}

// ── Sidebar overlay close ──
function closeSidebar() {
  document.querySelector('.sidebar')?.classList.remove('open');
}
document.addEventListener('click', e => {
  const sidebar = document.querySelector('.sidebar');
  const toggle  = document.querySelector('.menu-toggle');
  if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !toggle?.contains(e.target)) {
    closeSidebar();
  }
});

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // Close topmost modal or confirm dialog
    const cd = document.querySelector('.confirm-backdrop');
    if (cd) { cd.querySelector('#cd-cancel')?.click(); return; }
    const mb = document.querySelector('.modal-backdrop');
    if (mb) { mb.remove(); }
  }
});

// ── File upload validation ──
// Client-side pre-check so people get an immediate, friendly message instead
// of a slow round-trip to the server (or a cryptic network error) when a
// file is too large or an unsupported type.
const UPLOAD_LIMITS = {
  image: { maxBytes: 256 * 1024, label: '256 KB', types: ['image/png','image/jpeg','image/jpg','image/webp','image/gif'], typesLabel: 'PNG, JPG, WEBP or GIF' },
  doc:   { maxBytes: 256 * 1024, label: '256 KB', types: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf'], typesLabel: 'PNG, JPG, WEBP, GIF or PDF' }
};
function validateUploadFile(file, kind = 'image') {
  const rule = UPLOAD_LIMITS[kind] || UPLOAD_LIMITS.image;
  if (!file) return { ok: false, message: 'No file was selected.' };
  if (!rule.types.includes(file.type)) {
    return { ok: false, message: `That file type isn't supported. Please upload a ${rule.typesLabel} file.` };
  }
  if (file.size > rule.maxBytes) {
    const sizeKb = Math.round(file.size / 1024).toLocaleString();
    const hint = file.type === 'application/pdf'
      ? 'PDFs can\u2019t be auto-compressed \u2014 please reduce the file size before uploading (e.g. re-export at a lower quality, or split/compress it with a PDF tool).'
      : 'Please choose a smaller file \u2014 images this large should have been auto-compressed, so try a different photo if this keeps happening.';
    return { ok: false, message: `That file is ${sizeKb} KB, which is over the ${rule.label} upload limit. ${hint}` };
  }
  return { ok: true };
}

// ── Client-side image compression ──
// Downscales and re-encodes large photos in the browser before upload.
// This attacks the "upload fails/times out" problem at its actual source —
// a smaller file transfers faster, and more importantly can slip under a
// hard body-size ceiling imposed by a host's proxy/WAF (very common on
// shared cPanel hosting — ModSecurity and similar firewalls frequently
// cap multipart POST bodies well below what a naive app-level limit
// sometimes to a few hundred KB). A single fixed-quality pass isn't
// enough to reliably get under an unknown, possibly very low ceiling, so
// this iterates: it re-encodes at progressively lower quality and, if
// that alone isn't sufficient, progressively smaller dimensions too,
// stopping as soon as the result is under targetBytes (or after running
// out of steps, in which case the smallest version produced is used).
//
// Only ever applied to actual raster photos: PDFs pass through untouched
// (nothing to compress), and GIFs pass through untouched too (re-encoding
// through canvas would silently flatten/drop animation). If compression
// ever produces a LARGER file than the original, or if anything about the
// process fails (unsupported browser API, a corrupt image, etc.), the
// original file is used instead — compression never blocks an upload.
async function compressImageFile(file, { targetBytes = 220 * 1024, maxDimension = 1400, minDimension = 360 } = {}) {
  if (!file || !file.type.startsWith('image/') || file.type === 'image/gif') return file;
  if (file.size <= targetBytes) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const isPng = file.type === 'image/png';
    const toBlob = (w, h, type, quality, fillWhite) => new Promise(resolve => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      // JPEG has no alpha channel — filling white first avoids the
      // transparent areas of a converted PNG rendering as black.
      if (fillWhite) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(bitmap, 0, 0, w, h);
      canvas.toBlob(resolve, type, quality);
    });

    let dim = Math.min(maxDimension, Math.max(bitmap.width, bitmap.height));
    let best = null;
    // Outer loop: shrink dimensions; inner loop: drop quality first, since
    // quality reduction preserves more visible detail than downscaling.
    // PNG is lossless (its "quality" param does nothing), so a busy PNG
    // may never fit under a tight target through resizing alone — the
    // fallback pass below forces a JPEG re-encode as a last resort so
    // there's always a real result under the limit, at the cost of
    // transparency.
    while (dim >= minDimension) {
      const scale = dim / Math.max(bitmap.width, bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      for (const quality of [0.75, 0.55, 0.4, 0.25]) {
        const blob = await toBlob(w, h, file.type, isPng ? undefined : quality, false);
        if (!blob) continue;
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= targetBytes) { bitmap.close?.(); return blobToFile(blob, file.name, file.type); }
        if (isPng) break; // quality param is a no-op for PNG — no point looping it
      }
      dim = Math.round(dim * 0.75);
    }
    // Fallback for a PNG that still won't fit losslessly: force JPEG.
    if (isPng) {
      dim = Math.min(maxDimension, Math.max(bitmap.width, bitmap.height));
      while (dim >= minDimension) {
        const scale = dim / Math.max(bitmap.width, bitmap.height);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        for (const quality of [0.7, 0.5, 0.35, 0.2]) {
          const blob = await toBlob(w, h, 'image/jpeg', quality, true);
          if (!blob) continue;
          if (!best || blob.size < best.size) best = blob;
          if (blob.size <= targetBytes) { bitmap.close?.(); return blobToFile(blob, file.name, 'image/jpeg'); }
        }
        dim = Math.round(dim * 0.75);
      }
    }
    bitmap.close?.();
    // Never got under targetBytes — use the smallest version we managed,
    // as long as it's actually smaller than the original.
    if (best && best.size < file.size) return blobToFile(best, file.name, best.type || file.type);
    return file;
  } catch {
    return file;
  }
}
function blobToFile(blob, originalName, outputType) {
  const newName = originalName.replace(/\.\w+$/, outputType === 'image/png' ? '.png' : '.jpg');
  return new File([blob], newName, { type: outputType, lastModified: Date.now() });
}

// ── Sortable table headers ──
// Attaches click-to-sort behavior to <th> elements carrying a data-sort-key
// attribute. Sorts the given array in place (by reference) using a value
// extractor per key, toggling asc/desc on repeated clicks of the same
// column, then calls renderFn() to redraw. Purely client-side — sorts
// whatever page of data is already loaded, no extra network round trip.
const _sortState = {}; // tableId -> { key, dir }

function makeSortable(tableId, dataArray, extractors, renderFn) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const state = _sortState[tableId] || { key: null, dir: 'asc' };
  _sortState[tableId] = state;

  table.querySelectorAll('thead th[data-sort-key]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sortKey === state.key);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = th.dataset.sortKey === state.key ? (state.dir === 'asc' ? '▲' : '▼') : '↕';
    th.onclick = () => {
      const key = th.dataset.sortKey;
      if (state.key === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else { state.key = key; state.dir = 'asc'; }
      const extractor = extractors[key];
      if (extractor) {
        dataArray.sort((a, b) => {
          let va = extractor(a), vb = extractor(b);
          if (va == null) va = '';
          if (vb == null) vb = '';
          if (typeof va === 'string') va = va.toLowerCase();
          if (typeof vb === 'string') vb = vb.toLowerCase();
          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
          return state.dir === 'asc' ? cmp : -cmp;
        });
      }
      renderFn();
      makeSortable(tableId, dataArray, extractors, renderFn); // re-attach + refresh indicators
    };
  });
}

// ── Brand mark rendering (logo / initials) ──────────────────────────────
// Used on both the pre-login page and the main app. Deliberately avoids
// swapping .innerHTML wholesale or toggling a CSS class before the image is
// known-good — the logo is only ever ADDED as an absolutely-positioned
// overlay, and only once it has actually finished loading with real pixel
// dimensions. If it never loads (missing file, bad data, slow network), the
// element just keeps showing the initials it already had — there is no
// code path that can result in a blank box. Sizing is set inline on the
// <img> itself so it can never be silently defeated by an unrelated CSS
// rule elsewhere in the stylesheet.
function schoolInitials(name) {
  return (name || 'School').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
function setBrandMarks(selector, schoolName, hasLogo) {
  const ini = schoolInitials(schoolName);
  const els = document.querySelectorAll(selector);
  els.forEach(el => {
    el.querySelectorAll('img.mark-logo-img').forEach(img => img.remove());
    el.textContent = ini;
    el.classList.remove('has-logo');
  });
  if (!hasLogo) return;
  const src = `/api/images/logo?t=${Date.now()}`;
  els.forEach(el => {
    const img = document.createElement('img');
    img.className = 'mark-logo-img';
    img.alt = 'Logo';
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center;padding:14%;box-sizing:border-box;background:#fff;';
    img.onload = () => { if (img.naturalWidth) { el.appendChild(img); el.classList.add('has-logo'); } };
    img.onerror = () => {}; // never inserted — element keeps showing its initials
    img.src = src;
  });
}
