const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '0000';
// 訂單/菜單「目前資料」放在獨立的資料夾，這個資料夾會掛載 Railway 的永久硬碟（Volume），
// 這樣不管程式怎麼重新部署，資料都不會被清空。
const DATA_FILE = path.join(__dirname, 'data-store', 'store.json');
// 菜單「初始範本」跟著程式碼一起打包，只有在永久硬碟裡完全沒有資料時才會用它建立第一份資料。
const SEED_FILE = path.join(__dirname, 'data', 'menu-seed.json');

// 瀏覽器推播通知用的金鑰組（VAPID）。公鑰給前端訂閱用，私鑰只留在伺服器。
// 私鑰建議之後改放到 Railway 的環境變數 VAPID_PRIVATE_KEY，這裡先給一組預設值方便直接運作。
const VAPID_PUBLIC_KEY = 'BKVq5wIdanp72ay4aAmX-N7EIOcG15egqt7FthjS0Ijwez0-yTlt_1IvIgvhjJEZt1LdlHjXoOsnlFrCE4EHoSU';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '6OLa8Vs0hmI-2NFqxfE8W8Upp44MF6_tUwMSbIubdmo';
webpush.setVapidDetails('mailto:contact@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- persistence (simple JSON file) ----------------
function loadData() {
  let data;
  if (!fs.existsSync(DATA_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
    data = { menu: seed, orders: [], orderCounter: 0, dailyTotals: {}, categoryEmojis: {}, pushSubscriptions: {} };
  } else {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }
  // 補上分類圖示對照表（舊資料或第一次啟動時，從每個分類的第一個品項帶入）
  if (!data.categoryEmojis) data.categoryEmojis = {};
  if (!data.pushSubscriptions) data.pushSubscriptions = {};
  data.menu.forEach((m) => {
    if (!data.categoryEmojis[m.category]) data.categoryEmojis[m.category] = m.emoji || '🍽️';
  });
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  return data;
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
let db = loadData();

function todayKey() {
  // 伺服器用的是世界標準時間(UTC)，跟台灣時間差8小時，
  // 這裡手動加8小時換算成台灣時間，才不會半夜到早上8點之間誤判成「昨天」。
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return taipei.toISOString().slice(0, 10);
}
function newId() {
  return crypto.randomUUID();
}

// ---------------- admin auth ----------------
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    return res.status(401).json({ error: '密碼錯誤' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.pin === ADMIN_PIN) return res.json({ ok: true });
  res.status(401).json({ error: '密碼錯誤' });
});

// ---------------- menu ----------------
app.get('/api/menu', (req, res) => {
  const includeInactive = req.query.all === '1';
  res.json(includeInactive ? db.menu : db.menu.filter((m) => m.active !== false));
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const category = req.body.category;
  const emoji = req.body.emoji || db.categoryEmojis[category] || '🍽️';
  if (!db.categoryEmojis[category]) db.categoryEmojis[category] = emoji;
  const item = { id: newId(), active: true, groups: [], ...req.body, emoji };
  db.menu.push(item);
  saveData();
  res.json(item);
});

app.put('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const idx = db.menu.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到品項' });
  const patch = { ...req.body };
  // 沒有指定圖示時，跟著分類的圖示走（換分類會自動換圖示）
  if (patch.category && !patch.emoji) {
    patch.emoji = db.categoryEmojis[patch.category] || db.menu[idx].emoji || '🍽️';
  }
  db.menu[idx] = { ...db.menu[idx], ...patch };
  saveData();
  res.json(db.menu[idx]);
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  db.menu = db.menu.filter((m) => m.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// 設定/修改某個分類的圖示，該分類底下所有品項的圖示會一起跟著換
app.put('/api/admin/category-emoji', requireAdmin, (req, res) => {
  const { category, emoji } = req.body;
  if (!category || !emoji) return res.status(400).json({ error: '缺少分類或圖示' });
  db.categoryEmojis[category] = emoji;
  let updated = 0;
  db.menu.forEach((m) => {
    if (m.category === category) {
      m.emoji = emoji;
      updated += 1;
    }
  });
  saveData();
  res.json({ category, emoji, updated });
});

// ---------------- orders ----------------
app.get('/api/orders', (req, res) => {
  res.json(db.orders.filter((o) => o.status !== 'paid'));
});

app.get('/api/orders/summary', (req, res) => {
  const key = todayKey();
  res.json({
    date: key,
    total: db.dailyTotals[key] || 0,
    count: db.orders.filter((o) => o.status === 'paid' && o.paidDate === key).length,
  });
});

// 依日期區間統計營業額、訂單數、商品銷售排行
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const { start, end } = req.query; // 'YYYY-MM-DD'，兩者皆可省略
  const paidOrders = db.orders
    .filter((o) => o.status === 'paid')
    .filter((o) => !start || o.paidDate >= start)
    .filter((o) => !end || o.paidDate <= end)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalRevenue = paidOrders.reduce((s, o) => s + o.total, 0);
  const orderCount = paidOrders.length;

  const itemMap = {};
  paidOrders.forEach((o) => {
    o.items.forEach((it) => {
      if (!itemMap[it.name]) itemMap[it.name] = { name: it.name, emoji: it.emoji || '', qty: 0, revenue: 0 };
      itemMap[it.name].qty += it.qty;
      itemMap[it.name].revenue += it.unitPrice * it.qty;
    });
  });
  const items = Object.values(itemMap).sort((a, b) => b.qty - a.qty);

  res.json({
    totalRevenue,
    orderCount,
    avgOrder: orderCount ? Math.round(totalRevenue / orderCount) : 0,
    items,
    orders: paidOrders,
  });
});

