/**
 * ============================================================
 *  WEBHOOK SERVER ĐA TỦ – Mỗi tủ có endpoint riêng
 * ============================================================
 *  CÁCH HOẠT ĐỘNG:
 *  - Mỗi tủ bán ra có mã riêng: tu001, tu002, tu003...
 *  - Trên SePay: mỗi tủ đăng ký webhook URL riêng:
 *      https://carwash-webhook.onrender.com/webhook/tu001
 *      https://carwash-webhook.onrender.com/webhook/tu002
 *  - ESP32 gọi endpoint riêng để lấy tiền:
 *      https://carwash-webhook.onrender.com/amount/tu001
 *
 *  BIẾN MÔI TRƯỜNG (Render → Environment Variables):
 *  SEPAY_API_KEY  = carwash_secret_2025
 *  DASHBOARD_PASS = matkhau_dashboard
 * ============================================================
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const app     = express();
app.use(express.json());

// ── Bảo mật ───────────────────────────────────────────────
const SEPAY_API_KEY  = process.env.SEPAY_API_KEY  || 'carwash_secret_2025';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin123';

// ── Lưu dữ liệu ra file (giữ qua restart) ────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { tus: {}, transactions: [], lastResetDate: '' };
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}

let db = loadData();

// ── Lấy hoặc tạo mới thông tin tủ ────────────────────────
function getTu(id) {
  if (!db.tus[id]) {
    db.tus[id] = {
      name         : 'Tủ ' + id,
      pendingAmount: 0,
      totalToday   : 0,
      totalAll     : 0,
      lastSeen     : null,
      lastTx       : null,
      processedIds : [],
      createdAt    : new Date().toISOString(),
    };
    saveData();
    console.log(`[NEW] Tạo mới tủ: ${id}`);
  }
  return db.tus[id];
}

// ── Reset doanh thu ngày lúc 0h ───────────────────────────
function resetDailyIfNeeded() {
  const today = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  if (db.lastResetDate !== today) {
    db.lastResetDate = today;
    Object.values(db.tus).forEach(t => t.totalToday = 0);
    saveData();
    console.log('[RESET] Đã reset doanh thu ngày:', today);
  }
}
setInterval(resetDailyIfNeeded, 60 * 1000);
resetDailyIfNeeded();

// ── POST /webhook/:tuId – SePay gọi khi có tiền ──────────
// URL ví dụ: /webhook/tu001
app.post('/webhook/:tuId', (req, res) => {

  // Xác thực API Key từ SePay
  const sentKey = (req.headers['authorization'] || '').replace('Apikey ', '').trim();
  if (sentKey !== SEPAY_API_KEY) {
    console.warn(`[AUTH] Sai API Key từ ${req.params.tuId}:`, sentKey);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const tuId = req.params.tuId.toLowerCase();
  const data = req.body;
  console.log(`[SEPAY → ${tuId}]`, JSON.stringify(data));

  // Chỉ xử lý tiền vào
  if (data.transferType !== 'in') {
    return res.json({ success: true, message: 'Ignored' });
  }

  const amount = Number(data.transferAmount) || 0;
  if (amount <= 0) return res.json({ success: true, message: 'Invalid amount' });

  const txId = String(data.id);
  const tu   = getTu(tuId);

  // Chống trùng giao dịch (SePay retry)
  if (tu.processedIds.includes(txId)) {
    console.log(`[DUP] Bỏ qua giao dịch trùng: ${txId}`);
    return res.json({ success: true, message: 'Already processed' });
  }

  if (tu.processedIds.length > 200) tu.processedIds.shift();
  tu.processedIds.push(txId);

  // Cộng tiền vào hàng chờ
  tu.pendingAmount += amount;
  tu.totalToday    += amount;
  tu.totalAll      += amount;
  tu.lastSeen       = new Date().toISOString();
  tu.lastTx         = {
    id       : txId,
    amount   : amount,
    content  : data.content,
    gateway  : data.gateway,
    time     : new Date().toISOString(),
    reference: data.referenceCode,
  };

  // Lưu lịch sử (tối đa 500)
  db.transactions.unshift({
    tuId,
    tuName : tu.name,
    amount,
    content: data.content,
    time   : new Date().toISOString(),
  });
  if (db.transactions.length > 500) db.transactions.pop();

  saveData();
  console.log(`[OK] Tủ ${tuId} +${amount}đ | Pending: ${tu.pendingAmount}đ`);

  // Trả 200 để SePay không retry
  res.json({ success: true, message: 'OK', tuId, amount });
});

// ── GET /amount/:tuId – ESP32 lấy tiền ───────────────────
// URL ví dụ: /amount/tu001
app.get('/amount/:tuId', (req, res) => {
  const tuId = req.params.tuId.toLowerCase();
  const tu   = getTu(tuId);

  const amt        = tu.pendingAmount;
  tu.pendingAmount = 0;
  tu.lastSeen      = new Date().toISOString();
  saveData();

  console.log(`[ESP32 ← ${tuId}] Trả: ${amt}đ`);
  res.json({ amount: amt, tuId, lastTx: tu.lastTx });
});

// ── POST /api/register – ESP32 đặt tên cho tủ ────────────
app.post('/api/register', (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.status(400).json({ ok: false, message: 'Thiếu id' });
  const tu = getTu(id.toLowerCase());
  if (name) tu.name = name;
  tu.lastSeen = new Date().toISOString();
  saveData();
  console.log(`[REG] Tủ ${id} đăng ký: ${name}`);
  res.json({ ok: true, tuId: id, name: tu.name });
});

// ── GET /api/stats – Dữ liệu JSON cho dashboard ──────────
app.get('/api/stats', (req, res) => {
  const pass = req.query.pass || req.headers['x-pass'];
  if (pass !== DASHBOARD_PASS) return res.status(401).json({ error: 'Unauthorized' });

  const tus = Object.entries(db.tus).map(([id, t]) => ({
    id, name: t.name,
    pendingAmount: t.pendingAmount,
    totalToday   : t.totalToday,
    totalAll     : t.totalAll,
    lastSeen     : t.lastSeen,
    lastTx       : t.lastTx,
    createdAt    : t.createdAt,
  }));

  res.json({
    tus,
    transactions: db.transactions.slice(0, 100),
    summary: {
      totalToday: tus.reduce((s, t) => s + t.totalToday, 0),
      totalAll  : tus.reduce((s, t) => s + t.totalAll,   0),
      tuCount   : tus.length,
    },
  });
});

// ── GET /dashboard – Trang theo dõi ──────────────────────
app.get('/dashboard', (req, res) => {
  const pass = req.query.pass;

  if (!pass) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Đăng nhập Dashboard</title>
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f2f5}
      .box{background:#fff;padding:32px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.1);width:320px;text-align:center}
      h2{margin:0 0 8px;font-size:20px} p{font-size:13px;color:#888;margin:0 0 20px}
      input{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box}
      button{width:100%;padding:12px;background:#1D9E75;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
      button:hover{background:#0F6E56}
    </style></head>
    <body><div class="box">
      <h2>🚗 Tủ Điện Rửa Xe</h2>
      <p>Dashboard quản lý</p>
      <input type="password" id="p" placeholder="Nhập mật khẩu..." onkeydown="if(event.key==='Enter')go()">
      <button onclick="go()">Đăng nhập</button>
    </div>
    <script>function go(){location='/dashboard?pass='+encodeURIComponent(document.getElementById('p').value)}</script>
    </body></html>`);
  }

  if (pass !== DASHBOARD_PASS) {
    return res.send(`<div style="text-align:center;margin-top:60px;font-family:sans-serif">
      <div style="font-size:40px">❌</div>
      <h3>Sai mật khẩu!</h3>
      <a href="/dashboard">Thử lại</a></div>`);
  }

  res.send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard – Tủ Điện Rửa Xe</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#f0f2f5;color:#222;min-height:100vh}
.hdr{background:#1D9E75;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}
.hdr h1{font-size:17px;font-weight:600}
.hdr .meta{font-size:11px;opacity:.8}
.hdr button{background:rgba(255,255,255,.2);color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px}
.wrap{max-width:960px;margin:0 auto;padding:16px}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.sc{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.sc .v{font-size:24px;font-weight:700;color:#1D9E75;margin:6px 0 2px}
.sc .l{font-size:12px;color:#888}
.ttl{font-size:14px;font-weight:600;margin:0 0 10px}
.tu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:24px}
.tc{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.07);border-top:3px solid #ddd}
.tc.on{border-top-color:#1D9E75}
.tc.pend{border-top-color:#EF9F27}
.tc.off{border-top-color:#ddd}
.tc-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.tc-name{font-weight:600;font-size:14px}
.bdg{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500}
.bon{background:#E1F5EE;color:#0F6E56}
.boff{background:#eee;color:#888}
.bpend{background:#FAEEDA;color:#854F0B}
.row{display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid #f5f5f5}
.row:last-child{border:none}
.row .k{color:#888}.row .v2{font-weight:500}
.webhook-url{font-size:10px;font-family:monospace;background:#f5f5f5;padding:4px 8px;border-radius:4px;margin-top:8px;word-break:break-all;color:#555}
.tbl{width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.tbl th{background:#f8f8f8;padding:10px 14px;font-size:12px;text-align:left;color:#555;font-weight:500}
.tbl td{padding:9px 14px;font-size:12px;border-top:1px solid #f0f0f0}
.amt{color:#1D9E75;font-weight:600}
@media(max-width:500px){.summary{grid-template-columns:1fr 1fr}}
</style>
</head><body>
<div class="hdr">
  <div><h1>🚗 Dashboard Tủ Điện Rửa Xe</h1><div class="meta" id="upd">Đang tải...</div></div>
  <button onclick="load()">↻ Làm mới</button>
</div>
<div class="wrap">
  <div class="summary">
    <div class="sc"><div class="l">Tổng số tủ</div><div class="v" id="s1">—</div></div>
    <div class="sc"><div class="l">Doanh thu hôm nay</div><div class="v" id="s2">—</div></div>
    <div class="sc"><div class="l">Tổng doanh thu</div><div class="v" id="s3">—</div></div>
  </div>
  <div class="ttl">Danh sách tủ</div>
  <div class="tu-grid" id="grid"></div>
  <div class="ttl">Giao dịch gần đây</div>
  <table class="tbl">
    <thead><tr><th>Thời gian</th><th>Tủ</th><th>Số tiền</th><th>Nội dung CK</th></tr></thead>
    <tbody id="txs"></tbody>
  </table>
</div>
<script>
const P='${pass}';
const BASE=location.origin;
function fmt(n){return Number(n).toLocaleString('vi-VN')+'đ'}
function ago(iso){
  if(!iso)return'—';
  const s=Math.floor((Date.now()-new Date(iso))/1000);
  if(s<60)return s+'s trước';
  if(s<3600)return Math.floor(s/60)+'p trước';
  if(s<86400)return Math.floor(s/3600)+'h trước';
  return new Date(iso).toLocaleDateString('vi-VN');
}
function loc(iso){return iso?new Date(iso).toLocaleString('vi-VN'):'—'}
function online(ls){return ls&&(Date.now()-new Date(ls))<30000}

async function load(){
  const r=await fetch('/api/stats?pass='+P);
  if(r.status===401){document.body.innerHTML='<h3 style="text-align:center;margin-top:60px">❌ Sai mật khẩu</h3>';return}
  const d=await r.json();
  document.getElementById('s1').textContent=d.summary.tuCount;
  document.getElementById('s2').textContent=fmt(d.summary.totalToday);
  document.getElementById('s3').textContent=fmt(d.summary.totalAll);
  document.getElementById('upd').textContent='Cập nhật: '+new Date().toLocaleTimeString('vi-VN');

  // Render tủ
  const g=document.getElementById('grid');
  if(!d.tus.length){g.innerHTML='<div style="color:#aaa;font-size:13px;padding:12px">Chưa có tủ nào. ESP32 tự đăng ký khi online.</div>';}
  else g.innerHTML=d.tus.map(t=>{
    const on=online(t.lastSeen),pend=t.pendingAmount>0;
    const cls=pend?'pend':on?'on':'off';
    const bdg=pend?'<span class="bdg bpend">⏳ Có tiền chờ</span>':on?'<span class="bdg bon">● Online</span>':'<span class="bdg boff">○ Offline</span>';
    const wh=BASE+'/webhook/'+t.id;
    return \`<div class="tc \${cls}">
      <div class="tc-hdr"><span class="tc-name">\${t.name}</span>\${bdg}</div>
      <div class="row"><span class="k">Mã tủ</span><span class="v2">\${t.id}</span></div>
      <div class="row"><span class="k">Tiền đang chờ</span><span class="v2" style="color:#EF9F27">\${fmt(t.pendingAmount)}</span></div>
      <div class="row"><span class="k">Hôm nay</span><span class="v2">\${fmt(t.totalToday)}</span></div>
      <div class="row"><span class="k">Tổng tất cả</span><span class="v2">\${fmt(t.totalAll)}</span></div>
      <div class="row"><span class="k">Kết nối lần cuối</span><span class="v2">\${ago(t.lastSeen)}</span></div>
      <div class="row"><span class="k">GD cuối</span><span class="v2">\${t.lastTx?fmt(t.lastTx.amount)+' – '+ago(t.lastTx.time):'—'}</span></div>
      <div class="webhook-url">🔗 \${wh}</div>
    </div>\`;
  }).join('');

  // Render giao dịch
  const tb=document.getElementById('txs');
  if(!d.transactions.length) tb.innerHTML='<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Chưa có giao dịch</td></tr>';
  else tb.innerHTML=d.transactions.map(tx=>\`<tr>
    <td>\${loc(tx.time)}</td>
    <td><b>\${tx.tuName||tx.tuId}</b></td>
    <td class="amt">+\${fmt(tx.amount)}</td>
    <td style="color:#888;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${tx.content||'—'}</td>
  </tr>\`).join('');
}

load();
setInterval(load,10000);
</script>
</body></html>`);
});

// ── GET /ping ─────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime())+'s', tuCount: Object.keys(db.tus).length });
});

// ── Khởi động ─────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Chạy trên port ${PORT}`);
  console.log(`[SERVER] Dashboard: http://localhost:${PORT}/dashboard`);
});