const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../lib/db');

const JWT_SECRET = process.env.JWT_SECRET || '';
const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Makassar';
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'kehadiranku_token';
const SESSION_HOURS = 8;
const MATCH_THRESHOLD = 0.5;
const DUPLICATE_THRESHOLD = 0.4;
const BCRYPT_COST = 12;
const MAX_GAGAL = 10;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

let readyPromise = null;
let dummyHashPromise = null;

const dummyHash = () => {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash('kata-sandi-palsu', BCRYPT_COST);
  return dummyHashPromise;
};

async function seedAdmin() {
  const exists = await db.one("SELECT id FROM users WHERE role = 'admin'");
  if (exists) return;
  const username = (process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || password.length < 8) {
    throw new Error('Akun admin belum ada. Isi ADMIN_USERNAME dan ADMIN_PASSWORD (minimal 8 karakter).');
  }
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  await db.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING", [username, hash]);
}

function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (JWT_SECRET.length < 32) {
        throw new Error('JWT_SECRET wajib diisi dengan teks acak minimal 32 karakter.');
      }
      await db.setup();
      await seedAdmin();
    })().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

function nowParts() {
  const text = new Date().toLocaleString('sv-SE', { timeZone: TIMEZONE, hour12: false });
  return { tanggal: text.slice(0, 10), jam: text.slice(11, 16) };
}

async function getBatas() {
  const row = await db.one("SELECT nilai FROM pengaturan WHERE kunci = 'batas_masuk'");
  return row ? row.nilai : '07:15';
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function isDescriptor(value) {
  return Array.isArray(value) && value.length === 128 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id < 2147483647 ? id : null;
}

async function profile(user) {
  const data = {
    id: user.id,
    username: user.username,
    role: user.role,
    wajibGanti: Boolean(user.must_change_password),
    tanggal: nowParts().tanggal,
    batas: await getBatas()
  };
  if (user.role === 'siswa') {
    data.siswa = await db.one('SELECT id, nama, nis, kelas FROM siswa WHERE user_id = $1', [user.id]);
  }
  return data;
}

function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: SESSION_HOURS * 60 * 60 * 1000
  });
}

const authenticate = wrap(async (req, res, next) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ pesan: 'Silakan masuk terlebih dahulu.' });
    return;
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    res.status(401).json({ pesan: 'Sesi berakhir. Silakan masuk lagi.' });
    return;
  }
  const user = await db.one('SELECT id, username, role, must_change_password FROM users WHERE id = $1', [payload.sub]);
  if (!user) {
    res.status(401).json({ pesan: 'Akun tidak ditemukan.' });
    return;
  }
  req.user = user;
  next();
});

function passwordReady(req, res, next) {
  if (req.user.must_change_password) {
    res.status(403).json({ pesan: 'Ganti kata sandi awal terlebih dahulu.', wajibGanti: true });
    return;
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      res.status(403).json({ pesan: 'Akses ditolak.' });
      return;
    }
    next();
  };
}

const guard = (role) => [authenticate, passwordReady, requireRole(role)];

async function isLocked(username) {
  const row = await db.one(
    "SELECT jumlah FROM login_gagal WHERE username = $1 AND terakhir > now() - interval '15 minutes'",
    [username]
  );
  return Boolean(row && row.jumlah >= MAX_GAGAL);
}

async function recordFailure(username) {
  await db.query(
    `INSERT INTO login_gagal (username, jumlah, terakhir) VALUES ($1, 1, now())
     ON CONFLICT (username) DO UPDATE SET
       jumlah = CASE WHEN login_gagal.terakhir > now() - interval '15 minutes' THEN login_gagal.jumlah + 1 ELSE 1 END,
       terakhir = now()`,
    [username]
  );
}

async function clearFailures(username) {
  await db.query('DELETE FROM login_gagal WHERE username = $1', [username]);
}

const makeLimiter = (windowMs, limit, pesan) =>
  rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { pesan } });

const loginLimiter = makeLimiter(15 * 60 * 1000, 30, 'Terlalu banyak percobaan masuk. Coba lagi nanti.');
const scanLimiter = makeLimiter(60 * 1000, 20, 'Terlalu banyak percobaan pindai. Tunggu sebentar.');
const apiLimiter = makeLimiter(15 * 60 * 1000, 600, 'Terlalu banyak permintaan. Coba lagi nanti.');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', apiLimiter);
app.use(
  '/api',
  wrap(async (req, res, next) => {
    await ensureReady();
    next();
  })
);

