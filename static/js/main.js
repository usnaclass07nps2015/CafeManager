const state = { cart: [], pendingDrink: null, orderType: 'here', customerName: '' };
let lastKnownOrderId = 0;
let notificationTimer = null;
let soundEnabled = localStorage.getItem('cafe_sound') !== 'off';
let currentUserRole = null;
let currentUsername = '';
const pageCache = {};
let cacheTimer = null;
let displayMode = 'auto';
try { displayMode = localStorage.getItem('cafe_display') || 'auto'; } catch(e) {}

function detectCompactNeeded() {
  if (displayMode === 'full') return false;
  if (displayMode === 'compact') return true;
  return window.innerWidth <= 1100;
}

function applyDisplayMode() {
  const compact = detectCompactNeeded();
  document.body.classList.toggle('compact', compact);
  const btn = document.getElementById('display-toggle');
  if (btn) {
    btn.textContent = compact ? 'F' : 'C';
    btn.title = (compact ? 'Fit (tablet)' : 'Computer (desktop)') + ' (' + window.innerWidth + 'px)';
  }
}

function toggleDisplayMode() {
  displayMode = detectCompactNeeded() ? 'full' : 'compact';
  try { localStorage.setItem('cafe_display', displayMode); } catch(e) {}
  applyDisplayMode();
}

window.addEventListener('resize', applyDisplayMode);

function navigate(page) {
  const navLinks = document.querySelectorAll('.topbar-nav a');
  navLinks.forEach(l => l.classList.remove('active'));
  const link = document.querySelector(`.topbar-nav a[data-page="${page}"]`);
  if (link) link.classList.add('active');
  const container = document.getElementById('page-content');
  if (!container) return;
  container.innerHTML = `<div class="loading">${t('general.loading')}</div>`;
  switch (page) {
    case 'dashboard': renderDashboard(container); break;
    case 'menu': renderMenu(container); break;
    case 'cashier': renderCashier(container); break;
    case 'promotions': renderPromotions(container); break;
    case 'ads': renderAds(container); break;
    case 'orders': renderOrders(container); break;
    case 'users': renderUsers(container); break;
  }
}

async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  if (method === 'GET') {
    if (pageCache[url]) return pageCache[url];
    const r = await fetch(url, opts);
    const data = await r.json();
    pageCache[url] = data;
    return data;
  }
  const r = await fetch(url, opts);
  const data = await r.json();
  Object.keys(pageCache).forEach(k => delete pageCache[k]);
  return data;
}

// ─── Role helpers ────────────────────────────────────────────────────
function isAdmin() { return currentUserRole === 'admin'; }
function isAdminOrManager() { return currentUserRole === 'admin' || currentUserRole === 'manager'; }

function applyRoleUI() {
  // Staff sees only: Dashboard, Cashier, Orders
  // Manager + Admin see: Menu, Promotions, Ads
  // Admin only: Users
  const managerPages = ['menu', 'promotions', 'ads'];
  const adminOnlyPages = ['users'];
  document.querySelectorAll('.topbar-nav a').forEach(a => {
    const page = a.dataset.page;
    if (adminOnlyPages.includes(page)) {
      a.style.display = isAdmin() ? '' : 'none';
    } else if (managerPages.includes(page)) {
      a.style.display = isAdminOrManager() ? '' : 'none';
    }
  });
}

let speechVoices = [];
function preloadVoices() {
  const synth = window.speechSynthesis;
  if (!synth) return;
  speechVoices = synth.getVoices();
  if (!speechVoices.length) {
    synth.addEventListener('voiceschanged', () => { speechVoices = synth.getVoices(); }, { once: true });
  }
}

// ─── New Order Polling & Notification ────────────────────────────────
async function checkNewOrders() {
  try {
    const orders = await api('/api/sales');
    if (!orders.length) return;
    const latestId = orders[0].id;
    if (lastKnownOrderId === 0) {
      lastKnownOrderId = latestId;
      return;
    }
    // Check for any orders with id > lastKnownOrderId (orders come DESC, so find them)
    const newOrders = orders.filter(o => o.id > lastKnownOrderId);
    if (newOrders.length) {
      lastKnownOrderId = latestId;
      // Notify for each new order (reverse so oldest new one first)
      newOrders.reverse().forEach(order => showNewOrderNotification(order));
    }
  } catch (e) {
    // silent
  }
}

function playNotificationSound() {
  if (!soundEnabled) return;
  try {
    // Web Audio API beep — works everywhere, no autoplay restrictions after user gesture
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    [880, 1100].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.2);
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.2);
      osc.stop(ctx.currentTime + i * 0.2 + 0.2);
    });
    // Also try SpeechSynthesis as enhancement (may silently fail on some browsers)
    try {
      const synth = window.speechSynthesis;
      if (synth) {
        synth.cancel();
        if (synth.paused) synth.resume();
        const voice = speechVoices.find(v =>
          /zira|hazel|susan|kate|female|google.*english|samantha|victoria|tessa|moira|fiona|nora|alice|lisa|emma|ava|sarah|julia|naomi|aya|haruka/gi.test(v.name)
        );
        const utter = new SpeechSynthesisUtterance(t('notification.new_order'));
        utter.rate = 0.9;
        utter.volume = 1;
        utter.lang = currentLang === 'th' ? 'th-TH' : 'en-US';
        if (voice) utter.voice = voice;
        utter.onerror = () => {};
        synth.speak(utter);
      }
    } catch (e) { /* silent */ }
  } catch (e) { /* silent */ }
}

function showNewOrderNotification(order) {
  const el = document.getElementById('order-notification');
  const textEl = document.getElementById('order-notification-text');
  if (!el || !textEl) return;
  const msg = t('notification.new_order_with_number') + (order.daily_seq || order.id);
  textEl.textContent = msg;

  // Cancel existing auto-dismiss
  if (notificationTimer) { clearTimeout(notificationTimer); }

  // Show and schedule dismiss
  el.style.display = 'block';
  notificationTimer = setTimeout(() => { el.style.display = 'none'; }, 8000);

  playNotificationSound();
}

function dismissNotification() {
  const el = document.getElementById('order-notification');
  if (el) el.style.display = 'none';
  if (notificationTimer) { clearTimeout(notificationTimer); notificationTimer = null; }
}

function toggleSound() {
  const cb = document.getElementById('sound-toggle');
  soundEnabled = cb.checked;
  localStorage.setItem('cafe_sound', soundEnabled ? 'on' : 'off');
}

function startOrderPolling() {
  // Initialise last known order ID, then check immediately
  api('/api/sales').then(orders => {
    if (orders.length) lastKnownOrderId = orders[0].id;
    checkNewOrders(); // check right after init
  }).catch(() => {});
  // Poll every 3 seconds
  setInterval(checkNewOrders, 3000);
}

// ─── Dashboard ───────────────────────────────────────────────────────
async function renderDashboard(container) {
  const d = await api('/api/dashboard');
  container.innerHTML = `
    <div class="page-header"><h1>&#x1F9C1; ${t('dashboard.title')} <span style="font-size:1.2rem;font-weight:600;background:var(--success);color:#fff;padding:0.3rem 1rem;border-radius:20px;vertical-align:middle">${currentUsername}</span></h1></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-number">${d.menu_count}</div><div class="stat-label">${t('dashboard.menu_items')}</div></div>
      <div class="stat-card"><div class="stat-number">${d.today_orders}</div><div class="stat-label">${t('dashboard.today_orders')}</div></div>
      <div class="stat-card"><div class="stat-number">฿${d.today_revenue.toFixed(2)}</div><div class="stat-label">${t('dashboard.today_revenue')}</div></div>
      <div class="stat-card"><div class="stat-number">${d.active_promotions}</div><div class="stat-label">${t('dashboard.active_promotions')}</div></div>
      <div class="stat-card"><div class="stat-number">${d.active_ads}</div><div class="stat-label">${t('dashboard.active_ads')}</div></div>
    </div>
    <div class="card">
      <h3>&#x1F4CA; ${t('dashboard.recent_orders')}</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>${t('dashboard.items')}</th><th>${t('cashier.total')}</th><th>${t('general.time')||'Time'}</th></tr></thead>
          <tbody>
            ${d.recent_sales.length ? d.recent_sales.map(s => `
              <tr><td>#${s.daily_seq || s.id}</td><td>${JSON.parse(s.items).length} ${t('dashboard.items')}</td><td>฿${s.total.toFixed(2)}</td><td>${new Date(s.created_at).toLocaleTimeString()}</td></tr>
            `).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--text-light)">'+t('dashboard.no_orders')+'</td></tr>'}
        </tbody>
      </table>
    </div>
    </div>`;
}

function formatDrinkConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  const parts = [];
  if (cfg.hot) parts.push(cfg.hot_price ? `Hot +฿${cfg.hot_price}` : 'Hot');
  if (cfg.iced) parts.push(cfg.iced_price ? `Iced +฿${cfg.iced_price}` : 'Iced');
  return parts.join(', ') || '—';
}

let editingItemId = null;

function toggleDrinkConfig() {
  const cat = document.getElementById('item-category').value;
  const section = document.getElementById('drink-config-section');
  section.style.display = cat === 'drink' ? '' : 'none';
}

function toggleTempPrice(type) {
  const cb = document.getElementById('drink-' + type);
  const price = document.getElementById(type + '-price');
  price.style.display = cb.checked ? 'inline-block' : 'none';
}

async function openMenuModal(id = null) {
  editingItemId = id;
  document.getElementById('modal-title').textContent = id ? t('menu.edit_title') : t('menu.add_title');
  document.querySelectorAll('.modal-form').forEach(f => f.style.display = 'none');
  document.getElementById('form-menu').style.display = 'block';
  toggleDrinkConfig();
  if (id) {
    const items = await api('/api/menu');
    const item = items.find(x => x.id === id);
    if (!item) return;
    document.getElementById('item-name').value = item.name;
    document.getElementById('item-category').value = item.category;
    document.getElementById('item-price').value = item.price;
    document.getElementById('item-desc').value = item.description || '';
    document.getElementById('item-available').value = item.available;
    toggleDrinkConfig();
    const dc = item.drink_config || {};
    document.getElementById('drink-hot').checked = !!dc.hot;
    document.getElementById('hot-price').value = dc.hot_price || '';
    document.getElementById('hot-price').style.display = dc.hot ? 'inline-block' : 'none';
    document.getElementById('drink-iced').checked = !!dc.iced;
    document.getElementById('iced-price').value = dc.iced_price || '';
    document.getElementById('iced-price').style.display = dc.iced ? 'inline-block' : 'none';
  } else {
    document.getElementById('item-name').value = '';
    document.getElementById('item-category').value = 'drink';
    document.getElementById('item-price').value = '';
    document.getElementById('item-desc').value = '';
    document.getElementById('item-available').value = '1';
    document.getElementById('drink-hot').checked = false;
    document.getElementById('hot-price').value = '';
    document.getElementById('hot-price').style.display = 'none';
    document.getElementById('drink-iced').checked = false;
    document.getElementById('iced-price').value = '';
    document.getElementById('iced-price').style.display = 'none';
  }
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveMenuItem() {
  const drinkConfig = {
    hot: document.getElementById('drink-hot').checked,
    hot_price: parseFloat(document.getElementById('hot-price').value) || 0,
    iced: document.getElementById('drink-iced').checked,
    iced_price: parseFloat(document.getElementById('iced-price').value) || 0
  };
  const data = {
    name: document.getElementById('item-name').value.trim(),
    category: document.getElementById('item-category').value,
    price: parseFloat(document.getElementById('item-price').value) || 0,
    description: document.getElementById('item-desc').value.trim(),
    image: document.getElementById('ad-image').value,
    available: parseInt(document.getElementById('item-available').value),
    drink_config: drinkConfig
  };
  if (!data.name) return;
  if (editingItemId) {
    await api('/api/menu/' + editingItemId, 'PUT', data);
  } else {
    await api('/api/menu', 'POST', data);
  }
  closeModal();
  navigate('menu');
}

async function deleteMenuItem(id) {
  if (!confirm(t('menu.confirm_delete'))) return;
  await api('/api/menu/' + id, 'DELETE');
  navigate('menu');
}

async function exportCSV() {
  const r = await fetch('/api/menu/export');
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'menu.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/menu/import', { method: 'POST', body: fd });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
  let msg = t('menu.import_ok') + ': ' + data.added + ' ' + t('menu.import_added') + ', ' + data.updated + ' ' + t('menu.import_updated');
  if (data.errors && data.errors.length) msg += '\n' + data.errors.join('\n');
  alert(msg);
  input.value = '';
  delete pageCache['/api/menu'];
  navigate('menu');
}

async function toggleAvailability(id) {
  const res = await api(`/api/menu/${id}/availability`, 'PATCH');
  if (res.error) { alert(res.error); return; }
  delete pageCache['/api/menu'];
  navigate('menu');
}

