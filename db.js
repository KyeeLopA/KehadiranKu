const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

let pool = null;

function getPool() {
  if (!connectionString) {
    throw new Error('DATABASE_URL belum diisi. Hubungkan database Neon di menu Storage Vercel.');
  }
  if (!pool) {
    pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10000 });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function one(text, params) {
  const result = await getPool().query(text, params);
  return result.rows[0] || null;
}

async function many(text, params) {
  const result = await getPool().query(text, params);
  return result.rows;
}

async function transaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function setup() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(727001)');
    await client.query(schema);
    await client.query("INSERT INTO pengaturan (kunci, nilai) VALUES ('batas_masuk', '07:15') ON CONFLICT (kunci) DO NOTHING");
  });
}

module.exports = { query, one, many, transaction, setup };
