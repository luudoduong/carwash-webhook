/**
 * ============================================================
 *  WEBHOOK SERVER – Nhận thẳng từ SePay (không qua Telegram)
 *  Deploy lên Render.com (free tier)
 * ============================================================
 */

const express = require('express');
const app     = express();
app.use(express.json());

// ── Cấu hình bảo mật ──────────────────────────────────────
// Đặt API Key tùy ý, phải khớp với SePay dashboard
const SEPAY_API_KEY = process.env.SEPAY_API_KEY || 'my_secret_api_key_123';

// ── Lưu giao dịch chờ ESP32 lấy ──────────────────────────
let pendingAmount  = 0;
let lastTxId       = null;
let processedIds   = new Set();
let lastTxInfo     = {};

// ── Nhận webhook từ SePay ─────────────────────────────────
app.post('/webhook/sepay', (req, res) => {

  // 1. Xác thực API Key
  const authHeader = req.headers['authorization'] || '';
  const sentKey    = authHeader.replace('Apikey ', '').trim();

  if (sentKey !== SEPAY_API_KEY) {
    console.warn('[SECURITY] Sai API Key:', sentKey);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const data = req.body;
  console.log('[SEPAY] Nhận webhook:', JSON.stringify(data));

  // 2. Chỉ xử lý giao dịch tiền VÀO
  if (data.transferType !== 'in') {
    return res.json({ success: true, message: 'Ignored' });
  }

  // 3. Chống trùng giao dịch
  const txId = String(data.id);
  if (processedIds.has(txId)) {
    console.log('[SEPAY] Bỏ qua – giao dịch đã xử lý:', txId);
    return res.json({ success: true, message: 'Already processed' });
  }

  // 4. Lấy số tiền
  const amount = Number(data.transferAmount) || 0;
  if (amount <= 0) {
    return res.json({ success: true, message: 'Invalid amount' });
  }

  // 5. Cộng dồn vào hàng chờ
  processedIds.add(txId);
  if (processedIds.size > 1000) {
    const first = processedIds.values().next().value;
    processedIds.delete(first);
  }

  pendingAmount += amount;
  lastTxId       = txId;
  lastTxInfo     = {
    id        : txId,
    amount    : amount,
    gateway   : data.gateway,
    content   : data.content,
    date      : data.transactionDate,
    reference : data.referenceCode,
  };

  console.log(`[SEPAY] +${amount} VNĐ (ID: ${txId}) | Pending: ${pendingAmount} VNĐ`);

  // 6. Trả 200 OK để SePay không retry
  res.json({ success: true, message: 'OK' });
});

// ── ESP32 gọi endpoint này mỗi 3 giây ────────────────────
app.get('/amount', (req, res) => {
  const amt     = pendingAmount;
  pendingAmount = 0;
  console.log(`[ESP32] Lấy: ${amt} VNĐ`);
  res.json({ amount: amt, lastTx: lastTxInfo });
});

// ── Health check (UptimeRobot ping) ──────────────────────
app.get('/ping', (req, res) => {
  res.json({
    ok      : true,
    pending : pendingAmount,
    lastTxId: lastTxId,
    uptime  : Math.floor(process.uptime()) + 's',
  });
});

// ── Khởi động server ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Đang chạy trên port ${PORT}`);
});
