// ===== IndexedDB =====
const dbPromise = new Promise((resolve, reject) => {
  const open = indexedDB.open('productionDB', 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
    db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
    db.createObjectStore('settings', { keyPath: 'key' });
  };
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});

async function db(store, mode, cb) {
  const database = await dbPromise;
  return new Promise((res, rej) => {
    const tx = database.transaction(store, mode);
    const req = cb(tx.objectStore(store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

const $ = s => document.querySelector(s);

// ===== Навигация =====
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('section').forEach(sec => sec.hidden = true);
    document.querySelector(`#${btn.dataset.page}`).hidden = false;
    document.querySelectorAll('nav button').forEach(b => b.removeAttribute('data-active'));
    btn.setAttribute('data-active', '');
  });
});

// ===== Обновление UI =====
async function refreshProducts() {
  const products = await db('products', 'readonly', os => os.getAll());
  $('#product-select').innerHTML = products.map(
    p => `<option value="${p.id}" data-price="${p.price}">${p.name}</option>`
  ).join('');
  $('#product-list').innerHTML = products.map(
    p => `<li>${p.name} — ${p.price} ₽ <button onclick="deleteProduct(${p.id})">✕</button></li>`
  ).join('') || '<li>Нет данных</li>';
}

async function loadToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const entries = await db('entries', 'readonly', os => os.getAll());
  $('#today-list').innerHTML = entries.filter(e => e.ts >= start.getTime())
    .map(e => {
      const t = new Date(e.ts).toLocaleTimeString();
      return `<li>${t} — ${e.productName} x${e.qty} = ${e.sum} ₽
               <button onclick="deleteEntry(${e.id})">✕</button></li>`;
    }).join('') || '<li>Нет данных</li>';
}

async function loadMonthSum() {
  const first = new Date();
  first.setDate(1); first.setHours(0, 0, 0, 0);
  const entries = await db('entries', 'readonly', os => os.getAll());
  const total = entries.filter(e => e.ts >= first.getTime())
                       .reduce((sum, e) => sum + e.sum, 0);
  $('#month-total').textContent = total + ' ₽';
}

// ===== CRUD =====
async function deleteProduct(id) {
  await db('products', 'readwrite', os => os.delete(id));
  refreshProducts();
  syncToGitHub();
}

async function deleteEntry(id) {
  await db('entries', 'readwrite', os => os.delete(id));
  loadToday();
  loadMonthSum();
  syncToGitHub();
}

$('#add-product-btn').addEventListener('click', async () => {
  const name = $('#new-name').value.trim();
  const price = parseFloat($('#new-price').value);
  if (!name || !price) return;
  await db('products', 'readwrite', os => os.add({ name, price }));
  $('#new-name').value = '';
  $('#new-price').value = '';
  refreshProducts();
  syncToGitHub();
});

$('#add-btn').addEventListener('click', async () => {
  const pid = +$('#product-select').value;
  const qty = parseFloat($('#qty-input').value);
  if (!pid || !qty) return;
  const sel = $('#product-select').selectedOptions[0];
  const price = parseFloat(sel.dataset.price);
  const sum = price * qty;
  await db('entries', 'readwrite', os => os.add({
    pid, qty, sum, ts: Date.now(), productName: sel.textContent
  }));
  loadToday();
  loadMonthSum();
  syncToGitHub();
});

// ===== Настройки =====
$('#save-github-btn').addEventListener('click', async () => {
  await db('settings', 'readwrite', os => os.put({ key: 'github_owner', value: $('#github-owner').value.trim() }));
  await db('settings', 'readwrite', os => os.put({ key: 'github_repo', value: $('#github-repo').value.trim() }));
  await db('settings', 'readwrite', os => os.put({ key: 'github_token', value: $('#github-token').value.trim() }));
  updateSyncStatus('✅ Настройки сохранены');
});

$('#clear-data-btn').addEventListener('click', async () => {
  if (confirm('Удалить все данные?')) {
    await db('products', 'readwrite', os => os.clear());
    await db('entries', 'readwrite', os => os.clear());
    refreshProducts();
    loadToday();
    loadMonthSum();
    syncToGitHub();
  }
});

