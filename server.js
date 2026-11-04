// Đặt xe thực hành — server nhỏ không cần thư viện ngoài (Node >= 18)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Administrator@123';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Thông tin Google Form (lấy từ https://forms.gle/39eNxssuuKkaKefv7)
const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScQ3nMH5RqsGl6tiGjSbQboaTapa5XGBnmqmb_9VAUvDR1eUA/formResponse';
const ENTRY = {
  date: 'entry.1241184338',
  teacher: 'entry.866538313',
  hang: 'entry.1113243409',
  xe: 'entry.382628882',
  time: 'entry.1359075680',
  student: 'entry.1536534655',
};

const HANG = ['B.01', 'B', 'C1'];
const XE = ['XE 1', 'XE 2', 'XE 3', 'XE 4', 'XE 5'];
// Mỗi xe có 2 khung giờ; "CẢ 2 GIỜ" chiếm cả hai
const TIMES = { '6H -7H': ['6-7'], '7H -8H': ['7-8'], 'CẢ 2 GIỜ': ['6-7', '7-8'] };

// ---------- Lưu trữ ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { date: null, bookings: [] }; }
}
let db = load();
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

const tokens = new Set();

// ---------- Tiện ích ----------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function isAdmin(req) {
  const auth = req.headers.authorization || '';
  return tokens.has(auth.replace('Bearer ', ''));
}
function bookingsFor(date) {
  return db.bookings.filter((b) => b.date === date);
}
function takenSlots(date, hang, xe) {
  return bookingsFor(date)
    .filter((b) => b.hang === hang && b.xe === xe)
    .flatMap((b) => TIMES[b.time]);
}
function publicState() {
  // Khách chỉ thấy khung giờ nào đã có người đặt, không thấy tên
  const taken = {};
  for (const b of bookingsFor(db.date)) {
    const key = `${b.hang}|${b.xe}`;
    taken[key] = [...(taken[key] || []), ...TIMES[b.time]];
  }
  return { date: db.date, hang: HANG, xe: XE, times: Object.keys(TIMES), taken };
}

async function submitToGoogle(b) {
  const [y, m, d] = b.date.split('-');
  const params = new URLSearchParams({
    [`${ENTRY.date}_year`]: y,
    [`${ENTRY.date}_month`]: String(+m),
    [`${ENTRY.date}_day`]: String(+d),
    [ENTRY.teacher]: b.teacher,
    [ENTRY.hang]: b.hang,
    [ENTRY.xe]: b.xe,
    [ENTRY.time]: b.time,
    [ENTRY.student]: b.student,
    fvv: '1',
    pageHistory: '0',
  });
  const r = await fetch(FORM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`Google Form trả về mã ${r.status}`);
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/state' && req.method === 'GET') return send(res, 200, publicState());

  if (p === '/api/admin/login' && req.method === 'POST') {
    const { password } = await readBody(req);
    if (password !== ADMIN_PASSWORD) return send(res, 401, { error: 'Mật khẩu không đúng' });
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    return send(res, 200, { token });
  }

  if (p === '/api/admin/date' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Chưa đăng nhập admin' });
    const { date } = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return send(res, 400, { error: 'Ngày không hợp lệ' });
    db.date = date;
    save();
    return send(res, 200, publicState());
  }

  if (p === '/api/admin/bookings' && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Chưa đăng nhập admin' });
    return send(res, 200, { bookings: bookingsFor(db.date) });
  }

  if (p.startsWith('/api/admin/bookings/') && req.method === 'DELETE') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Chưa đăng nhập admin' });
    const id = decodeURIComponent(p.split('/').pop());
    db.bookings = db.bookings.filter((b) => b.id !== id);
    save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/submit' && req.method === 'POST') {
    const body = await readBody(req);
    const b = {
      teacher: String(body.teacher || '').trim(),
      hang: body.hang,
      xe: body.xe,
      time: body.time,
      student: String(body.student || '').trim(),
    };
    if (!db.date) return send(res, 400, { error: 'Admin chưa chọn ngày đăng kí, chưa thể đặt xe' });
    if (!b.teacher || !b.student) return send(res, 400, { error: 'Vui lòng nhập tên thầy và tên học viên' });
    if (!HANG.includes(b.hang)) return send(res, 400, { error: 'Hạng xe không hợp lệ' });
    if (!XE.includes(b.xe)) return send(res, 400, { error: 'Xe không hợp lệ' });
    if (!TIMES[b.time]) return send(res, 400, { error: 'Thời gian không hợp lệ' });

    // Kiểm tra và giữ chỗ đồng bộ để hai người không đặt trùng cùng lúc
    const taken = takenSlots(db.date, b.hang, b.xe);
    if (TIMES[b.time].some((s) => taken.includes(s))) {
      return send(res, 409, { error: `${b.xe} hạng ${b.hang} đã có người đặt khung giờ này`, state: publicState() });
    }
    const booking = { id: crypto.randomUUID(), date: db.date, ...b, createdAt: new Date().toISOString() };
    db.bookings.push(booking);
    save();

    try {
      await submitToGoogle(booking);
    } catch (e) {
      db.bookings = db.bookings.filter((x) => x.id !== booking.id);
      save();
      return send(res, 502, { error: 'Không gửi được lên Google Form: ' + e.message });
    }
    return send(res, 200, { ok: true, booking, state: publicState() });
  }

  send(res, 404, { error: 'Không tìm thấy' });
}

// ---------- Static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
function serveStatic(req, res, url) {
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Lỗi máy chủ' });
  }
}).listen(PORT, () => console.log(`Đặt xe thực hành đang chạy tại http://localhost:${PORT}`));