// 讓客人可以查詢自己訂單目前的狀態（不需要密碼，訂單編號是隨機長字串，別人猜不到）
app.get('/api/orders/:id', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  res.json(order);
});

app.post('/api/orders', (req, res) => {
  const { customerName, items, orderType, customerPhone } = req.body;
  if (!customerName || !items || !items.length) {
    return res.status(400).json({ error: '缺少姓名或餐點' });
  }
  db.orderCounter += 1;
  const total = items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
  const order = {
    id: newId(),
    num: db.orderCounter,
    customerName,
    customerPhone: (customerPhone || '').trim(),
    orderType: orderType === 'takeout' ? 'takeout' : 'dine-in',
    items,
    total,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.orders.push(order);
  saveData();
  io.emit('new_order', order);
  res.json(order);
});

// 客人在訂單還沒開始製作前，可以自己加點/修改內容（不需要密碼，只有自己知道訂單編號）
app.put('/api/orders/:id', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  if (order.status === 'paid' || order.status === 'cancelled') {
    return res.status(409).json({ error: '這筆訂單已經完成或取消了，沒辦法再修改' });
  }
  const { items, customerName, customerPhone, orderType } = req.body;
  if (!items || !items.length) {
    return res.status(400).json({ error: '訂單至少要有一項餐點' });
  }
  order.items = items;
  order.total = items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
  if (customerName) order.customerName = customerName;
  order.customerPhone = (customerPhone || '').trim();
  order.orderType = orderType === 'takeout' ? 'takeout' : 'dine-in';
  saveData();
  io.emit('order_updated', order);
  res.json(order);
});

// ---------------- 瀏覽器推播通知 ----------------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// 客人送出訂單後，瀏覽器把訂閱資訊送來，跟這筆訂單綁在一起
app.post('/api/push/subscribe', (req, res) => {
  const { orderId, subscription } = req.body;
  if (!orderId || !subscription) return res.status(400).json({ error: '缺少訂單編號或訂閱資訊' });
  db.pushSubscriptions[orderId] = subscription;
  saveData();
  res.json({ ok: true });
});

// 依訂單編號發送推播通知，訂閱失效的話順便清掉
async function sendPushForOrder(orderId, payload) {
  const sub = db.pushSubscriptions[orderId];
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      delete db.pushSubscriptions[orderId];
      saveData();
    }
  }
}

// 通知外帶客人：餐點已經完成，可以來取餐了（還沒收款，等客人來再按「完成並收款」）
app.post('/api/orders/:id/ready', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  order.status = 'ready';
  saveData();
  io.emit('order_ready', order);
  sendPushForOrder(order.id, {
    title: '🔔 荷香早餐店',
    body: `No.${order.num} 餐點已經好了，可以來取餐囉！`,
  });
  res.json(order);
});

// 完成並收款:一個動作同時代表出餐完成 + 現金入帳
app.post('/api/orders/:id/paid', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  const key = todayKey();
  order.status = 'paid';
  order.paidDate = key;
  db.dailyTotals[key] = (db.dailyTotals[key] || 0) + order.total;
  saveData();
  const summary = { date: key, total: db.dailyTotals[key] };
  io.emit('order_paid', { order, summary });
  res.json({ order, summary });
});

// 復原:按錯「完成並收款」時，把訂單救回未完成狀態，並把金額從當日營業額扣掉
app.post('/api/orders/:id/undo', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  if (order.status !== 'paid') return res.status(400).json({ error: '這筆訂單目前不是已完成狀態' });
  const key = order.paidDate || todayKey();
  db.dailyTotals[key] = Math.max(0, (db.dailyTotals[key] || 0) - order.total);
  order.status = 'pending';
  delete order.paidDate;
  saveData();
  const summary = { date: key, total: db.dailyTotals[key] };
  io.emit('order_undone', { order, summary });
  res.json({ order, summary });
});

// 訂單有誤,取消(不計入營業額)
app.post('/api/orders/:id/cancel', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  order.status = 'cancelled';
  saveData();
  io.emit('order_cancelled', order);
  res.json(order);
});

// 從紀錄中永久刪除一筆訂單（如果是已收款的訂單，會一併從當日營業額扣掉）
app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  if (order.status === 'paid' && order.paidDate) {
    db.dailyTotals[order.paidDate] = Math.max(0, (db.dailyTotals[order.paidDate] || 0) - order.total);
  }
  db.orders = db.orders.filter((o) => o.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// 結束今日營業：把叫號重設回 0，明天第一筆訂單會是 No.01；同時把今天標記賣完的品項全部恢復上架
// （不影響任何歷史訂單資料或營業額統計）
app.post('/api/admin/reset-counter', (req, res) => {
  db.orderCounter = 0;
  let restoredCount = 0;
  db.menu.forEach((m) => {
    if (m.active === false) {
      m.active = true;
      restoredCount += 1;
    }
  });
  saveData();
  res.json({ ok: true, restoredCount });
});

server.listen(PORT, () => console.log('伺服器啟動於 port ' + PORT));
