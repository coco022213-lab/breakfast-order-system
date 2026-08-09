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
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const SEED_FILE = path.join(__dirname, 'data', 'menu-seed.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- persistence (simple JSON file) ----------------
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
    const initial = { menu: seed, orders: [], orderCounter: 0, dailyTotals: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
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
  const item = { id: newId(), active: true, groups: [], ...req.body };
  db.menu.push(item);
  saveData();
  res.json(item);
});

app.put('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const idx = db.menu.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到品項' });
  db.menu[idx] = { ...db.menu[idx], ...req.body };
  saveData();
  res.json(db.menu[idx]);
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  db.menu = db.menu.filter((m) => m.id !== req.params.id);
  saveData();
  res.json({ ok: true });
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

app.post('/api/orders', (req, res) => {
  const { customerName, items } = req.body;
  if (!customerName || !items || !items.length) {
    return res.status(400).json({ error: '缺少姓名或餐點' });
  }
  db.orderCounter += 1;
  const total = items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
  const order = {
    id: newId(),
    num: db.orderCounter,
    customerName,
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

// 訂單有誤,取消(不計入營業額)
app.post('/api/orders/:id/cancel', (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  order.status = 'cancelled';
  saveData();
  io.emit('order_cancelled', order);
  res.json(order);
});

server.listen(PORT, () => console.log('伺服器啟動於 port ' + PORT));
