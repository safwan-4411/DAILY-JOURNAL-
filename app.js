'use strict';

/* ===========================  SUPABASE  =========================== */
let sb = null;
let currentUser = null;

function initSupabase() {
  const cfg = window.JRNL_SUPABASE;
  if (cfg && cfg.url && cfg.anon) {
    try { sb = supabase.createClient(cfg.url, cfg.anon); }
    catch (e) { console.warn('Supabase init failed', e); }
  }
}

/* ===========================  PWA  =========================== */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredInstall = e;
  document.getElementById('install-btn')?.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  document.getElementById('install-btn')?.classList.add('hidden');
});
function handleInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(() => { deferredInstall = null; });
}

/* ===========================  STORAGE  =========================== */
const LS_KEY = 'jrnl_entries';
function getEntries()  { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; } }
function saveEntries(e) { localStorage.setItem(LS_KEY, JSON.stringify(e)); }

/* ===========================  UTILS  =========================== */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtLong(s) { return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
function fmtShort(s) { return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ===========================  IMAGE UTILS  =========================== */
function resizeImage(file, maxW = 1200, quality = 0.78) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round((h * maxW) / w); w = maxW; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ===========================  ENTRY OPS  =========================== */
function getEntry(id) { return getEntries().find(e => e.id === id); }

function getTodayEntry() {
  return getEntries().find(e => e.entry_date === todayStr()) || null;
}

function createEntry(date) {
  const entry = {
    id: uid(), entry_date: date, title: '', content: '',
    mood: '', images: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const entries = getEntries();
  entries.unshift(entry);
  saveEntries(entries);
  return entry;
}

function updateEntry(id, patch) {
  const entries = getEntries();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...patch, updated_at: new Date().toISOString() };
  saveEntries(entries);
  syncEntry(entries[idx]);
  return entries[idx];
}

function deleteEntryById(id) {
  saveEntries(getEntries().filter(e => e.id !== id));
  if (sb && currentUser) {
    sb.from('journal_entries').delete().eq('entry_id', id).then(() => {});
  }
}

/* ===========================  CLOUD SYNC  =========================== */
async function syncEntry(entry) {
  if (!sb || !currentUser) return;
  try {
    // Store images as JSONB — they're already resized/compressed base64
    await sb.from('journal_entries').upsert({
      entry_id:   entry.id,
      user_id:    currentUser.id,
      title:      entry.title,
      content:    entry.content,
      entry_date: entry.entry_date,
      mood:       entry.mood,
      images:     JSON.stringify(entry.images),
      updated_at: entry.updated_at,
    }, { onConflict: 'entry_id' });
  } catch (e) { console.warn('Sync failed', e); }
}

async function loadFromCloud() {
  if (!sb || !currentUser) return;
  try {
    const { data, error } = await sb.from('journal_entries')
      .select('*').eq('user_id', currentUser.id)
      .order('entry_date', { ascending: false });
    if (error || !data || !data.length) return;
    const entries = data.map(r => ({
      id: r.entry_id, entry_date: r.entry_date,
      title: r.title || '', content: r.content || '',
      mood: r.mood || '',
      images: typeof r.images === 'string' ? JSON.parse(r.images) : (r.images || []),
      created_at: r.created_at, updated_at: r.updated_at,
    }));
    saveEntries(entries);
  } catch (e) { console.warn('Load failed', e); }
}

/* ===========================  AUTH  =========================== */
async function signInWithGoogle() {
  if (!sb) { showToast('Sign-in not configured — using local storage.'); return; }
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
  if (error) showToast('Sign-in error: ' + error.message);
}

async function signOut() {
  if (sb) await sb.auth.signOut();
  currentUser = null;
  renderNav();
  showToast('Signed out');
}

/* ===========================  APP SHOW  =========================== */
function showApp() {
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  renderRoute();
}

/* ===========================  ROUTING  =========================== */
let currentPage = 'today';
let viewEntryId = null;
let _searchQ = '';

function navTo(page, entryId) {
  currentPage = page;
  if (entryId) viewEntryId = entryId;
  renderRoute();
}

function renderRoute() {
  ['today', 'entries', 'view'].forEach(p =>
    document.getElementById('page-' + p).classList.toggle('hidden', currentPage !== p)
  );
  renderNav();
  if (currentPage === 'today')   renderToday();
  if (currentPage === 'entries') renderEntries();
  if (currentPage === 'view')    renderView();
}

/* ===========================  NAV  =========================== */
function renderNav() {
  const items = [
    { id: 'today',   label: "Today's Entry",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>` },
    { id: 'entries', label: 'All Entries',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>` },
  ];
  const html = items.map(n =>
    `<button class="nav-item ${currentPage === n.id || (currentPage === 'view' && n.id === 'entries') ? 'active' : ''}" onclick="navTo('${n.id}')">
      ${n.icon} ${n.label}
    </button>`
  ).join('');
  document.getElementById('main-nav').innerHTML = html;
  document.getElementById('mobile-nav').innerHTML = html;

  // Sign-in btn
  const signinBtn = document.getElementById('signin-btn');
  const userBadge = document.getElementById('user-badge');
  if (currentUser) {
    signinBtn?.classList.add('hidden');
    const name = currentUser.user_metadata?.full_name || currentUser.email || 'U';
    const avatar = currentUser.user_metadata?.avatar_url;
    userBadge.classList.remove('hidden');
    userBadge.innerHTML = avatar
      ? `<img src="${esc(avatar)}" title="Sign out — ${esc(name)}" onclick="signOut()" />`
      : `<div class="avatar-initials" onclick="signOut()" title="Sign out">${esc(name[0].toUpperCase())}</div>`;
  } else {
    signinBtn?.classList.remove('hidden');
    userBadge.classList.add('hidden');
  }
}

/* ===========================  TODAY PAGE  =========================== */
let _currentEntryId = null;
let _autoSaveTimer  = null;
const MOODS = ['😊','😐','😔','😤','🙏'];

function renderToday() {
  const el = document.getElementById('page-today');
  let entry = getTodayEntry();
  if (!entry) {
    entry = createEntry(todayStr());
  }
  _currentEntryId = entry.id;

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Today's Entry</h1>
        <div class="page-subtitle">${esc(fmtLong(todayStr()))}</div>
      </div>
    </div>

    <div class="entry-card">
      <div class="entry-meta">
        <span class="entry-date-badge mono">${esc(todayStr())}</span>
        <span class="autosave-badge" id="autosave-badge">Saved ✓</span>
      </div>

      <!-- Mood -->
      <div class="mood-row">
        <span class="mood-label">Mood:</span>
        ${MOODS.map(m => `
          <button class="mood-btn ${entry.mood === m ? 'selected' : ''}" onclick="setMood('${m}')" title="${m}">${m}</button>
        `).join('')}
      </div>

      <!-- Title -->
      <textarea
        id="entry-title"
        class="title-input"
        rows="1"
        placeholder="Title (optional)…"
        oninput="autoGrow(this);scheduleAutoSave()"
      >${esc(entry.title)}</textarea>

      <!-- Content -->
      <textarea
        id="entry-content"
        class="content-textarea"
        placeholder="Write about your day…"
        oninput="autoGrow(this);scheduleAutoSave()"
      >${esc(entry.content)}</textarea>

      <!-- Images -->
      <div class="entry-images-section">
        <div class="images-toolbar">
          <label class="img-upload-label" for="img-file-input">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            Add Photos
          </label>
          <input type="file" id="img-file-input" accept="image/*" multiple style="display:none" onchange="handleImageUpload(this)" />
          <span class="img-count" id="img-count">${entry.images.length > 0 ? entry.images.length + ' photo' + (entry.images.length > 1 ? 's' : '') : ''}</span>
        </div>
        <div class="images-grid" id="images-grid">
          ${renderImageThumbs(entry.images)}
        </div>
      </div>

      <div class="entry-footer">
        <button class="btn-primary btn-sm" onclick="saveNow()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13"/><polyline points="7 3 7 8 15 8"/></svg>
          Save Entry
        </button>
      </div>
    </div>
  `;

  // Auto-grow textareas on load
  setTimeout(() => {
    autoGrow(document.getElementById('entry-title'));
    autoGrow(document.getElementById('entry-content'));
  }, 0);
}

function setMood(mood) {
  if (!_currentEntryId) return;
  const entry = getEntry(_currentEntryId);
  const newMood = entry?.mood === mood ? '' : mood; // toggle
  updateEntry(_currentEntryId, { mood: newMood });
  // Update UI without full re-render
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.textContent.trim() === newMood);
  });
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(saveNow, 1200);
}

function saveNow() {
  if (!_currentEntryId) return;
  const title   = document.getElementById('entry-title')?.value   || '';
  const content = document.getElementById('entry-content')?.value || '';
  updateEntry(_currentEntryId, { title: title.trim(), content });
  const badge = document.getElementById('autosave-badge');
  if (badge) { badge.classList.add('show'); setTimeout(() => badge.classList.remove('show'), 2000); }
}

async function handleImageUpload(input) {
  if (!input.files || !input.files.length || !_currentEntryId) return;
  const entry = getEntry(_currentEntryId);
  if (!entry) return;

  const newImages = [...entry.images];
  for (const file of input.files) {
    if (!file.type.startsWith('image/')) continue;
    const data = await resizeImage(file);
    newImages.push({ id: uid(), data, name: file.name });
  }
  updateEntry(_currentEntryId, { images: newImages });

  // Refresh image grid
  document.getElementById('images-grid').innerHTML = renderImageThumbs(newImages);
  document.getElementById('img-count').textContent = newImages.length + ' photo' + (newImages.length !== 1 ? 's' : '');
  input.value = '';
}

function removeImage(imgId) {
  if (!_currentEntryId) return;
  const entry = getEntry(_currentEntryId);
  if (!entry) return;
  const images = entry.images.filter(i => i.id !== imgId);
  updateEntry(_currentEntryId, { images });
  document.getElementById('images-grid').innerHTML = renderImageThumbs(images);
  document.getElementById('img-count').textContent = images.length > 0 ? images.length + ' photo' + (images.length !== 1 ? 's' : '') : '';
}

function renderImageThumbs(images) {
  return images.map(img => `
    <div class="img-thumb-wrap" onclick="openLightbox('${esc(img.data)}')">
      <img src="${img.data}" alt="${esc(img.name)}" loading="lazy" />
      <button class="img-remove-btn" onclick="event.stopPropagation();removeImage('${esc(img.id)}')" title="Remove">×</button>
    </div>
  `).join('');
}

/* ===========================  ALL ENTRIES PAGE  =========================== */
function renderEntries() {
  const el = document.getElementById('page-entries');
  const all = getEntries();

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">All Entries</h1>
        <div class="page-subtitle">${all.length} ${all.length === 1 ? 'entry' : 'entries'}</div>
      </div>
    </div>
    <input
      type="text" class="entries-search" placeholder="Search entries…"
      value="${esc(_searchQ)}"
      oninput="_searchQ=this.value;renderEntriesGrid()"
      id="entries-search-input"
    />
    <div class="entries-grid" id="entries-grid"></div>
  `;
  renderEntriesGrid();
}

function renderEntriesGrid() {
  const el = document.getElementById('entries-grid');
  if (!el) return;
  const q = _searchQ.toLowerCase().trim();
  const entries = getEntries()
    .filter(e => !q || e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q))
    .sort((a, b) => b.entry_date.localeCompare(a.entry_date));

  if (!entries.length) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <p>${q ? 'No entries match your search.' : 'No entries yet — start writing today!'}</p>
    </div>`;
    return;
  }

  el.innerHTML = entries.map(entry => {
    const hasTitle  = entry.title && entry.title.trim();
    const firstImg  = entry.images?.[0];
    const imgCount  = entry.images?.length || 0;
    const preview   = entry.content.replace(/\n/g, ' ').slice(0, 120);

    return `
      <div class="entry-list-card" onclick="navTo('view','${esc(entry.id)}')">
        ${firstImg ? `<img class="entry-list-thumb" src="${firstImg.data}" alt="" loading="lazy" />` : ''}
        <div class="entry-list-body">
          <div class="entry-list-top">
            <span class="entry-list-date">${esc(fmtShort(entry.entry_date))}</span>
            ${entry.mood ? `<span class="entry-list-mood">${entry.mood}</span>` : ''}
          </div>
          <div class="entry-list-title ${hasTitle ? '' : 'no-title'}">${esc(hasTitle ? entry.title : 'Untitled entry')}</div>
          ${preview ? `<div class="entry-list-preview">${esc(preview)}</div>` : ''}
        </div>
        ${imgCount > 0 ? `
          <div class="entry-list-footer">
            <span class="entry-list-img-count">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              ${imgCount} photo${imgCount !== 1 ? 's' : ''}
            </span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

/* ===========================  VIEW ENTRY PAGE  =========================== */
function renderView() {
  const el    = document.getElementById('page-view');
  const entry = viewEntryId ? getEntry(viewEntryId) : null;

  if (!entry) {
    el.innerHTML = `<div class="empty-state"><p>Entry not found.</p></div>`;
    return;
  }

  const isToday = entry.entry_date === todayStr();

  el.innerHTML = `
    <div class="page-header">
      <div>
        <button class="btn-outline btn-sm" onclick="navTo('entries')" style="margin-bottom:10px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="15 18 9 12 15 6"/></svg>
          All Entries
        </button>
      </div>
    </div>
    <div class="view-entry-card">
      <div class="view-entry-header">
        <div class="view-entry-date">
          <span>${esc(fmtLong(entry.entry_date))}</span>
          ${entry.mood ? `<span style="font-size:18px">${entry.mood}</span>` : ''}
        </div>
        <div class="view-entry-title">${esc(entry.title || 'Untitled entry')}</div>
      </div>
      <div class="view-entry-content">${esc(entry.content || '')}</div>
      ${entry.images?.length > 0 ? `
        <div class="view-entry-images">
          ${entry.images.map(img => `
            <div class="view-img-wrap" onclick="openLightbox('${esc(img.data)}')">
              <img src="${img.data}" alt="${esc(img.name)}" loading="lazy" />
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="view-entry-actions">
        ${isToday ? `
          <button class="btn-primary btn-sm" onclick="navTo('today')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Edit Entry
          </button>
        ` : ''}
        <button class="btn-danger btn-sm" onclick="confirmDelete('${esc(entry.id)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>
          Delete
        </button>
      </div>
    </div>
  `;
}

/* ===========================  DELETE CONFIRM  =========================== */
const _mActs = {};
function confirmDelete(id) {
  openModal('Delete Entry', `<p>Delete this entry permanently? This cannot be undone.</p>`, [
    { label: 'Delete', cls: 'btn-danger', key: 'del' },
    { label: 'Cancel', cls: 'btn-secondary', key: 'cancel' },
  ]);
  _mActs.del    = () => { deleteEntryById(id); closeModal(); navTo('entries'); showToast('Entry deleted'); };
  _mActs.cancel = closeModal;
}

/* ===========================  LIGHTBOX  =========================== */
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
function closeLightbox() { document.getElementById('lightbox').classList.add('hidden'); }

/* ===========================  MODAL  =========================== */
function openModal(title, body, buttons = []) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = buttons.map(b =>
    `<button class="${b.cls}" onclick="_mActs['${b.key}']()">${b.label}</button>`
  ).join('');
  document.getElementById('modal-backdrop').classList.remove('hidden');
}
function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-backdrop')) return;
  document.getElementById('modal-backdrop').classList.add('hidden');
}

/* ===========================  TOAST  =========================== */
let _tt;
function showToast(msg, ms = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ===========================  INIT  =========================== */
async function init() {
  initSupabase();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  // Always open app directly
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  if (sb) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session?.user) {
        currentUser = session.user;
        await loadFromCloud();
      }
      sb.auth.onAuthStateChange(async (_e, session) => {
        currentUser = session?.user || null;
        if (currentUser) { await loadFromCloud(); }
        renderRoute();
      });
    } catch (e) { console.warn('Auth init failed', e); }
  }

  renderRoute();
}

document.addEventListener('DOMContentLoaded', init);
