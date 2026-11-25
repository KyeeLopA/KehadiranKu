CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'siswa')),
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS satu_admin_saja ON users (role) WHERE role = 'admin';

CREATE TABLE IF NOT EXISTS siswa (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  nama TEXT NOT NULL,
  nis TEXT NOT NULL UNIQUE,
  kelas TEXT NOT NULL,
  descriptors TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS absensi (
  id SERIAL PRIMARY KEY,
  siswa_id INTEGER NOT NULL REFERENCES siswa (id) ON DELETE CASCADE,
  tanggal TEXT NOT NULL,
  jam TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Hadir', 'Terlambat')),
  UNIQUE (siswa_id, tanggal)
);

CREATE INDEX IF NOT EXISTS absensi_tanggal ON absensi (tanggal);

CREATE TABLE IF NOT EXISTS pengaturan (
  kunci TEXT PRIMARY KEY,
  nilai TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_gagal (
  username TEXT PRIMARY KEY,
  jumlah INTEGER NOT NULL,
  terakhir TIMESTAMPTZ NOT NULL
);
