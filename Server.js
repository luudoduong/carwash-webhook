/**
 * ============================================================
 *  WEBHOOK SERVER ĐA TỦ v3.0 – Full tính năng thương mại
 * ============================================================
 *  TÍNH NĂNG:
 *  - Nhận tiền từ SePay (mỗi tủ 1 webhook riêng)
 *  - Dashboard điều khiển từ xa: stop/reset/thêm giờ/đổi giá
 *  - Phân quyền: admin xem tất cả, chủ tủ xem tủ mình
 *  - Thống kê doanh thu theo ngày/tuần/tháng
 *  - Cảnh báo tủ offline qua Telegram
 *  - Lịch sử 500 giao dịch, lọc theo tủ
 *  - Kiểm tra trùng mã tủ
 *  - API điều khiển cho ESP32
 *
 *  BIẾN MÔI TRƯỜNG (Render → Environment Variables):
 *  SEPAY_API_KEY  = carwash_secret_2025
 *  DASHBOARD_PASS = admin123
 *  OWNER_BOT_TOKEN = (tùy chọn) Bot Telegram để gửi cảnh báo
 *  OWNER_CHAT_ID   = (tùy chọn) Chat ID nhận cảnh báo
 * ============================================================
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const app     = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SEPAY_API_KEY  = process.env.SEPAY_API_KEY  || 'carwash_secret_2025';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin123';
const OWNER_BOT      = process.env.OWNER_BOT_TOKEN || '';
const OWNER_CHAT     = process.env.OWNER_CHAT_ID   || '';
const OFFLINE_MINS   = 10; // Cảnh báo sau N phút không ping

// ── File lưu dữ liệu ──────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { tus:{}, transactions:[], lastResetDate:'', dailyStats:{} };
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}

let db = loadData();

// ── Tiện ích ──────────────────────────────────────────────
function getTu(id) {
  if (!db.tus[id]) {
    db.tus[id] = {
      name         : 'Tủ ' + id,
      phone        : '',
      address      : '',
      note         : '',
      ownerPass    : '',           // Mật khẩu riêng của chủ tủ
      pendingAmount: 0,
      totalToday   : 0,
      totalAll     : 0,
      lastSeen     : null,
      lastTx       : null,
      processedIds : [],
      createdAt    : new Date().toISOString(),
      config       : { price:10000, runSeconds:300 },
      pendingCmd   : null,         // Lệnh chờ ESP32 thực thi
      offlineAlerted: false,
    };
    saveData();
  }
  return db.tus[id];
}

function fmtMoney(n) {
  return Number(n||0).toLocaleString('vi-VN') + 'đ';
}

function dateKey(date) {
  return new Date(date||Date.now()).toLocaleDateString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'});
}

// ── Gửi Telegram cảnh báo ─────────────────────────────────
function sendAlert(msg) {
  if (!OWNER_BOT || !OWNER_CHAT) return;
  const body = JSON.stringify({ chat_id:OWNER_CHAT, text:msg, parse_mode:'Markdown' });
  const req  = https.request({
    hostname:'api.telegram.org', path:`/bot${OWNER_BOT}/sendMessage`,
    method:'POST', headers:{'Content-Type':'application/json','Content-Length':body.length}
  });
  req.write(body); req.end();
}

// ── Reset doanh thu mỗi ngày & lưu lịch sử ngày ──────────
function resetDailyIfNeeded() {
  const today = dateKey();
  if (db.lastResetDate !== today) {
    // Lưu doanh thu ngày hôm qua vào lịch sử
    if (db.lastResetDate) {
      if (!db.dailyStats) db.dailyStats = {};
      db.dailyStats[db.lastResetDate] = Object.entries(db.tus).reduce((acc,[id,t])=>{
        acc[id] = t.totalToday; return acc;
      }, {});
      // Giữ 60 ngày
      const keys = Object.keys(db.dailyStats).sort();
      if (keys.length > 60) delete db.dailyStats[keys[0]];
    }
    db.lastResetDate = today;
    Object.values(db.tus).forEach(t => t.totalToday = 0);
    saveData();
  }
}
setInterval(resetDailyIfNeeded, 60000);
resetDailyIfNeeded();

// ── Kiểm tra tủ offline định kỳ ──────────────────────────
setInterval(() => {
  const now = Date.now();
  Object.entries(db.tus).forEach(([id, tu]) => {
    if (!tu.lastSeen) return;
    const mins = (now - new Date(tu.lastSeen)) / 60000;
    if (mins > OFFLINE_MINS && !tu.offlineAlerted) {
      tu.offlineAlerted = true;
      saveData();
      sendAlert(`⚠️ *TỦ OFFLINE*\nTủ *${tu.name}* [${id}] không kết nối trong *${Math.round(mins)} phút*!`);
    }
    if (mins <= OFFLINE_MINS && tu.offlineAlerted) {
      tu.offlineAlerted = false;
      saveData();
      sendAlert(`✅ *TỦ ĐÃ ONLINE TRỞ LẠI*\nTủ *${tu.name}* [${id}] đã kết nối lại.`);
    }
  });
}, 60000);

// ── Middleware auth dashboard ─────────────────────────────
function authAdmin(req, res, next) {
  const pass = req.query.pass || req.headers['x-pass'] || (req.body && req.body.pass);
  if (pass === DASHBOARD_PASS) { req.role = 'admin'; req.tuFilter = null; return next(); }
  // Kiểm tra pass của từng tủ
  for (const [id, tu] of Object.entries(db.tus)) {
    if (tu.ownerPass && pass === tu.ownerPass) {
      req.role = 'owner'; req.tuFilter = id; return next();
    }
  }
  return res.status(401).json({ error:'Unauthorized' });
}

// ════════════════════════════════════════════════════════════
//  SEPAY WEBHOOKS – Nhận tiền
// ════════════════════════════════════════════════════════════
app.post('/webhook/:tuId', (req, res) => {
  const sentKey = (req.headers['authorization']||'').replace('Apikey ','').trim();
  if (sentKey !== SEPAY_API_KEY) return res.status(401).json({success:false,message:'Unauthorized'});

  const tuId = req.params.tuId.toLowerCase();
  const data = req.body;
  if (data.transferType !== 'in') return res.json({success:true,message:'Ignored'});

  const amount = Number(data.transferAmount)||0;
  if (amount <= 0) return res.json({success:true,message:'Invalid amount'});

  const txId = String(data.id);
  const tu   = getTu(tuId);

  if (tu.processedIds.includes(txId)) return res.json({success:true,message:'Duplicate'});
  if (tu.processedIds.length > 200) tu.processedIds.shift();
  tu.processedIds.push(txId);

  tu.pendingAmount += amount;
  tu.totalToday    += amount;
  tu.totalAll      += amount;
  tu.lastSeen       = new Date().toISOString();
  tu.offlineAlerted = false;
  tu.lastTx         = {
    id:txId, amount, content:data.content,
    gateway:data.gateway, time:new Date().toISOString(), reference:data.referenceCode
  };

  db.transactions.unshift({ tuId, tuName:tu.name, amount, content:data.content, time:new Date().toISOString() });
  if (db.transactions.length > 500) db.transactions.pop();
  saveData();

  console.log(`[TX] ${tuId} +${amount}đ | Pending: ${tu.pendingAmount}đ`);
  res.json({success:true, message:'OK', tuId, amount});
});

// ════════════════════════════════════════════════════════════
//  ESP32 ENDPOINTS
// ════════════════════════════════════════════════════════════

// Lấy tiền + nhận lệnh chờ
app.get('/amount/:tuId', (req, res) => {
  const tuId = req.params.tuId.toLowerCase();
  const tu   = getTu(tuId);

  const amt        = tu.pendingAmount;
  tu.pendingAmount = 0;
  tu.lastSeen      = new Date().toISOString();
  tu.offlineAlerted = false;

  // Lấy lệnh chờ rồi xóa
  const cmd  = tu.pendingCmd || null;
  tu.pendingCmd = null;
  saveData();

  console.log(`[ESP32 ← ${tuId}] Tiền: ${amt}đ | Lệnh: ${cmd ? JSON.stringify(cmd) : 'none'}`);
  res.json({ amount:amt, tuId, lastTx:tu.lastTx, cmd, config:tu.config });
});

// Đăng ký tên tủ
app.post('/api/register', (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.status(400).json({ok:false});
  const tu    = getTu(id.toLowerCase());
  if (name) tu.name = name;
  tu.lastSeen = new Date().toISOString();
  tu.offlineAlerted = false;
  saveData();
  res.json({ok:true, tuId:id, name:tu.name, config:tu.config});
});

// Kiểm tra trùng mã tủ
app.get('/check/:tuId', (req, res) => {
  const tuId  = req.params.tuId.toLowerCase();
  const exists = !!db.tus[tuId];
  res.json({ tuId, exists });
});

// ════════════════════════════════════════════════════════════
//  DASHBOARD API
// ════════════════════════════════════════════════════════════

// Lấy dữ liệu tổng
app.get('/api/stats', authAdmin, (req, res) => {
  let tus = Object.entries(db.tus).map(([id,t]) => ({
    id, name:t.name, phone:t.phone, address:t.address, note:t.note,
    pendingAmount:t.pendingAmount, totalToday:t.totalToday, totalAll:t.totalAll,
    lastSeen:t.lastSeen, lastTx:t.lastTx, createdAt:t.createdAt,
    config:t.config, hasPendingCmd:!!t.pendingCmd, hasOwnerPass:!!t.ownerPass,
  }));

  if (req.tuFilter) tus = tus.filter(t => t.id === req.tuFilter);

  const txs = req.tuFilter
    ? db.transactions.filter(t => t.tuId === req.tuFilter).slice(0,100)
    : db.transactions.slice(0,100);

  res.json({
    role     : req.role,
    tuFilter : req.tuFilter,
    tus,
    transactions: txs,
    dailyStats  : db.dailyStats || {},
    summary: {
      totalToday: tus.reduce((s,t)=>s+t.totalToday,0),
      totalAll  : tus.reduce((s,t)=>s+t.totalAll,  0),
      tuCount   : tus.length,
    }
  });
});

// Cập nhật thông tin tủ
app.post('/api/tu/:tuId/update', authAdmin, (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({error:'Admin only'});
  const tuId = req.params.tuId.toLowerCase();
  const tu   = getTu(tuId);
  const { name, phone, address, note, ownerPass, price, runSeconds } = req.body;
  if (name)       tu.name       = name;
  if (phone)      tu.phone      = phone;
  if (address)    tu.address    = address;
  if (note)       tu.note       = note;
  if (ownerPass !== undefined) tu.ownerPass = ownerPass;
  if (price)      tu.config.price      = Number(price);
  if (runSeconds) tu.config.runSeconds = Number(runSeconds);
  saveData();
  res.json({ok:true, tu});
});

// Gửi lệnh điều khiển tủ (ESP32 sẽ nhận lần ping tới)
app.post('/api/tu/:tuId/cmd', authAdmin, (req, res) => {
  const tuId = req.params.tuId.toLowerCase();
  if (req.tuFilter && req.tuFilter !== tuId) return res.status(403).json({error:'Forbidden'});
  const tu  = getTu(tuId);
  const { action, value } = req.body;

  const validCmds = ['stop','reset','add_minutes','set_price','set_seconds'];
  if (!validCmds.includes(action)) return res.status(400).json({error:'Invalid action'});

  tu.pendingCmd = { action, value: value ? Number(value) : undefined, ts: Date.now() };
  saveData();

  console.log(`[CMD] ${tuId} ← ${action} ${value||''}`);
  res.json({ok:true, cmd:tu.pendingCmd});
});

// Xóa tủ
app.delete('/api/tu/:tuId', authAdmin, (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({error:'Admin only'});
  const tuId = req.params.tuId.toLowerCase();
  delete db.tus[tuId];
  saveData();
  res.json({ok:true});
});

// ════════════════════════════════════════════════════════════
//  DASHBOARD WEB
// ════════════════════════════════════════════════════════════
app.get('/dashboard', (req, res) => {
  const pass = req.query.pass;
  if (!pass) return res.send(loginPage());

  // Kiểm tra quyền
  let role = null, tuFilter = null;
  if (pass === DASHBOARD_PASS) { role = 'admin'; }
  else {
    for (const [id,tu] of Object.entries(db.tus)) {
      if (tu.ownerPass && pass === tu.ownerPass) { role='owner'; tuFilter=id; break; }
    }
  }
  if (!role) return res.send(`<div style="text-align:center;margin-top:60px;font-family:sans-serif"><h3>❌ Sai mật khẩu</h3><a href="/dashboard">Thử lại</a></div>`);

  res.send(dashboardPage(pass, role, tuFilter));
});

function loginPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Đăng nhập – Tủ Điện Rửa Xe</title>
  <style>*{box-sizing:border-box}body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f2f5}
  .box{background:#fff;padding:32px;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.1);width:320px;text-align:center}
  .logo{font-size:40px;margin-bottom:8px}.title{font-size:20px;font-weight:600;margin-bottom:4px}
  .sub{font-size:13px;color:#888;margin-bottom:24px}
  input{width:100%;padding:11px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:12px;outline:none}
  input:focus{border-color:#1D9E75}
  button{width:100%;padding:12px;background:#1D9E75;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:500}
  button:hover{background:#0F6E56}</style></head>
  <body><div class="box">
  <div class="logo">🚗</div>
  <div class="title">Tủ Điện Rửa Xe</div>
  <div class="sub">Dashboard quản lý</div>
  <input type="password" id="p" placeholder="Nhập mật khẩu..." onkeydown="if(event.key==='Enter')go()">
  <button onclick="go()">Đăng nhập</button>
  </div>
  <script>function go(){location='/dashboard?pass='+encodeURIComponent(document.getElementById('p').value)}</script>
  </body></html>`;
}

function dashboardPage(pass, role, tuFilter) {
  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard – Tủ Điện Rửa Xe</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#f0f2f5;color:#222;min-height:100vh}
.hdr{background:#1D9E75;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100;gap:12px}
.hdr-left{display:flex;align-items:center;gap:12px}
.hdr h1{font-size:16px;font-weight:600}
.hdr .sub{font-size:11px;opacity:.8}
.role-badge{background:rgba(255,255,255,.25);font-size:11px;padding:2px 8px;border-radius:10px}
.hdr-btns{display:flex;gap:8px;align-items:center}
.hdr button{background:rgba(255,255,255,.2);color:#fff;border:none;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px}
.hdr button:hover{background:rgba(255,255,255,.3)}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.sc{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.sc .v{font-size:22px;font-weight:700;color:#1D9E75;margin:6px 0 2px}
.sc .l{font-size:12px;color:#888}
.sc.warn .v{color:#EF9F27}
.tabs{display:flex;gap:4px;margin-bottom:16px;background:#fff;padding:4px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);width:fit-content}
.tab{padding:7px 16px;border-radius:7px;font-size:13px;cursor:pointer;font-weight:500;color:#888;border:none;background:none}
.tab.active{background:#1D9E75;color:#fff}
.pane{display:none}.pane.active{display:block}
.tu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-bottom:24px}
.tc{background:#fff;border-radius:12px;padding:0;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden;border-top:3px solid #ddd}
.tc.on{border-top-color:#1D9E75}.tc.pend{border-top-color:#EF9F27}.tc.off{border-top-color:#ccc}
.tc-hdr{padding:14px 16px 10px;display:flex;justify-content:space-between;align-items:flex-start}
.tc-name{font-weight:600;font-size:14px}
.tc-id{font-size:11px;color:#aaa;margin-top:2px}
.bdg{font-size:10px;padding:2px 7px;border-radius:8px;font-weight:500;white-space:nowrap}
.bon{background:#E1F5EE;color:#0F6E56}.boff{background:#eee;color:#888}.bpend{background:#FAEEDA;color:#854F0B}
.tc-body{padding:0 16px 12px}
.row{display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid #f5f5f5}
.row:last-child{border:none}
.row .k{color:#888}.row .v2{font-weight:500}
.tc-ctrl{padding:12px 16px;background:#fafafa;border-top:1px solid #f0f0f0;display:flex;flex-wrap:wrap;gap:6px}
.btn{padding:6px 10px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid #ddd;background:#fff;font-weight:500;transition:all .15s}
.btn:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(0,0,0,.1)}
.btn.green{background:#1D9E75;color:#fff;border-color:#1D9E75}
.btn.red{background:#E24B4A;color:#fff;border-color:#E24B4A}
.btn.amber{background:#EF9F27;color:#fff;border-color:#EF9F27}
.btn.gray{background:#888;color:#fff;border-color:#888}
.tc-edit{padding:12px 16px;background:#f8f8f8;border-top:1px solid #eee;display:none}
.tc-edit label{font-size:11px;color:#888;display:block;margin-bottom:2px;margin-top:8px}
.tc-edit label:first-child{margin-top:0}
.tc-edit input{width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;outline:none}
.tc-edit input:focus{border-color:#1D9E75}
.edit-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.save-btn{margin-top:10px;width:100%;padding:8px;background:#1D9E75;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:500}
.tbl{width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.tbl th{background:#f8f8f8;padding:10px 14px;font-size:12px;text-align:left;color:#555;font-weight:500}
.tbl td{padding:9px 14px;font-size:12px;border-top:1px solid #f0f0f0}
.amt{color:#1D9E75;font-weight:600}
.chart-wrap{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:16px}
.chart-title{font-size:14px;font-weight:600;margin-bottom:12px}
.bar-chart{display:flex;align-items:flex-end;gap:4px;height:120px;padding:0 4px}
.bar-col{display:flex;flex-direction:column;align-items:center;flex:1;gap:3px}
.bar{width:100%;background:#1D9E75;border-radius:3px 3px 0 0;min-height:2px;transition:height .3s}
.bar-label{font-size:9px;color:#aaa;text-align:center;white-space:nowrap}
.bar-val{font-size:9px;color:#555;text-align:center}
.add-time-inp{width:50px;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:12px;text-align:center;margin-right:4px}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;align-items:center;justify-content:center}
.modal-bg.show{display:flex}
.modal{background:#fff;border-radius:16px;padding:24px;width:340px;max-width:90vw}
.modal h3{font-size:16px;margin-bottom:16px}
.modal label{font-size:12px;color:#888;display:block;margin-bottom:3px;margin-top:10px}
.modal label:first-of-type{margin-top:0}
.modal input{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;outline:none}
.modal input:focus{border-color:#1D9E75}
.modal-btns{display:flex;gap:8px;margin-top:16px}
.modal-btns button{flex:1;padding:10px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:500}
.modal-btns .cancel{background:#f0f0f0;color:#555}
.modal-btns .confirm{background:#1D9E75;color:#fff}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:300;display:none;animation:fadeup .3s}
@keyframes fadeup{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.filter-row{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.filter-row select,.filter-row input{padding:7px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;outline:none}
.offline-badge{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px}
.offline-badge.on{background:#1D9E75}.offline-badge.off{background:#ccc}.offline-badge.pend{background:#EF9F27}
@media(max-width:600px){.summary{grid-template-columns:1fr 1fr}.hdr h1{font-size:14px}}
</style>
</head><body>

<div class="hdr">
  <div class="hdr-left">
    <div>
      <h1>🚗 Tủ Điện Rửa Xe</h1>
      <div class="sub" id="upd">Đang tải...</div>
    </div>
    <span class="role-badge" id="role-badge"></span>
  </div>
  <div class="hdr-btns">
    <button onclick="load()">↻ Làm mới</button>
    <button onclick="location='/dashboard'">Đổi TK</button>
  </div>
</div>

<div class="wrap">
  <div class="summary">
    <div class="sc"><div class="l">Tổng tủ</div><div class="v" id="s1">—</div></div>
    <div class="sc"><div class="l">Online</div><div class="v" id="s2">—</div></div>
    <div class="sc"><div class="l">Doanh thu hôm nay</div><div class="v" id="s3">—</div></div>
    <div class="sc"><div class="l">Tổng doanh thu</div><div class="v" id="s4">—</div></div>
  </div>

  <div class="tabs">
    <button class="tab active" onclick="showTab('tus',this)">📋 Danh sách tủ</button>
    <button class="tab" onclick="showTab('txs',this)">💳 Giao dịch</button>
    <button class="tab" onclick="showTab('stats',this)">📊 Thống kê</button>
  </div>

  <!-- Tab tủ -->
  <div class="pane active" id="pane-tus">
    <div class="tu-grid" id="grid"></div>
  </div>

  <!-- Tab giao dịch -->
  <div class="pane" id="pane-txs">
    <div class="filter-row">
      <select id="tx-filter-tu" onchange="renderTxs()"><option value="">Tất cả tủ</option></select>
      <input type="text" id="tx-search" placeholder="Tìm nội dung..." oninput="renderTxs()" style="flex:1;min-width:120px">
    </div>
    <table class="tbl">
      <thead><tr><th>Thời gian</th><th>Tủ</th><th>Số tiền</th><th>Nội dung CK</th></tr></thead>
      <tbody id="txs"></tbody>
    </table>
  </div>

  <!-- Tab thống kê -->
  <div class="pane" id="pane-stats">
    <div class="chart-wrap">
      <div class="chart-title">Doanh thu 7 ngày gần nhất</div>
      <div class="bar-chart" id="chart7"></div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Doanh thu 30 ngày</div>
      <div class="bar-chart" id="chart30"></div>
    </div>
  </div>
</div>

<!-- Modal thêm thời gian -->
<div class="modal-bg" id="modal-add">
  <div class="modal">
    <h3>➕ Thêm thời gian</h3>
    <label>Số phút muốn thêm</label>
    <input type="number" id="modal-mins" value="5" min="1" max="999">
    <label>Tủ: <span id="modal-tu-name" style="color:#1D9E75"></span></label>
    <div class="modal-btns">
      <button class="cancel" onclick="closeModal('modal-add')">Hủy</button>
      <button class="confirm" onclick="confirmAdd()">✅ Xác nhận</button>
    </div>
  </div>
</div>

<!-- Modal chỉnh giá -->
<div class="modal-bg" id="modal-price">
  <div class="modal">
    <h3>💰 Chỉnh cấu hình</h3>
    <label>Giá tiền (VNĐ / chu kỳ)</label>
    <input type="number" id="modal-price-val" min="1000">
    <label>Thời gian 1 chu kỳ (giây)</label>
    <input type="number" id="modal-secs-val" min="1">
    <label style="font-size:10px;color:#aaa">ESP32 sẽ cập nhật cấu hình trong lần ping tới</label>
    <div class="modal-btns">
      <button class="cancel" onclick="closeModal('modal-price')">Hủy</button>
      <button class="confirm" onclick="confirmPrice()">💾 Lưu</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const PASS = '${pass}';
let allData = null;
let modalTuId = '';

function fmt(n){return Number(n||0).toLocaleString('vi-VN')+'đ'}
function ago(iso){
  if(!iso)return'—';
  const s=Math.floor((Date.now()-new Date(iso))/1000);
  if(s<60)return s+'s trước';
  if(s<3600)return Math.floor(s/60)+'p trước';
  if(s<86400)return Math.floor(s/3600)+'h trước';
  return Math.floor(s/86400)+'ng trước';
}
function loc(iso){return iso?new Date(iso).toLocaleString('vi-VN'):'—'}
function online(ls){return ls&&(Date.now()-new Date(ls))<30000}
function showTab(id,btn){
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('pane-'+id).classList.add('active');
  btn.classList.add('active');
  if(id==='stats') renderCharts();
}
function toast(msg,ok=true){
  const t=document.getElementById('toast');
  t.textContent=msg; t.style.background=ok?'#1D9E75':'#E24B4A';
  t.style.display='block';
  setTimeout(()=>t.style.display='none',2500);
}
function openModal(id){document.getElementById(id).classList.add('show')}
function closeModal(id){document.getElementById(id).classList.remove('show')}

async function api(path,method='GET',body=null){
  const opts={method,headers:{'Content-Type':'application/json','x-pass':PASS}};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(path,opts);
  return r.json();
}

async function sendCmd(tuId,action,value=null){
  const d=await api('/api/tu/'+tuId+'/cmd','POST',{action,value});
  if(d.ok) toast('✅ Đã gửi lệnh! ESP32 thực thi trong ~3 giây.');
  else toast('❌ Lỗi: '+(d.error||'unknown'),false);
}

// Mở modal thêm giờ
function openAdd(tuId,name){
  modalTuId=tuId;
  document.getElementById('modal-tu-name').textContent=name;
  document.getElementById('modal-mins').value=5;
  openModal('modal-add');
}
async function confirmAdd(){
  const mins=parseInt(document.getElementById('modal-mins').value)||0;
  if(mins<=0){toast('Nhập số phút hợp lệ!',false);return}
  closeModal('modal-add');
  await sendCmd(modalTuId,'add_minutes',mins);
}

// Mở modal chỉnh giá
function openPrice(tuId,price,secs){
  modalTuId=tuId;
  document.getElementById('modal-price-val').value=price;
  document.getElementById('modal-secs-val').value=secs;
  openModal('modal-price');
}
async function confirmPrice(){
  const price=parseInt(document.getElementById('modal-price-val').value)||0;
  const secs =parseInt(document.getElementById('modal-secs-val').value)||0;
  if(price<=0||secs<=0){toast('Giá trị không hợp lệ!',false);return}
  closeModal('modal-price');
  // Cập nhật cả server và gửi lệnh cho ESP32
  const upd=await api('/api/tu/'+modalTuId+'/update','POST',{price,runSeconds:secs});
  if(upd.ok){
    await sendCmd(modalTuId,'set_price',price);
    await sendCmd(modalTuId,'set_seconds',secs);
    load();
  } else toast('❌ Lỗi lưu cấu hình',false);
}

// Toggle form chỉnh sửa tủ
function toggleEdit(tuId){
  const el=document.getElementById('edit-'+tuId);
  el.style.display = el.style.display==='none'?'block':'none';
}

async function saveTu(tuId){
  const name    = document.getElementById('ename-'+tuId).value;
  const phone   = document.getElementById('ephone-'+tuId).value;
  const address = document.getElementById('eaddr-'+tuId).value;
  const note    = document.getElementById('enote-'+tuId).value;
  const opass   = document.getElementById('eopass-'+tuId).value;
  const d = await api('/api/tu/'+tuId+'/update','POST',{name,phone,address,note,ownerPass:opass});
  if(d.ok){toast('✅ Đã lưu thông tin tủ');load();}
  else toast('❌ Lỗi lưu',false);
}

async function deleteTu(tuId,name){
  if(!confirm('Xóa tủ "'+name+'" ('+tuId+')?\nToàn bộ dữ liệu sẽ mất!'))return;
  const d=await api('/api/tu/'+tuId,'DELETE');
  if(d.ok){toast('Đã xóa tủ '+name);load();}
  else toast('❌ Lỗi xóa',false);
}

// Render danh sách tủ
function renderTus(tus){
  const g=document.getElementById('grid');
  if(!tus.length){
    g.innerHTML='<div style="color:#aaa;font-size:13px;padding:12px">Chưa có tủ nào kết nối.</div>';
    return;
  }
  g.innerHTML=tus.map(t=>{
    const on=online(t.lastSeen), pend=t.pendingAmount>0;
    const cls=pend?'pend':on?'on':'off';
    const bdg=pend?'<span class="bdg bpend">⏳ Có tiền chờ</span>':
              on ?'<span class="bdg bon"><span class="offline-badge on"></span>Online</span>':
                  '<span class="bdg boff"><span class="offline-badge off"></span>Offline</span>';
    const wh=location.origin+'/webhook/'+t.id;
    return \`<div class="tc \${cls}">
      <div class="tc-hdr">
        <div><div class="tc-name">\${t.name}</div><div class="tc-id">\${t.id}</div></div>
        \${bdg}
      </div>
      <div class="tc-body">
        <div class="row"><span class="k">Tiền đang chờ</span><span class="v2" style="color:#EF9F27">\${fmt(t.pendingAmount)}</span></div>
        <div class="row"><span class="k">Hôm nay</span><span class="v2">\${fmt(t.totalToday)}</span></div>
        <div class="row"><span class="k">Tổng tất cả</span><span class="v2">\${fmt(t.totalAll)}</span></div>
        <div class="row"><span class="k">Giá / chu kỳ</span><span class="v2">\${fmt(t.config?.price)} / \${t.config?.runSeconds}s</span></div>
        <div class="row"><span class="k">Kết nối lần cuối</span><span class="v2">\${ago(t.lastSeen)}</span></div>
        <div class="row"><span class="k">GD cuối</span><span class="v2">\${t.lastTx?fmt(t.lastTx.amount)+' – '+ago(t.lastTx.time):'—'}</span></div>
        \${t.address?'<div class="row"><span class="k">Địa chỉ</span><span class="v2" style="text-align:right;max-width:160px">'+t.address+'</span></div>':''}
        \${t.phone?'<div class="row"><span class="k">SĐT</span><span class="v2">'+t.phone+'</span></div>':''}
      </div>
      <div class="tc-ctrl">
        <button class="btn green" onclick="openAdd('\${t.id}','\${t.name}')">➕ Thêm giờ</button>
        <button class="btn amber" onclick="openPrice('\${t.id}',\${t.config?.price||10000},\${t.config?.runSeconds||300})">💰 Đổi giá</button>
        <button class="btn red" onclick="sendCmd('\${t.id}','stop')">⛔ Stop</button>
        <button class="btn gray" onclick="sendCmd('\${t.id}','reset')">🔄 Reset</button>
        <button class="btn" onclick="toggleEdit('\${t.id}')">✏️ Sửa</button>
      </div>
      <div class="tc-edit" id="edit-\${t.id}">
        <label>Tên tủ</label><input id="ename-\${t.id}" value="\${t.name}">
        <div class="edit-row">
          <div><label>SĐT chủ tủ</label><input id="ephone-\${t.id}" value="\${t.phone||''}"></div>
          <div><label>Mật khẩu chủ tủ</label><input id="eopass-\${t.id}" value="\${t.hasOwnerPass?'(đã đặt)':''}" placeholder="Để trống = không có"></div>
        </div>
        <label>Địa chỉ lắp đặt</label><input id="eaddr-\${t.id}" value="\${t.address||''}">
        <label>Ghi chú nội bộ</label><input id="enote-\${t.id}" value="\${t.note||''}">
        <label style="font-size:10px;color:#aaa">Webhook SePay: \${wh}</label>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="save-btn" onclick="saveTu('\${t.id}')">💾 Lưu thông tin</button>
          <button class="save-btn" style="background:#E24B4A" onclick="deleteTu('\${t.id}','\${t.name}')">🗑 Xóa tủ</button>
        </div>
      </div>
    </div>\`;
  }).join('');
}

// Render giao dịch
let allTxs=[], allTus=[];
function renderTxs(){
  const tuF  = document.getElementById('tx-filter-tu')?.value||'';
  const srch = (document.getElementById('tx-search')?.value||'').toLowerCase();
  let txs = allTxs.filter(tx=>
    (!tuF  || tx.tuId===tuF) &&
    (!srch || (tx.content||'').toLowerCase().includes(srch) || tx.tuId.includes(srch))
  );
  const sel = document.getElementById('tx-filter-tu');
  if(sel && sel.options.length<=1){
    allTus.forEach(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.name+' ('+t.id+')';sel.appendChild(o)});
  }
  const tb=document.getElementById('txs');
  if(!txs.length){tb.innerHTML='<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Không có giao dịch</td></tr>';return}
  tb.innerHTML=txs.map(tx=>\`<tr>
    <td>\${loc(tx.time)}</td>
    <td><b>\${tx.tuName||tx.tuId}</b></td>
    <td class="amt">+\${fmt(tx.amount)}</td>
    <td style="color:#888;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${tx.content||'—'}</td>
  </tr>\`).join('');
}

// Render biểu đồ
function renderCharts(){
  if(!allData) return;
  const daily = allData.dailyStats||{};
  const keys  = Object.keys(daily).sort().slice(-30);
  const today = new Date().toLocaleDateString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'});

  // Thêm hôm nay
  const todayData = {};
  (allData.tus||[]).forEach(t=>todayData[t.id]=(t.totalToday||0));
  const allKeys = [...keys, today];
  const allVals = allKeys.map(k=>{
    if(k===today) return Object.values(todayData).reduce((a,b)=>a+b,0);
    const d=daily[k]||{}; return Object.values(d).reduce((a,b)=>a+b,0);
  });

  const max7  = Math.max(...allVals.slice(-7),1);
  const max30 = Math.max(...allVals,1);

  function makeChart(containerId, vals, ks){
    const c=document.getElementById(containerId);
    if(!c)return;
    c.innerHTML=vals.map((v,i)=>{
      const h=Math.max(Math.round(v/ks*100),2);
      const d=allKeys[allKeys.length-vals.length+i];
      const parts=d.split('/'); const label=parts[0]+'/'+parts[1];
      return \`<div class="bar-col">
        <div class="bar-val">\${v>=1000?Math.round(v/1000)+'k':v||''}</div>
        <div class="bar" style="height:\${h}%"></div>
        <div class="bar-label">\${label}</div>
      </div>\`;
    }).join('');
  }

  makeChart('chart7',  allVals.slice(-7),  max7);
  makeChart('chart30', allVals.slice(-30), max30);
}

// Load dữ liệu
async function load(){
  try{
    const d=await api('/api/stats');
    if(d.error){location='/dashboard';return}
    allData=d; allTxs=d.transactions||[]; allTus=d.tus||[];

    document.getElementById('role-badge').textContent = d.role==='admin'?'👑 Admin':'👤 Chủ tủ';
    document.getElementById('upd').textContent='Cập nhật: '+new Date().toLocaleTimeString('vi-VN');

    const onlineCount=(d.tus||[]).filter(t=>t.lastSeen&&(Date.now()-new Date(t.lastSeen))<30000).length;
    document.getElementById('s1').textContent=d.summary.tuCount;
    document.getElementById('s2').textContent=onlineCount+'/'+d.summary.tuCount;
    document.getElementById('s3').textContent=fmt(d.summary.totalToday);
    document.getElementById('s4').textContent=fmt(d.summary.totalAll);

    renderTus(d.tus||[]);
    renderTxs();
    if(document.getElementById('pane-stats').classList.contains('active')) renderCharts();
  }catch(e){console.error(e)}
}

load();
setInterval(load,8000);
</script>
</body></html>`;
}

// ── Ping ──────────────────────────────────────────────────
app.get('/ping', (req,res) => {
  res.json({ok:true, uptime:Math.floor(process.uptime())+'s', tuCount:Object.keys(db.tus).length});
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Port ${PORT}`);
  console.log(`[SERVER] Dashboard: http://localhost:${PORT}/dashboard`);
});