app.post(
  '/api/login',
  loginLimiter,
  wrap(async (req, res) => {
    const username = cleanText(req.body && req.body.username, 60);
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
    if (!username || !password) {
      res.status(400).json({ pesan: 'Isi username dan kata sandi.' });
      return;
    }
    if (await isLocked(username)) {
      res.status(429).json({ pesan: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.' });
      return;
    }
    const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);
    const valid = await bcrypt.compare(password, user ? user.password_hash : await dummyHash());
    if (!user || !valid) {
      await recordFailure(username);
      res.status(401).json({ pesan: 'Username atau kata sandi salah.' });
      return;
    }
    await clearFailures(username);
    issueSession(res, user);
    res.json(await profile(user));
  })
);

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: IS_PROD });
  res.json({ ok: true });
});

app.get(
  '/api/me',
  authenticate,
  wrap(async (req, res) => {
    res.json(await profile(req.user));
  })
);

app.post(
  '/api/ganti-password',
  authenticate,
  wrap(async (req, res) => {
    const lama = typeof (req.body && req.body.lama) === 'string' ? req.body.lama : '';
    const baru = typeof (req.body && req.body.baru) === 'string' ? req.body.baru : '';
    if (baru.length < 8 || baru.length > 72) {
      res.status(400).json({ pesan: 'Kata sandi baru harus 8 sampai 72 karakter.' });
      return;
    }
    const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(lama, row.password_hash);
    if (!valid) {
      res.status(400).json({ pesan: 'Kata sandi lama salah.' });
      return;
    }
    if (lama === baru) {
      res.status(400).json({ pesan: 'Kata sandi baru harus berbeda dari yang lama.' });
      return;
    }
    const hash = await bcrypt.hash(baru, BCRYPT_COST);
    await db.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/siswa',
  guard('admin'),
  wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT s.id, s.nama, s.nis, s.kelas, u.username
       FROM siswa s JOIN users u ON u.id = s.user_id
       ORDER BY lower(s.kelas), lower(s.nama)`
    );
    res.json({ siswa: rows });
  })
);

app.post(
  '/api/admin/siswa',
  guard('admin'),
  wrap(async (req, res) => {
    const body = req.body || {};
    const nama = cleanText(body.nama, 60);
    const nis = cleanText(body.nis, 20);
    const kelas = cleanText(body.kelas, 20);
    const descriptors = body.descriptors;
    if (!nama || !kelas) {
      res.status(400).json({ pesan: 'Nama dan kelas wajib diisi.' });
      return;
    }
    if (!/^[A-Za-z0-9]{3,20}$/.test(nis)) {
      res.status(400).json({ pesan: 'NIS harus 3 sampai 20 huruf atau angka tanpa spasi.' });
      return;
    }
    if (!Array.isArray(descriptors) || descriptors.length < 3 || descriptors.length > 10 || !descriptors.every(isDescriptor)) {
      res.status(400).json({ pesan: 'Data wajah tidak valid. Rekam ulang wajah siswa.' });
      return;
    }
    if (await db.one('SELECT id FROM users WHERE username = $1', [nis])) {
      res.status(409).json({ pesan: 'NIS ini sudah dipakai oleh akun lain.' });
      return;
    }
    const others = await db.many('SELECT nama, descriptors FROM siswa');
    for (const other of others) {
      const stored = JSON.parse(other.descriptors);
      const closest = Math.min(...stored.map((d) => distance(d, descriptors[0])));
      if (closest < DUPLICATE_THRESHOLD) {
        res.status(409).json({ pesan: `Wajah ini sudah terdaftar atas nama ${other.nama}.` });
        return;
      }
    }
    const passwordAwal = randomPassword();
    const hash = await bcrypt.hash(passwordAwal, BCRYPT_COST);
    try {
      const id = await db.transaction(async (client) => {
        const user = await client.query(
          "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1, $2, 'siswa', TRUE) RETURNING id",
          [nis, hash]
        );
        const siswa = await client.query(
          'INSERT INTO siswa (user_id, nama, nis, kelas, descriptors) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [user.rows[0].id, nama, nis, kelas, JSON.stringify(descriptors)]
        );
        return siswa.rows[0].id;
      });
      res.status(201).json({ id, nama, nis, kelas, username: nis, passwordAwal });
    } catch (error) {
      if (error.code === '23505') {
        res.status(409).json({ pesan: 'NIS ini sudah dipakai oleh akun lain.' });
        return;
      }
      throw error;
    }
  })
);

app.post(
  '/api/admin/siswa/:id/reset-password',
  guard('admin'),
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const siswa = id
      ? await db.one('SELECT s.nama, s.user_id, u.username FROM siswa s JOIN users u ON u.id = s.user_id WHERE s.id = $1', [id])
      : null;
    if (!siswa) {
      res.status(404).json({ pesan: 'Siswa tidak ditemukan.' });
      return;
    }
    const passwordBaru = randomPassword();
    const hash = await bcrypt.hash(passwordBaru, BCRYPT_COST);
    await db.query('UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2', [hash, siswa.user_id]);
    res.json({ nama: siswa.nama, username: siswa.username, passwordBaru });
  })
);

app.delete(
  '/api/admin/siswa/:id',
  guard('admin'),
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const siswa = id ? await db.one('SELECT user_id FROM siswa WHERE id = $1', [id]) : null;
    if (!siswa) {
      res.status(404).json({ pesan: 'Siswa tidak ditemukan.' });
      return;
    }
    await db.query('DELETE FROM users WHERE id = $1', [siswa.user_id]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/rekap',
  guard('admin'),
  wrap(async (req, res) => {
    const tanggal =
      typeof req.query.tanggal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.tanggal) ? req.query.tanggal : nowParts().tanggal;
    const kelas = typeof req.query.kelas === 'string' ? req.query.kelas.slice(0, 20) : '';
    const data = await db.many(
      `SELECT s.id, s.nama, s.nis, s.kelas, a.jam, a.status
       FROM siswa s
       LEFT JOIN absensi a ON a.siswa_id = s.id AND a.tanggal = $1
       WHERE ($2::text = '' OR s.kelas = $2::text)
       ORDER BY lower(s.kelas), lower(s.nama)`,
      [tanggal, kelas]
    );
    const rows = data.map((row) => ({
      id: row.id,
      nama: row.nama,
      nis: row.nis,
      kelas: row.kelas,
      jam: row.jam || '',
      status: row.status || 'Belum hadir'
    }));
    res.json({ tanggal, rows });
  })
);

app.get(
  '/api/admin/pengaturan',
  guard('admin'),
  wrap(async (req, res) => {
    res.json({ batas: await getBatas() });
  })
);

app.put(
  '/api/admin/pengaturan',
  guard('admin'),
  wrap(async (req, res) => {
    const batas = req.body && req.body.batas;
    if (typeof batas !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(batas)) {
      res.status(400).json({ pesan: 'Format jam tidak valid.' });
      return;
    }
    await db.query("UPDATE pengaturan SET nilai = $1 WHERE kunci = 'batas_masuk'", [batas]);
    res.json({ batas });
  })
);

app.post(
  '/api/absen',
  scanLimiter,
  ...guard('siswa'),
  wrap(async (req, res) => {
    const siswa = await db.one('SELECT id, nama, kelas, descriptors FROM siswa WHERE user_id = $1', [req.user.id]);
    if (!siswa) {
      res.status(404).json({ pesan: 'Data siswa untuk akun ini tidak ditemukan.' });
      return;
    }
    const descriptor = req.body && req.body.descriptor;
    if (!isDescriptor(descriptor)) {
      res.status(400).json({ pesan: 'Data wajah tidak valid.' });
      return;
    }
    const stored = JSON.parse(siswa.descriptors);
    const closest = Math.min(...stored.map((d) => distance(d, descriptor)));
    if (closest >= MATCH_THRESHOLD) {
      res.status(422).json({ pesan: 'Wajah tidak cocok dengan akun ini. Hadap lurus ke kamera dan coba lagi.' });
      return;
    }
    const { tanggal, jam } = nowParts();
    const findExisting = () => db.one('SELECT jam, status FROM absensi WHERE siswa_id = $1 AND tanggal = $2', [siswa.id, tanggal]);
    const existing = await findExisting();
    if (existing) {
      res.json({ sudahAbsen: true, jam: existing.jam, status: existing.status });
      return;
    }
    const status = jam > (await getBatas()) ? 'Terlambat' : 'Hadir';
    const inserted = await db.query(
      'INSERT INTO absensi (siswa_id, tanggal, jam, status) VALUES ($1, $2, $3, $4) ON CONFLICT (siswa_id, tanggal) DO NOTHING',
      [siswa.id, tanggal, jam, status]
    );
    if (inserted.rowCount === 0) {
      const again = await findExisting();
      res.json({ sudahAbsen: true, jam: again.jam, status: again.status });
      return;
    }
    res.status(201).json({ sudahAbsen: false, jam, status });
  })
);

app.get(
  '/api/riwayat',
  ...guard('siswa'),
  wrap(async (req, res) => {
    const siswa = await db.one('SELECT id FROM siswa WHERE user_id = $1', [req.user.id]);
    if (!siswa) {
      res.json({ tanggal: nowParts().tanggal, riwayat: [] });
      return;
    }
    const riwayat = await db.many('SELECT tanggal, jam, status FROM absensi WHERE siswa_id = $1 ORDER BY tanggal DESC LIMIT 60', [siswa.id]);
    res.json({ tanggal: nowParts().tanggal, riwayat });
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ pesan: 'Alamat tidak ditemukan.' });
});

app.use((error, req, res, next) => {
  if (error && error.type === 'entity.parse.failed') {
    res.status(400).json({ pesan: 'Format data tidak valid.' });
    return;
  }
  console.error(error);
  res.status(500).json({ pesan: 'Terjadi kesalahan di server.' });
});

module.exports = app;
