const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- persistence (simple JSON file) ----------------
function loadData() {
  let data;
  if (!fs.existsSync(DATA_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
    data = { menu: seed, orders: [], orderCounter: 0, dailyTotals: {}, categoryEmojis: {} };
  } else {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }
  // 補上分類圖示對照表（舊資料或第一次啟動時，從每個分類的第一個品項帶入）
  if (!data.categoryEmojis) data.categoryEmojis = {};
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
  return new Date().toISOString().slice(0, 10);
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
  const { customerName, items, orderType } = req.body;
  if (!customerName || !items || !items.length) {
    return res.status(400).json({ error: '缺少姓名或餐點' });
  }
  db.orderCounter += 1;
  const total = items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
  const order = {
    id: newId(),
    num: db.orderCounter,
    customerName,
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

// 通知外帶客人：餐點已經完成，可以來取餐了（還沒收款，等客人來再按「完成並收款」）
app.post('/api/orders/:id/ready', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  order.status = 'ready';
  saveData();
  io.emit('order_ready', order);
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

// 結束今日營業：把叫號重設回 0，明天第一筆訂單會是 No.01（不影響任何歷史訂單資料或營業額統計）
app.post('/api/admin/reset-counter', (req, res) => {
  db.orderCounter = 0;
  saveData();
  res.json({ ok: true });
});

server.listen(PORT, () => console.log('伺服器啟動於 port ' + PORT));