// ─── Menu ────────────────────────────────────────────────────────────
async function renderMenu(container) {
  const items = await api('/api/menu');
  container.innerHTML = `
    <div class="page-header">
      <h1>&#x1F372; ${t('menu.title')}</h1>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        ${isAdmin() ? `<button class="btn btn-primary" onclick="openMenuModal()">${t('menu.add')}</button>
        <button class="btn btn-accent" onclick="exportCSV()">&#x1F4E4; ${t('menu.export')}</button>
        <label class="btn btn-outline" style="cursor:pointer">
          &#x1F4E5; ${t('menu.import')}
          <input type="file" accept=".csv" style="display:none" onchange="importCSV(this)">
        </label>` : ''}
      </div>
    </div>
    <div class="table-wrap card">
      <table>
        <thead><tr><th>${t('menu.name')}</th><th>${t('menu.category')}</th><th>${t('menu.price')}</th><th>${t('menu.drink_opts_summary')}</th><th>${t('menu.available')}</th>${isAdminOrManager() ? `<th>${t('menu.actions')}</th>` : ''}</tr></thead>
        <tbody>
          ${items.map(i => `
            <tr>
              <td><strong>${i.name}</strong><br><small style="color:var(--text-light)">${i.description||''}</small></td>
              <td><span class="badge ${i.category==='drink'?'badge-active':i.category==='addon'?'badge-warning':'badge-inactive'}">${i.category==='drink' ? t('menu.drink_label') : i.category==='addon' ? t('menu.addon_label') : t('menu.bakery_label')}</span></td>
              <td>฿${i.price.toFixed(2)}</td>
              <td>${i.category==='drink' && i.drink_config ? formatDrinkConfig(i.drink_config) : '<span style="color:var(--text-light)">'+t('general.no_data')+'</span>'}</td>
              <td><span class="badge ${i.available ? 'badge-active' : 'badge-inactive'}">${i.available ? t('menu.yes') : t('menu.no')}</span></td>
              ${isAdminOrManager() ? `<td style="white-space:nowrap">
                ${isAdmin() ? `
                <button class="btn btn-sm btn-outline" onclick="openMenuModal(${i.id})">${t('menu.edit')}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteMenuItem(${i.id})">${t('menu.delete')}</button>` : `
                <button class="btn btn-sm ${i.available ? 'btn-outline' : 'btn-primary'}" onclick="toggleAvailability(${i.id})">${i.available ? t('menu.disable')||'Disable' : t('menu.enable')||'Enable'}</button>`}
              </td>` : ''}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Cashier ─────────────────────────────────────────────────────────
async function renderCashier(container) {
  const items = await api('/api/menu');
  const promos = await api('/api/promotions');
  const drinks = items.filter(i => i.category === 'drink');
  const bakery = items.filter(i => i.category === 'bakery');
  const addons = items.filter(i => i.category === 'addon');
  container.innerHTML = `
    <div class="page-header"><h1>&#x1F9FE; ${t('cashier.title')}</h1></div>
    <div class="cashier-layout">
      <div class="cashier-items">
        <div class="card">
          <h3>&#x2615; ${t('menu.drink_label')}</h3>
          <div class="menu-grid" id="drink-grid">
            ${drinks.map(i => `
              <div class="menu-item-card" onclick="${i.available ? `openDrinkCustom(${JSON.stringify(i).replace(/"/g,'&quot;')})` : ''}" style="${i.available ? '' : 'opacity:0.5;cursor:not-allowed'}">
                ${i.image ? `<div class="item-img" style="background-image:url('${i.image}')"></div>` : '<div class="item-icon">&#x2615;</div>'}
                <div class="item-name">${i.name}</div>
                <div class="item-desc">${i.description||''}</div>
                <div class="item-price">฿${i.price.toFixed(2)}</div>
                ${i.available ? '' : '<div style="color:var(--danger);font-weight:700;font-size:0.75rem;margin-top:0.2rem">'+t('menu.unavailable_label')+'</div>'}
              </div>
            `).join('')}
          </div>
        </div>
        <div class="card">
          <h3>&#x1F9C1; ${t('cashier.bakery')}</h3>
          <div class="menu-grid" id="bakery-grid">
            ${bakery.map(i => `
              <div class="menu-item-card" onclick="${i.available ? `addToCart(${i.id},'${i.name.replace(/'/g,"\\'")}',${i.price},'bakery')` : ''}" style="${i.available ? '' : 'opacity:0.5;cursor:not-allowed'}">
                ${i.image ? `<div class="item-img" style="background-image:url('${i.image}')"></div>` : '<div class="item-icon">&#x1F9C1;</div>'}
                <div class="item-name">${i.name}</div>
                <div class="item-price">฿${i.price.toFixed(2)}</div>
                ${i.available ? '' : '<div style="color:var(--danger);font-weight:700;font-size:0.75rem;margin-top:0.2rem">'+t('menu.unavailable_label')+'</div>'}
              </div>
            `).join('')}
          </div>
        </div>
        ${addons.length ? `
        <div class="card">
          <h3>&#x2795; ${t('menu.addon_label')}</h3>
          <div class="menu-grid" id="addon-grid">
            ${addons.map(i => `
              <div class="menu-item-card" onclick="${i.available ? `addToCart(${i.id},'${i.name.replace(/'/g,"\\'")}',${i.price},'addon')` : ''}" style="${i.available ? '' : 'opacity:0.5;cursor:not-allowed'}">
                ${i.image ? `<div class="item-img" style="background-image:url('${i.image}')"></div>` : '<div class="item-icon">&#x2795;</div>'}
                <div class="item-name">${i.name}</div>
                <div class="item-price">฿${i.price.toFixed(2)}</div>
                ${i.available ? '' : '<div style="color:var(--danger);font-weight:700;font-size:0.75rem;margin-top:0.2rem">'+t('menu.unavailable_label')+'</div>'}
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
      </div>
      <div class="cashier-cart" id="cart-panel">
        <h3>&#x1F6D2; ${t('cashier.current_order')}</h3>
        <div style="margin-bottom:0.6rem">
          <input class="form-control" id="customer-name" placeholder="${t('cashier.customer_name') || 'Customer name (optional)'}" style="font-size:0.9rem" oninput="state.customerName=this.value">
        </div>
        <div style="margin-bottom:0.8rem;display:flex;gap:0.8rem;align-items:center">
          <label style="cursor:pointer"><input type="radio" name="order-type" value="here" checked onchange="state.orderType=this.value"> &#x1F3E0; ${t('service.dine_in')}</label>
          <label style="cursor:pointer"><input type="radio" name="order-type" value="takeaway" onchange="state.orderType=this.value"> &#x1F4EB; ${t('service.takeaway')}</label>
        </div>
        <div id="promo-selector" style="margin-bottom:0.8rem">
          <select class="form-control" id="discount-select" onchange="updateCartTotal()">
            <option value="0">${t('cashier.no_discount')}</option>
            ${promos.filter(p => p.active).map(p => `
              <option value="${p.discount_percent}">${p.name} (${p.discount_percent}% off)</option>
            `).join('')}
          </select>
        </div>
        <div class="cart-items" id="cart-items">
          <p style="color:var(--text-light);text-align:center">${t('cashier.cart_empty')}</p>
        </div>
        <div class="cart-total" id="cart-total">฿0.00</div>
        <button class="btn btn-success" style="width:100%;margin-top:0.5rem" onclick="checkout()" id="checkout-btn" disabled>${t('cashier.checkout')}</button>
      </div>
    </div>
  `;
}

// ─── Drink Customization ─────────────────────────────────────────────
async function openDrinkCustom(item) {
  const cfg = item.drink_config || {};
  // normalise legacy temperature format
  if (cfg.temperature && !cfg.hot && !cfg.iced) { cfg.hot = true; cfg.iced = true; }
  const allItems = await api('/api/menu');
  const addonItems = allItems.filter(i => i.category === 'addon' && i.available);

  const initTemp = cfg.iced ? 'Iced' : 'Hot';
  state.pendingDrink = { ...item, drink_config: cfg, addonTotal: 0, chosenTemp: initTemp, chosenSugar: 'Normal', chosenAddons: {}, _addonItems: addonItems };
  document.getElementById('drink-custom-title').innerHTML = `&#x2615; ${item.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}`;

  // temperature radio buttons
  const tempSection = document.getElementById('drink-custom-temp-section');
  const tempContainer = document.getElementById('drink-custom-temp-options');
  tempContainer.innerHTML = '';
  const hasHot = cfg.hot, hasIced = cfg.iced;
  if (hasHot || hasIced) {
    tempSection.style.display = 'block';
    const tempOpts = [];
    if (hasHot) tempOpts.push('Hot');
    if (hasIced) tempOpts.push('Iced');
    tempOpts.forEach((val, i) => {
      const label = document.createElement('label');
      label.style.marginRight = '1rem'; label.style.cursor = 'pointer';
      const checked = i === 0 ? 'checked' : '';
      label.innerHTML = `<input type="radio" name="drink-temp" value="${val}" ${checked} onchange="onTempChange()"> ${t(val === 'Hot' ? 'cashier.hot' : 'cashier.iced')}`;
      tempContainer.appendChild(label);
    });
  } else {
    tempSection.style.display = 'none';
  }

  // sugar level radio buttons (always shown)
  const sugarSection = document.getElementById('drink-custom-sugar-section');
  const sugarContainer = document.getElementById('drink-custom-sugar-options');
  sugarContainer.innerHTML = '';
  const sugarMap = [
    { key: 'no_sugar', val: 'No Sugar', i18n: 'cashier.no_sugar' },
    { key: 'sugar_25', val: '25%', i18n: 'cashier.sugar_25' },
    { key: 'sugar_50', val: '50%', i18n: 'cashier.sugar_50' },
    { key: 'sugar_normal', val: 'Normal', i18n: 'cashier.normal' }
  ];
  sugarSection.style.display = 'block';
  sugarMap.forEach((s, i) => {
    const label = document.createElement('label');
    label.style.marginRight = '1rem'; label.style.cursor = 'pointer';
    const checked = i === 0 ? 'checked' : '';
    label.innerHTML = `<input type="radio" name="drink-sugar" value="${s.val}" ${checked} onchange="updateDrinkCustomTotal()"> ${t(s.i18n)}`;
    sugarContainer.appendChild(label);
  });

  // addon items checkboxes
  const addonContainer = document.getElementById('drink-custom-addons');
  addonContainer.innerHTML = '';
  if (addonItems.length) {
    document.getElementById('drink-custom-addons-section').style.display = 'block';
    addonItems.forEach((a, idx) => {
      const label = document.createElement('label');
      label.style.display = 'block'; label.style.marginBottom = '0.3rem'; label.style.cursor = 'pointer';
      label.innerHTML = `<input type="checkbox" data-idx="${idx}" onchange="toggleDrinkAddon(${idx})"> ${a.name} <span style="color:var(--accent);font-weight:600">+฿${a.price.toFixed(2)}</span>`;
      addonContainer.appendChild(label);
    });
  } else {
    document.getElementById('drink-custom-addons-section').style.display = 'none';
  }

  document.getElementById('drink-custom-modal').classList.add('open');
  onTempChange();
}

function toggleDrinkAddon(idx) {
  const checked = document.querySelector(`#drink-custom-addons input[data-idx="${idx}"]`).checked;
  const addon = state.pendingDrink._addonItems[idx];
  if (!addon) return;
  if (checked) state.pendingDrink.chosenAddons[idx] = addon;
  else delete state.pendingDrink.chosenAddons[idx];
  updateDrinkCustomTotal();
}

function onTempChange() {
  updateDrinkCustomTotal();
  const item = state.pendingDrink;
  const cfg = item.drink_config || {};
  const tempRadio = document.querySelector('input[name="drink-temp"]:checked');
  const temp = tempRadio ? tempRadio.value : 'Hot';
  const basePrice = temp === 'Hot' ? (cfg.hot_price || item.price) : (cfg.iced_price || item.price);
  document.getElementById('drink-custom-base').innerHTML = `${t('cashier.base_price')}: ฿${basePrice.toFixed(2)} <small style="color:var(--text-light);font-weight:400">(${temp})</small>`;
}

function updateDrinkCustomTotal() {
  const item = state.pendingDrink;
  const cfg = item.drink_config || {};
  item.addonTotal = Object.values(item.chosenAddons).reduce((s, a) => s + a.price, 0);
  const tempRadio = document.querySelector('input[name="drink-temp"]:checked');
  item.temp = tempRadio ? tempRadio.value : 'Hot';
  const sugarRadio = document.querySelector('input[name="drink-sugar"]:checked');
  item.sugar = sugarRadio ? sugarRadio.value : 'Normal';
  const basePrice = item.temp === 'Hot' ? (cfg.hot_price || item.price) : (cfg.iced_price || item.price);
  document.getElementById('drink-custom-total').textContent = (basePrice + item.addonTotal).toFixed(2);
}

function closeDrinkCustom() {
  document.getElementById('drink-custom-modal').classList.remove('open');
  state.pendingDrink = null;
}

function confirmDrinkCustom() {
  const item = state.pendingDrink;
  const cfg = item.drink_config || {};
  const addonNames = Object.values(item.chosenAddons).map(a => a.name);
  const extras = [];
  if (cfg.hot || cfg.iced) extras.push(item.temp);
  extras.push(item.sugar);
  if (addonNames.length) extras.push(addonNames.join(', '));
  const label = extras.length ? `${item.name} (${extras.join(', ')})` : item.name;
  const basePrice = item.temp === 'Hot' ? (cfg.hot_price || item.price) : (cfg.iced_price || item.price);
  const totalPrice = basePrice + item.addonTotal;
  const existing = state.cart.find(c => c.customLabel === label && c.id === item.id);
  if (existing) { existing.qty += 1; }
  else { state.cart.push({ id: item.id, name: label, price: totalPrice, category: 'drink', qty: 1, customLabel: label }); }
  closeDrinkCustom();
  renderCart();
}

// ─── Cart ────────────────────────────────────────────────────────────
function addToCart(id, name, price, category) {
  const existing = state.cart.find(c => c.id === id && !c.customLabel);
  if (existing) { existing.qty += 1; }
  else { state.cart.push({ id, name, price, category, qty: 1 }); }
  renderCart();
}

function renderCart() {
  const el = document.getElementById('cart-items');
  const totalEl = document.getElementById('cart-total');
  const btn = document.getElementById('checkout-btn');
  if (!el) return;
  if (state.cart.length === 0) {
    el.innerHTML = `<p style="color:var(--text-light);text-align:center">${t('cashier.cart_empty')}</p>`;
    totalEl.textContent = '฿0.00';
    if (btn) btn.disabled = true;
    return;
  }
  el.innerHTML = state.cart.map((c, i) => `
    <div class="cart-item">
      <span><strong>${c.name}</strong></span>
      <span class="cart-qty">
        <button onclick="changeQty(${i},-1)">−</button>
        <span>${c.qty}</span>
        <button onclick="changeQty(${i},1)">+</button>
        <span style="width:60px;text-align:right;font-weight:600">฿${(c.price * c.qty).toFixed(2)}</span>
        <button onclick="removeFromCart(${i})" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:1rem;">✕</button>
      </span>
    </div>
  `).join('');
  updateCartTotal();
  if (btn) btn.disabled = false;
}

function changeQty(idx, delta) {
  state.cart[idx].qty += delta;
  if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
  renderCart();
}

function removeFromCart(idx) {
  state.cart.splice(idx, 1);
  renderCart();
}

function updateCartTotal() {
  const subtotal = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const discPct = parseFloat(document.getElementById('discount-select')?.value || 0);
  const discount = subtotal * (discPct / 100);
  const total = subtotal - discount;
  const el = document.getElementById('cart-total');
  if (el) el.textContent = `฿${total.toFixed(2)}`;
  return { subtotal, discount, total };
}

async function checkout() {
  if (state.cart.length === 0) return;
  const { subtotal, discount, total } = updateCartTotal();
  showReceiptPreview({ subtotal, discount, total });
}

function showReceiptPreview({ subtotal, discount, total }) {
  if (document.getElementById('receipt-preview-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'receipt-preview-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <h2>&#x1F4CB; ${t('cashier.receipt_preview') || 'Receipt Preview'}</h2>
      <div style="margin:1rem 0;border:1px dashed var(--border);border-radius:8px;padding:1rem;background:var(--bg-secondary)">
        <div style="text-align:center;margin-bottom:0.8rem">
          <div style="font-weight:700;font-size:1.1rem">Homlamoon</div>
          <div style="font-size:0.8rem;color:var(--text-light)">${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}</div>
          <div style="font-size:0.8rem;color:var(--text-light)">${t(state.orderType === 'takeaway' ? 'service.takeaway' : 'service.dine_in')}</div>
          ${state.customerName ? `<div style="font-size:0.8rem;color:var(--text-light)">${t('cashier.customer_name') || 'Customer'}: ${state.customerName}</div>` : ''}
        </div>
        <div style="border-top:1px dashed var(--border);padding-top:0.5rem">
          ${state.cart.map(c => `
            <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:0.9rem">
              <span style="flex:1">${c.name} <span style="color:var(--text-light);font-size:0.8rem">x${c.qty}</span></span>
              <span style="font-weight:600">฿${(c.price * c.qty).toFixed(2)}</span>
            </div>
          `).join('')}
        </div>
        <div style="border-top:1px dashed var(--border);padding-top:0.5rem;margin-top:0.5rem">
          <div style="display:flex;justify-content:space-between;font-size:0.9rem">
            <span>${t('orders.subtotal')}</span>
            <span>฿${subtotal.toFixed(2)}</span>
          </div>
          ${discount > 0 ? `
          <div style="display:flex;justify-content:space-between;font-size:0.9rem;color:var(--danger)">
            <span>${t('orders.discount')}</span>
            <span>-฿${discount.toFixed(2)}</span>
          </div>` : ''}
          <div style="display:flex;justify-content:space-between;font-size:1.1rem;font-weight:700;color:var(--primary);margin-top:0.3rem">
            <span>${t('orders.total')}</span>
            <span>฿${total.toFixed(2)}</span>
          </div>
        </div>
      </div>
      <div style="margin-top:0.8rem">
        <label style="font-size:0.85rem;font-weight:600;color:var(--text-light);display:block;margin-bottom:0.3rem">${t('orders.payment_method')}</label>
        <div style="display:flex;gap:0.5rem">
          <label style="flex:1;padding:0.4rem;border:2px solid var(--border);border-radius:8px;text-align:center;cursor:pointer;font-size:0.9rem;background:var(--bg-secondary)" onclick="selectPayment('cash')">
            <input type="radio" name="payment-method" value="cash" checked onchange="selectPayment('cash')"> &#x1F4B5; ${t('orders.cash')}
          </label>
          <label style="flex:1;padding:0.4rem;border:2px solid var(--border);border-radius:8px;text-align:center;cursor:pointer;font-size:0.9rem;background:var(--bg-secondary)" onclick="selectPayment('promptpay')">
            <input type="radio" name="payment-method" value="promptpay" onchange="selectPayment('promptpay')"> &#x1F4B3; PromptPay
          </label>
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.8rem">
        <button class="btn btn-outline" onclick="closeReceiptPreview()">${t('menu.cancel')}</button>
        <button class="btn btn-primary" onclick="confirmOrder()">${t('cashier.confirm_order') || 'Confirm Order'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  state._receiptData = { subtotal, discount, total };
  state._paymentMethod = 'cash';
}

function selectPayment(method) {
  state._paymentMethod = method;
  document.querySelectorAll('input[name="payment-method"]').forEach(r => r.checked = r.value === method);
}

function closeReceiptPreview() {
  const el = document.getElementById('receipt-preview-overlay');
  if (el) el.remove();
  delete state._receiptData;
}

async function confirmOrder() {
  const { subtotal, discount, total } = state._receiptData || {};
  if (subtotal == null) return;
  const paymentMethod = state._paymentMethod || 'cash';
  const items = state.cart.map(c => ({ id: c.id, name: c.name, price: c.price, qty: c.qty }));
  const sale = await api('/api/sales', 'POST', { items, subtotal, discount, total, payment_method: paymentMethod, order_type: state.orderType, customer_name: state.customerName });
  const saleId = sale.id || '—';
  const saleSeq = sale.daily_seq || null;
  // Show saved receipt with print button
  showSavedReceipt({ items, subtotal, discount, total, id: saleId, dailySeq: saleSeq, paymentMethod });
}

function showSavedReceipt({ items, subtotal, discount, total, id, dailySeq, paymentMethod }) {
  // Store for print
  const isPromptpayPending = paymentMethod === 'promptpay';
  state._lastReceipt = { items, subtotal, discount, total, id, dailySeq, paymentMethod, orderType: state.orderType, customerName: state.customerName, paymentConfirmed: !isPromptpayPending };
  const displayId = dailySeq || id;
  closeReceiptPreview();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'saved-receipt-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <h2>&#x2705; ${t('cashier.order_confirmed') || 'Order Confirmed'}</h2>
      <div style="margin:1rem 0;border:1px dashed var(--border);border-radius:8px;padding:1rem;background:var(--bg-secondary)">
        <div style="text-align:center;margin-bottom:0.8rem">
          <div style="font-weight:700;font-size:1.1rem">Homlamoon</div>
          <div style="font-size:0.8rem;color:var(--text-light)">${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}</div>
          <div style="font-size:0.8rem;color:var(--text-light)">#${displayId} &middot; ${t(state.orderType === 'takeaway' ? 'service.takeaway' : 'service.dine_in')}</div>
          ${state.customerName ? `<div style="font-size:0.8rem;color:var(--text-light)">${t('cashier.customer_name') || 'Customer'}: ${state.customerName}</div>` : ''}
          <div style="margin-top:0.4rem">
            <span class="badge badge-active" style="background:var(--border);color:var(--text);font-size:0.85rem">${paymentMethod === 'promptpay' ? 'PromptPay' : t('orders.cash')}</span>
            <span id="payment-status-badge" class="badge" style="font-size:0.85rem;${isPromptpayPending ? 'background:#F9A825;color:#3E2723' : 'background:#2E7D32;color:#FFF'}">${isPromptpayPending ? t('orders.payment_pending') : t('orders.payment_complete')}</span>
          </div>
        </div>
        <div style="border-top:1px dashed var(--border);padding-top:0.5rem">
          ${items.map(i => `
            <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:0.9rem">
              <span style="flex:1">${i.name} <span style="color:var(--text-light);font-size:0.8rem">x${i.qty}</span></span>
              <span style="font-weight:600">฿${(i.price * i.qty).toFixed(2)}</span>
            </div>
          `).join('')}
        </div>
        <div style="border-top:1px dashed var(--border);padding-top:0.5rem;margin-top:0.5rem">
          <div style="display:flex;justify-content:space-between;font-size:0.9rem">
            <span>${t('orders.subtotal')}</span><span>฿${subtotal.toFixed(2)}</span>
          </div>
          ${discount > 0 ? `
          <div style="display:flex;justify-content:space-between;font-size:0.9rem;color:var(--danger)">
            <span>${t('orders.discount')}</span><span>-฿${discount.toFixed(2)}</span>
          </div>` : ''}
          <div style="display:flex;justify-content:space-between;font-size:1.1rem;font-weight:700;color:var(--primary);margin-top:0.3rem">
            <span>${t('orders.total')}</span><span>฿${total.toFixed(2)}</span>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end">
        ${isPromptpayPending ? `<button class="btn btn-success" id="confirm-payment-btn" onclick="confirmPromptpayFromReceipt()">${t('orders.confirm_payment')}</button>` : ''}
        <button class="btn btn-outline" onclick="closeSavedReceipt()">${t('orders.close')}</button>
        <button class="btn btn-primary" onclick="printSavedReceipt('kitchen')">&#x1F5A8; ${t('cashier.print')} Kitchen</button>
        <button class="btn btn-primary" onclick="printSavedReceipt('customer')">&#x1F5A8; ${t('cashier.print')} Customer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  state.cart = [];
  renderCart();
}

async function confirmPromptpayFromReceipt() {
  const r = state._lastReceipt;
  if (!r || !r.id) return;
  await api(`/api/sales/${r.id}/confirm-payment`, 'POST');
  r.paymentConfirmed = true;
  const badge = document.getElementById('payment-status-badge');
  const btn = document.getElementById('confirm-payment-btn');
  if (badge) {
    badge.textContent = t('orders.payment_complete');
    badge.style.background = '#2E7D32';
    badge.style.color = '#FFF';
  }
  if (btn) btn.remove();
}

function closeSavedReceipt() {
  const el = document.getElementById('saved-receipt-overlay');
  if (el) el.remove();
  delete state._lastReceipt;
}

function printSavedReceipt(copy) {
  const r = state._lastReceipt;
  if (!r) return;
  printReceipt({ items: r.items, subtotal: r.subtotal, discount: r.discount, total: r.total, id: r.id, dailySeq: r.dailySeq, orderType: r.orderType, customerName: r.customerName, paymentMethod: r.paymentMethod, paymentConfirmed: r.paymentConfirmed }, copy);
}

function printReceipt({ items, subtotal, discount, total, id, dailySeq, orderType, customerName, paymentMethod, paymentConfirmed }, copy = 'kitchen') {
  const now = new Date();
  const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
  const displayId = dailySeq || id;
  const ppStatus = paymentMethod === 'promptpay' ? (paymentConfirmed ? (t('orders.payment_complete') || 'Paid') : (t('orders.payment_pending') || 'Pending')) : '';
  const serviceLabel = orderType === 'takeaway' ? t('service.takeaway') : t('service.dine_in');
  let html = '';
  const h = (s) => html += s;
  h('<div class="receipt-overlay" id="receipt-overlay">');
  h('<div class="receipt-paper" id="receipt-paper">');
  if (copy === 'kitchen' || copy === 'both') {
  h(`<div class="rcpt-center"><div class="rcpt-brand">Homlamoon</div><div class="rcpt-sub">${dateStr}</div><div class="rcpt-sub">#${displayId} &middot; ${serviceLabel}</div>${customerName ? `<div class="rcpt-sub">${t('cashier.customer_name') || 'Customer'}: ${customerName}</div>` : ''}</div>`);
  h('<div class="rcpt-line"></div>');
  items.forEach(i => {
    h(`<div class="rcpt-row"><span>${i.name}</span><span>฿${(i.price * i.qty).toFixed(2)}</span></div>`);
    h(`<div class="rcpt-row" style="font-size:11px;padding-left:8px"><span class="qty">x${i.qty} ฿${i.price.toFixed(2)}</span></div>`);
  });
  h('<div class="rcpt-line"></div>');
  h(`<div class="rcpt-row"><span>${t('orders.subtotal')}</span><span>฿${subtotal.toFixed(2)}</span></div>`);
  if (discount > 0) h(`<div class="rcpt-row"><span>${t('orders.discount')}</span><span>-฿${discount.toFixed(2)}</span></div>`);
  h(`<div class="rcpt-row rcpt-total"><span>${t('orders.total')}</span><span>฿${total.toFixed(2)}</span></div>`);
  h('<div class="rcpt-line"></div>');
  if (paymentMethod === 'promptpay') {
    h('<div class="rcpt-center" style="margin:2px 0;font-size:11px">PromptPay &mdash; ' + ppStatus + '</div>');
  }
  h('<div class="rcpt-thanks">Thank you! &bull; ขอบคุณ!</div>');
  }
  if (copy === 'customer' || copy === 'both') {
    h('<div class="rcpt-center" style="margin:0 0 4px;font-size:10px">--- Customer Copy ---</div>');
    h(`<div class="rcpt-center"><div class="rcpt-brand">Homlamoon</div><div class="rcpt-sub">${dateStr}</div><div class="rcpt-sub">#${displayId} &middot; ${serviceLabel}</div>${customerName ? `<div class="rcpt-sub">${t('cashier.customer_name') || 'Customer'}: ${customerName}</div>` : ''}</div>`);
    h('<div class="rcpt-line"></div>');
    items.forEach(i => {
      h(`<div class="rcpt-row"><span>${i.name}</span><span>฿${(i.price * i.qty).toFixed(2)}</span></div>`);
      h(`<div class="rcpt-row" style="font-size:11px;padding-left:8px"><span class="qty">x${i.qty} ฿${i.price.toFixed(2)}</span></div>`);
    });
    h('<div class="rcpt-line"></div>');
    h(`<div class="rcpt-row"><span>${t('orders.subtotal')}</span><span>฿${subtotal.toFixed(2)}</span></div>`);
    if (discount > 0) h(`<div class="rcpt-row"><span>${t('orders.discount')}</span><span>-฿${discount.toFixed(2)}</span></div>`);
    h(`<div class="rcpt-row rcpt-total"><span>${t('orders.total')}</span><span>฿${total.toFixed(2)}</span></div>`);
    h('<div class="rcpt-line"></div>');
    if (paymentMethod === 'promptpay') {
      h('<div class="rcpt-center" style="margin:2px 0;font-size:11px">PromptPay &mdash; ' + ppStatus + '</div>');
    }
    h('<div class="rcpt-thanks">Thank you! &bull; ขอบคุณ!</div>');
  }
  h('</div>');
  h('<div style="display:flex;gap:10px;justify-content:center;margin-top:15px" class="no-print">');
  h('<button class="btn btn-primary" onclick="document.getElementById(\'receipt-paper\').classList.add(\'printing\');window.print()">&#x1F5A8; Print</button>');
  h('<button class="btn btn-outline" onclick="closeReceipt()">' + (t('orders.close') || 'Close') + '</button>');
  h('</div>');
  h('</div>');
  const el = document.createElement('div');
  el.id = 'receipt-overlay-container';
  el.innerHTML = html;
  document.body.appendChild(el);
}

function closeReceipt() {
  const el = document.getElementById('receipt-overlay-container');
  if (el) el.remove();
}

// ─── Orders ──────────────────────────────────────────────────────────
async function renderOrders(container) {
  const orders = await api('/api/sales');
  container.innerHTML = `
    <div class="page-header">
      <h1>&#x1F4CB; ${t('orders.title')}</h1>
      <button class="btn btn-outline" onclick="exportOrdersPDF()">${t('orders.export_pdf')}</button>
      ${isAdminOrManager() ? `<button class="btn btn-danger" onclick="deleteAllSales()">${t('orders.delete_all')}</button>` : ''}
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-number">${orders.length}</div><div class="stat-label">${t('orders.total_orders')}</div></div>
      <div class="stat-card"><div class="stat-number">${orders.filter(o => o.created_at && o.created_at.startsWith(new Date().toISOString().slice(0,10))).length}</div><div class="stat-label">${t('orders.today_orders')}</div></div>
      <div class="stat-card"><div class="stat-number">฿${orders.reduce((s,o) => s + (o.total || 0), 0).toFixed(2)}</div><div class="stat-label">${t('orders.total_revenue')}</div></div>
    </div>
    <div class="table-wrap card">
      <table>
        <thead><tr><th>#</th><th>${t('orders.items')}</th><th>${t('orders.total')}</th><th>${t('orders.payment')}</th><th>${t('orders.date')}</th><th>${t('orders.actions')||'Actions'}</th></tr></thead>
        <tbody>
          ${orders.length ? orders.map(o => {
            const items = JSON.parse(o.items || '[]');
            const paid = o.payment_confirmed ? `<span class="badge badge-active">${t('orders.payment_complete')}</span>` : `<span class="badge badge-inactive">${t('orders.payment_pending')}</span>`;
            const payMethod = t('orders.' + (o.payment_method || 'cash')) || o.payment_method;
            return `<tr>
              <td><strong>#${o.daily_seq || o.id}</strong></td>
              <td>${items.length} ${t('orders.items')}</td>
              <td>฿${(o.total || 0).toFixed(2)}</td>
              <td>${payMethod} ${paid}</td>
              <td><small>${new Date(o.created_at).toLocaleString()}</small></td>
              <td>
                <button class="btn btn-sm btn-outline" onclick="showOrderDetail(${o.id})">${t('orders.details')}</button>
                ${!o.payment_confirmed ? `<button class="btn btn-sm btn-primary" onclick="confirmPayment(${o.id})">${t('orders.confirm_payment')}</button>` : ''}
                ${isAdminOrManager() ? `<button class="btn btn-sm btn-danger" onclick="deleteSale(${o.id})">${t('orders.delete')}</button>` : ''}
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--text-light)">${t('orders.no_orders')}</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

async function showOrderDetail(id) {
  const orders = await api('/api/sales');
  const o = orders.find(x => x.id === id);
  if (!o) return;
  const items = JSON.parse(o.items || '[]');
  const body = document.getElementById('order-detail-body');
  body.innerHTML = `
    <div style="margin-bottom:0.8rem">
      <strong>${t('orders.order')} #${o.daily_seq || o.id}</strong>
      ${o.customer_name ? `<br><span style="color:var(--text-light)">${o.customer_name}</span>` : ''}
      <br><small style="color:var(--text-light)">${new Date(o.created_at).toLocaleString()}</small>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
      <thead><tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:0.3rem">${t('orders.qty')}</th><th style="text-align:left;padding:0.3rem">${t('menu.name')}</th><th style="text-align:right;padding:0.3rem">${t('orders.price')}</th></tr></thead>
      <tbody>
        ${items.map(item => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:0.3rem">${item.qty || 1}x</td>
            <td style="padding:0.3rem">${item.name}</td>
            <td style="padding:0.3rem;text-align:right">฿${((item.price || 0) * (item.qty || 1)).toFixed(2)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div style="margin-top:0.8rem;text-align:right">
      <div>${t('orders.subtotal')}: ฿${(o.subtotal || 0).toFixed(2)}</div>
      ${o.discount ? `<div>${t('orders.discount')}: -฿${(o.discount || 0).toFixed(2)}</div>` : ''}
      <div style="font-size:1.2rem;font-weight:700;color:var(--primary)">${t('orders.total')}: ฿${(o.total || 0).toFixed(2)}</div>
      <div style="margin-top:0.3rem">${t('orders.payment_method')}: ${t('orders.' + (o.payment_method || 'cash')) || o.payment_method}</div>
    </div>
  `;
  document.getElementById('modal-title').textContent = t('orders.details');
  document.querySelectorAll('.modal-form').forEach(f => f.style.display = 'none');
  document.getElementById('form-order-detail').style.display = 'block';
  document.getElementById('modal-overlay').classList.add('open');
}

async function confirmPayment(id) {
  await api('/api/sales/' + id + '/confirm-payment', 'POST');
  navigate('orders');
}

async function deleteSale(id) {
  if (!confirm(t('orders.confirm_delete') + ' #' + id + '?')) return;
  await api('/api/sales/' + id, 'DELETE');
  navigate('orders');
}

async function deleteAllSales() {
  if (!confirm(t('orders.confirm_delete_all'))) return;
  if (!confirm(t('orders.confirm_delete_all_2'))) return;
  await api('/api/sales', 'DELETE');
  navigate('orders');
}

function exportOrdersPDF() {
  window.open('/api/sales/export-pdf', '_blank');
}

// ─── Promotions ──────────────────────────────────────────────────────
async function renderPromotions(container) {
  const promos = await api('/api/promotions');
  container.innerHTML = `
    <div class="page-header">
      <h1>&#x1F389; ${t('promo.title')}</h1>
      ${isAdminOrManager() ? `<button class="btn btn-primary" onclick="openPromoModal()">${t('promo.add')}</button>` : ''}
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-number">${promos.length}</div><div class="stat-label">${t('promo.total')}</div></div>
      <div class="stat-card"><div class="stat-number">${promos.filter(p=>p.active).length}</div><div class="stat-label">${t('promo.active')}</div></div>
    </div>
    <div class="table-wrap card">
      <table>
        <thead><tr><th>${t('promo.name')}</th><th>${t('promo.discount')}</th><th>${t('promo.period')}</th><th>${t('promo.status')}</th>${isAdminOrManager() ? `<th>${t('promo.actions')}</th>` : ''}</tr></thead>
        <tbody>
          ${promos.map(p => `
            <tr>
              <td><strong>${p.name}</strong><br><small style="color:var(--text-light)">${p.description||''}</small></td>
              <td style="font-weight:700;color:var(--accent)">${p.discount_percent}%</td>
              <td>${p.start_date} → ${p.end_date}</td>
              <td><span class="badge ${p.active ? 'badge-active' : 'badge-inactive'}">${p.active ? t('promo.active_label') : t('promo.inactive')}</span></td>
              ${isAdminOrManager() ? `<td>
                <button class="btn btn-sm btn-outline" onclick="openPromoModal(${p.id})">${t('promo.edit')}</button>
                <button class="btn btn-sm btn-danger" onclick="deletePromo(${p.id})">${t('promo.delete')}</button>
              </td>` : ''}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

let editingPromoId = null;

async function openPromoModal(id = null) {
  editingPromoId = id;
  document.getElementById('modal-title').textContent = id ? t('promo.edit_title') : t('promo.add_title');
  document.querySelectorAll('.modal-form').forEach(f => f.style.display = 'none');
  document.getElementById('form-promo').style.display = 'block';
  if (id) {
    const promos = await api('/api/promotions');
    const p = promos.find(x => x.id === id);
    document.getElementById('promo-name').value = p.name;
    document.getElementById('promo-desc').value = p.description || '';
    document.getElementById('promo-pct').value = p.discount_percent;
    document.getElementById('promo-start').value = p.start_date;
    document.getElementById('promo-end').value = p.end_date;
    document.getElementById('promo-active').value = p.active;
  } else {
    document.getElementById('promo-name').value = '';
    document.getElementById('promo-desc').value = '';
    document.getElementById('promo-pct').value = '';
    document.getElementById('promo-start').value = '';
    document.getElementById('promo-end').value = '';
    document.getElementById('promo-active').value = '1';
  }
  document.getElementById('modal-overlay').classList.add('open');
}

async function savePromo() {
  const data = {
    name: document.getElementById('promo-name').value,
    description: document.getElementById('promo-desc').value,
    discount_percent: parseFloat(document.getElementById('promo-pct').value),
    start_date: document.getElementById('promo-start').value,
    end_date: document.getElementById('promo-end').value,
    active: parseInt(document.getElementById('promo-active').value)
  };
  if (editingPromoId) {
    await api(`/api/promotions/${editingPromoId}`, 'PUT', data);
  } else {
    await api('/api/promotions', 'POST', data);
  }
  closeModal();
  navigate('promotions');
}

async function deletePromo(id) {
  if (!confirm(t('promo.confirm_delete'))) return;
  await api(`/api/promotions/${id}`, 'DELETE');
  navigate('promotions');
}

// ─── Ads ─────────────────────────────────────────────────────────────
async function renderAds(container) {
  const ads = await api('/api/ads');
  container.innerHTML = `
    <div class="page-header">
      <h1>&#x1F4F0; ${t('ads.title')}</h1>
      ${isAdminOrManager() ? `<button class="btn btn-primary" onclick="openAdModal()">${t('ads.add')}</button>` : ''}
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-number">${ads.length}</div><div class="stat-label">${t('ads.total')}</div></div>
      <div class="stat-card"><div class="stat-number">${ads.filter(a=>a.active).length}</div><div class="stat-label">${t('ads.active')}</div></div>
    </div>
    <div class="table-wrap card">
      <table>
        <thead><tr><th>${t('ads.title_label')}</th><th>${t('ads.content')}</th><th>${t('ads.media')}</th><th>${t('ads.status')}</th>${isAdminOrManager() ? `<th>${t('ads.actions')}</th>` : ''}</tr></thead>
        <tbody>
          ${ads.map(a => {
            const mi = a.media_type === 'youtube' ? '&#x1F4FA;' : a.media_type === 'video' ? '&#x1F3AC;' : '&#x1F5BC;';
            return `<tr>
              <td><strong>${a.title}</strong></td>
              <td><small style="color:var(--text-light)">${a.content||''}</small></td>
              <td>${mi} ${a.media_type || 'image'}</td>
              <td><span class="badge ${a.active ? 'badge-active' : 'badge-inactive'}">${a.active ? t('ads.active_label') : t('ads.inactive')}</span></td>
              ${isAdminOrManager() ? `<td>
                <button class="btn btn-sm btn-outline" onclick="openAdModal(${a.id})">${t('ads.edit')}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteAd(${a.id})">${t('ads.delete')}</button>
              </td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

let editingAdId = null;

function toggleAdMediaFields() {
  const t = document.getElementById('ad-media-type').value;
  document.getElementById('ad-video-upload-group').style.display = t === 'video' ? '' : 'none';
  document.getElementById('ad-youtube-group').style.display = t === 'youtube' ? '' : 'none';
}

function previewAdImage(input) {
  const preview = document.getElementById('ad-image-preview');
  const hidden = document.getElementById('ad-image');
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      preview.querySelector('img').src = e.target.result;
      preview.style.display = 'block';
      hidden.value = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
  }
}

async function openAdModal(id = null) {
  editingAdId = id;
  document.getElementById('modal-title').textContent = id ? t('ads.edit_title') : t('ads.add_title');
  document.querySelectorAll('.modal-form').forEach(f => f.style.display = 'none');
  document.getElementById('form-ad').style.display = 'block';
  // Reset file inputs and preview
  document.getElementById('ad-image-file').value = '';
  document.getElementById('ad-image-preview').style.display = 'none';
  document.getElementById('ad-video-file').value = '';
  if (id) {
    const ads = await api('/api/ads');
    const a = ads.find(x => x.id === id);
    document.getElementById('ad-title').value = a.title;
    document.getElementById('ad-content').value = a.content || '';
    document.getElementById('ad-image').value = a.image || '';
    if (a.image) {
      const preview = document.getElementById('ad-image-preview');
      preview.querySelector('img').src = a.image;
      preview.style.display = 'block';
    }
    document.getElementById('ad-media-type').value = a.media_type || 'image';
    document.getElementById('ad-media-url').value = a.media_url || '';
    document.getElementById('ad-youtube-url').value = (a.media_type === 'youtube' && a.media_url) ? a.media_url : '';
    document.getElementById('ad-active').value = a.active;
  } else {
    document.getElementById('ad-title').value = '';
    document.getElementById('ad-content').value = '';
    document.getElementById('ad-image').value = '';
    document.getElementById('ad-media-type').value = 'image';
    document.getElementById('ad-media-url').value = '';
    document.getElementById('ad-youtube-url').value = '';
    document.getElementById('ad-active').value = '1';
  }
  toggleAdMediaFields();
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveAd() {
  const mediaType = document.getElementById('ad-media-type').value;
  let mediaUrl = document.getElementById('ad-media-url').value || '';
  if (mediaType === 'youtube') {
    mediaUrl = document.getElementById('ad-youtube-url').value;
  } else if (mediaType === 'video') {
    const fileInput = document.getElementById('ad-video-file');
    if (fileInput.files && fileInput.files[0]) {
      const reader = new FileReader();
      mediaUrl = await new Promise(resolve => { reader.onload = e => resolve(e.target.result); reader.readAsDataURL(fileInput.files[0]); });
    }
  }
  const data = {
    title: document.getElementById('ad-title').value,
    content: document.getElementById('ad-content').value,
    image: document.getElementById('ad-image').value,
    media_type: mediaType,
    media_url: mediaUrl,
    active: parseInt(document.getElementById('ad-active').value)
  };
  if (editingAdId) {
    await api(`/api/ads/${editingAdId}`, 'PUT', data);
  } else {
    await api('/api/ads', 'POST', data);
  }
  closeModal();
  navigate('ads');
}

async function deleteAd(id) {
  if (!confirm(t('ads.confirm_delete'))) return;
  await api(`/api/ads/${id}`, 'DELETE');
  navigate('ads');
}

// ─── Topping Manager ──────────────────────────────────────────────────
let editingToppingId = null;

async function openToppingManager() {
  editingToppingId = null;
  const toppings = await api('/api/toppings');
  const modal = document.getElementById('modal-overlay');
  document.getElementById('modal-title').textContent = t('toppings.title');
  document.querySelectorAll('.modal-form').forEach(f => f.style.display = 'none');
  const form = document.getElementById('form-topping');
  form.style.display = 'block';
  document.getElementById('topping-name').value = '';
  document.getElementById('topping-price').value = '';
  // show existing toppings list
  const listEl = document.createElement('div');
  listEl.id = 'topping-manager-list';
  const existing = form.querySelector('#topping-manager-list');
  if (existing) existing.remove();
  form.insertBefore(listEl, form.querySelector('div:last-child'));
  listEl.innerHTML = `
    <div style="margin:0.8rem 0;border-top:1px solid var(--border);padding-top:0.8rem">
      <h4 style="margin-bottom:0.5rem;color:var(--text-light);font-size:0.9rem">${t('toppings.available')}</h4>
      ${toppings.length ? toppings.map(t => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.3rem 0;border-bottom:1px solid var(--border)">
          <span><strong>${t.name}</strong> <span style="color:var(--accent);font-weight:600">+฿${t.price.toFixed(2)}</span></span>
          <span>
            <button class="btn btn-sm btn-outline" onclick="editTopping(${t.id})">${t('toppings.edit')}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTopping(${t.id})">${t('toppings.delete')}</button>
          </span>
        </div>
      `).join('') : `<p style="color:var(--text-light);text-align:center">${t('toppings.empty')}</p>`}
    </div>
  `;
  if (!editingToppingId) {
    const btn = form.querySelector('.btn-primary');
    btn.textContent = t('toppings.add');
  }
  modal.classList.add('open');
}

async function editTopping(id) {
  editingToppingId = id;
  const toppings = await api('/api/toppings');
  const t = toppings.find(x => x.id === id);
  if (!t) return;
  document.getElementById('topping-name').value = t.name;
  document.getElementById('topping-price').value = t.price;
  const btn = document.querySelector('#form-topping .btn-primary');
  btn.textContent = t('toppings.save');
  document.getElementById('modal-title').textContent = t('toppings.edit_title');
}

async function saveTopping() {
  const name = document.getElementById('topping-name').value.trim();
  const price = parseFloat(document.getElementById('topping-price').value) || 0;
  if (!name) return;
  if (editingToppingId) {
    await api(`/api/toppings/${editingToppingId}`, 'PUT', { name, price });
  } else {
    await api('/api/toppings', 'POST', { name, price });
  }
  closeModal();
  navigate('cashier');
}

async function deleteTopping(id) {
  if (!confirm(t('toppings.confirm_delete'))) return;
  await api(`/api/toppings/${id}`, 'DELETE');
  navigate('cashier');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ─── Users ───────────────────────────────────────────────────────────
let editingUserId = null;

async function renderUsers(container) {
  const users = await api('/api/users');
  container.innerHTML = `
    <div class="page-header">
      <h1>&#x1F465; ${t('users.title')}</h1>
      <button class="btn btn-primary" onclick="showUserForm()">${t('users.add')}</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>${t('users.username')}</th><th>${t('role.label')}</th><th>${t('users.actions')}</th></tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${u.id}</td>
              <td>${u.username}</td>
              <td><span class="badge ${u.role === 'admin' ? 'badge-active' : u.role === 'manager' ? 'badge-warning' : 'badge-inactive'}">${t('role.' + u.role)}</span></td>
              <td>
                <button class="btn btn-sm btn-outline" onclick="editUser(${u.id})">${t('users.edit')}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id},'${u.username}')" ${users.length <= 1 ? 'disabled' : ''}>${t('users.delete')}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function showUserForm() {
  editingUserId = null;
  document.getElementById('modal-title').textContent = t('users.add_title');
  document.querySelectorAll('.modal-form').forEach(f => f.style.display = 'none');
  document.getElementById('form-user').style.display = 'block';
  document.getElementById('user-username').value = '';
  document.getElementById('user-username').disabled = false;
  document.getElementById('user-password').value = '';
  document.getElementById('user-role').value = 'staff';
  document.getElementById('user-role-section').style.display = '';
  document.getElementById('modal-overlay').classList.add('open');
}

async function editUser(id) {
  editingUserId = id;
  const users = await api('/api/users');
  const u = users.find(x => x.id === id);
  if (!u) return;
  document.getElementById('modal-title').textContent = t('users.edit_title');
  document.querySelectorAll('.modal-form').forEach(f => f.style.display = 'none');
  document.getElementById('form-user').style.display = 'block';
  document.getElementById('user-username').value = u.username;
  document.getElementById('user-username').disabled = true;
  document.getElementById('user-password').value = '';
  document.getElementById('user-role').value = u.role;
  document.getElementById('user-role-section').style.display = '';
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveUser() {
  const username = document.getElementById('user-username').value.trim();
  const password = document.getElementById('user-password').value;
  const role = document.getElementById('user-role').value;
  if (!username || !password) return;
  if (editingUserId) {
    const body = { password };
    if (role) body.role = role;
    const res = await api(`/api/users/${editingUserId}`, 'PUT', body);
    if (res.error) { alert(res.error); return; }
  } else {
    const res = await api('/api/users', 'POST', { username, password, role });
    if (res.error) { alert(res.error); return; }
  }
  document.getElementById('user-username').disabled = false;
  closeModal();
  navigate('users');
}

async function deleteUser(id, name) {
  if (!confirm(t('users.confirm_delete') + ' ' + name + '?')) return;
  const res = await api(`/api/users/${id}`, 'DELETE');
  if (res.error) { alert(res.error); return; }
  navigate('users');
}

// ─── Screensaver (idle ad display) ───────────────────────────────────
let screensaverTimer = null;
let screensaverAdIndex = 0;
let screensaverAdTimeout = null;
const SCREENSAVER_DELAY = 30000;

function resetScreensaverTimer() {
  if (screensaverTimer) clearTimeout(screensaverTimer);
  const overlay = document.getElementById('screensaver-overlay');
  if (overlay && overlay.style.display === 'none') {
    screensaverTimer = setTimeout(showScreensaver, SCREENSAVER_DELAY);
  }
}

function advanceToNextAd() {
  const overlay = document.getElementById('screensaver-overlay');
  if (!overlay) return;
  const ads = overlay._ads;
  if (ads && ads.length) {
    screensaverAdIndex = (screensaverAdIndex + 1) % ads.length;
    renderScreensaverAd(ads[screensaverAdIndex]);
  }
}

function scheduleNextAd(ad, videoEl) {
  if (screensaverAdTimeout) { clearTimeout(screensaverAdTimeout); screensaverAdTimeout = null; }
  const mt = ad.media_type || 'image';
  if (mt === 'video' && videoEl) {
    videoEl.addEventListener('ended', advanceToNextAd);
    screensaverAdTimeout = setTimeout(advanceToNextAd, 120000);
  } else if (mt === 'youtube') {
    screensaverAdTimeout = setTimeout(advanceToNextAd, 60000);
  } else {
    screensaverAdTimeout = setTimeout(advanceToNextAd, 8000);
  }
}

async function showScreensaver() {
  const overlay = document.getElementById('screensaver-overlay');
  if (!overlay || overlay.style.display !== 'none') return;
  const ads = await api('/api/ads/active');
  if (!ads.length) return;
  overlay._ads = ads;
  screensaverAdIndex = 0;
  overlay.style.display = 'block';
  renderScreensaverAd(ads[0]);
}

function hideScreensaver() {
  const overlay = document.getElementById('screensaver-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  overlay.style.display = 'none';
  if (screensaverAdTimeout) { clearTimeout(screensaverAdTimeout); screensaverAdTimeout = null; }
  const content = document.getElementById('screensaver-content');
  if (content) content.innerHTML = '';
  resetScreensaverTimer();
}

function renderScreensaverAd(ad) {
  const content = document.getElementById('screensaver-content');
  if (!content) return;
  content.innerHTML = '';
  const mt = ad.media_type || 'image';
  if (mt === 'youtube' && ad.media_url) {
    const videoId = extractYoutubeId(ad.media_url);
    if (videoId) {
      const iframe = document.createElement('iframe');
      iframe.src = 'https://www.youtube.com/embed/' + videoId + '?autoplay=1&mute=1';
      iframe.allow = 'autoplay; encrypted-media';
      iframe.style.width = '80vw'; iframe.style.height = '80vh';
      iframe.style.border = 'none'; iframe.style.borderRadius = '12px';
      iframe.allowFullscreen = true;
      content.appendChild(iframe);
      scheduleNextAd(ad);
      return;
    }
  }
  if (mt === 'video' && ad.media_url) {
    const video = document.createElement('video');
    video.src = ad.media_url;
    video.autoplay = true; video.muted = true;
    video.playsInline = true;
    video.style.maxWidth = '90vw'; video.style.maxHeight = '80vh';
    video.style.borderRadius = '12px';
    content.appendChild(video);
    scheduleNextAd(ad, video);
    return;
  }
  const imgSrc = ad.image || '';
  const hasImage = imgSrc && (imgSrc.startsWith('data:') || imgSrc.startsWith('http'));
  content.innerHTML = `
    <div style="text-align:center;max-width:90vw">
      ${hasImage ? `<img src="${imgSrc}" style="max-width:100%;max-height:70vh;border-radius:12px;margin-bottom:1rem">` : ''}
      <h2 style="color:#FFF;margin:0.5rem 0">${ad.title}</h2>
      ${ad.content ? `<p style="color:rgba(255,255,255,0.7);font-size:1rem">${ad.content}</p>` : ''}
    </div>
  `;
  scheduleNextAd(ad);
}

function extractYoutubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function initScreensaver() {
  const overlay = document.getElementById('screensaver-overlay');
  if (!overlay) return;
  overlay.addEventListener('click', hideScreensaver);
  overlay.addEventListener('mousemove', hideScreensaver);
  const events = ['mousemove', 'click', 'keydown', 'touchstart', 'scroll'];
  events.forEach(e => document.addEventListener(e, resetScreensaverTimer));
  resetScreensaverTimer();
}