// ===== Синхронизация на GitHub =====
async function syncToGitHub() {
  const ownerSetting = await db('settings', 'readonly', os => os.get('github_owner'));
  const repoSetting  = await db('settings', 'readonly', os => os.get('github_repo'));
  const tokenSetting = await db('settings', 'readonly', os => os.get('github_token'));
  
  if (!ownerSetting?.value || !repoSetting?.value || !tokenSetting?.value) {
    return updateSyncStatus('❌ Нет настроек GitHub');
  }

  const owner  = ownerSetting.value;
  const repo   = repoSetting.value;
  const token  = tokenSetting.value;

  const products = await db('products', 'readonly', os => os.getAll());
  const entries  = await db('entries', 'readonly', os => os.getAll());
  const backup   = { products, entries, updated: new Date().toISOString() };
  const content  = btoa(unescape(encodeURIComponent(JSON.stringify(backup, null, 2))));

  const getUrl  = `https://api.github.com/repos/${owner}/${repo}/contents/data.json`;
  
  // Получаем метаданные с sha
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };

  let sha = null;
  const getResp = await fetch(getUrl, { headers });
  console.log('GET data.json status:', getResp.status);
  if (getResp.ok) {
    const fileData = await getResp.json();
    console.log('Ответ от GitHub (метаданные):', fileData);
    if (fileData && typeof fileData.sha === 'string') {
      sha = fileData.sha;
    }
    console.log('Полученный sha:', sha);
  } else if (getResp.status !== 404) {
    console.warn('Ошибка GET data.json:', await getResp.text());
  }

  const bodyObj = { message: 'Backup update', content };
  if (sha) {
    bodyObj.sha = sha;
  } else {
    console.log('sha нет → файл создаётся впервые');
  }

  console.log('Отправляем PUT с телом:', bodyObj);

  const putResp   = await fetch(getUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(bodyObj)
  });
  const respJson  = await putResp.json();
  console.log('PUT status:', putResp.status);
  console.log('PUT response JSON:', respJson);

  if (putResp.ok) {
    updateSyncStatus('✅ Бэкап на GitHub сохранён');
  } else {
    updateSyncStatus(`⚠️ Ошибка GitHub sync: ${respJson.message || 'Неизвестная ошибка'}`);
  }
}

// ===== Автоимпорт с GitHub =====
async function loadFromGitHub() {
  const ownerSetting = await db('settings','readonly', os => os.get('github_owner'));
  const repoSetting  = await db('settings','readonly', os => os.get('github_repo'));
  const tokenSetting = await db('settings','readonly', os => os.get('github_token'));
  
  if (!ownerSetting?.value || !repoSetting?.value || !tokenSetting?.value) {
    console.log('Нет настроек GitHub, пропускаем автозагрузку');
    return;
  }

  const owner  = ownerSetting.value;
  const repo   = repoSetting.value;
  const token  = tokenSetting.value;

  const getUrl  = `https://api.github.com/repos/${owner}/${repo}/contents/data.json`;
  
  // raw, чтобы получить голое содержимое файла
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.raw' };

  try {
    const response = await fetch(getUrl, { headers });
    if (response.ok) {
      const text = await response.text();
      const data = JSON.parse(text);
      console.log('Загружено содержимое с GitHub:', data);

      await db('products', 'readwrite', os => os.clear());
      await db('entries', 'readwrite', os => os.clear());

      if (Array.isArray(data.products)) {
        for (const p of data.products) {
          await db('products', 'readwrite', os => os.add(p));
        }
      }
      if (Array.isArray(data.entries)) {
        for (const e of data.entries) {
          await db('entries', 'readwrite', os => os.add(e));
        }
      }

      refreshProducts();
      loadToday();
      loadMonthSum();
      updateSyncStatus('⬇️ Данные загружены с GitHub');
    } else {
      console.warn('Ошибка загрузки data.json:', response.status);
      updateSyncStatus('⚠️ Ошибка загрузки с GitHub');
    }
  } catch (e) {
    console.error('Ошибка при загрузке с GitHub:', e);
    updateSyncStatus('❌ Ошибка загрузки');
  }
}

function updateSyncStatus(msg) {
  $('#sync-status').textContent = msg;
}

// ===== init =====
(async function init() {
  await loadFromGitHub();
  refreshProducts();
  loadToday();
  loadMonthSum();
})();
