const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

const connectionStringRaw =
  process.env.BEAVER_DB_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  "";

if (!connectionStringRaw) {
  console.warn("Missing BEAVER_DB_URL/DATABASE_URL/POSTGRES_URL for job storage.");
}

const sslFlag =
  process.env.BEAVER_DB_SSL === "1" || process.env.BEAVER_DB_SSL === "true";
const inferredSsl =
  connectionStringRaw.includes("sslmode=require") ||
  connectionStringRaw.includes("ssl=true") ||
  connectionStringRaw.includes("amazonaws.com");
const useSsl = sslFlag || inferredSsl;
const insecureSsl =
  process.env.BEAVER_DB_SSL_INSECURE === "1" ||
  process.env.BEAVER_DB_SSL_INSECURE === "true";

let sslConfig;
if (useSsl) {
  const caPathFromEnv = process.env.BEAVER_DB_CA_PATH;
  const fallbackPath = path.resolve(process.cwd(), "certs", "rds-ca.pem");
  const caPath = caPathFromEnv || fallbackPath;
  if (!insecureSsl && caPath && fs.existsSync(caPath)) {
    try {
      const ca = fs.readFileSync(caPath, "utf8");
      sslConfig = { rejectUnauthorized: true, ca };
    } catch (error) {
      console.warn("Failed to read BEAVER_DB_CA_PATH:", error);
      sslConfig = { rejectUnauthorized: false };
    }
  } else {
    sslConfig = { rejectUnauthorized: false };
  }
}

let connectionString = connectionStringRaw;
if (sslConfig && connectionStringRaw) {
  try {
    const url = new URL(connectionStringRaw);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("ssl");
    url.searchParams.delete("sslrootcert");
    url.searchParams.delete("sslcert");
    url.searchParams.delete("sslkey");
    connectionString = url.toString();
  } catch (error) {
    console.warn("Failed to normalize DB URL:", error);
  }
}

const pool = connectionString
  ? new Pool({
      connectionString,
      ...(sslConfig ? { ssl: sslConfig } : {}),
    })
  : null;

let ensurePromise = null;

async function ensureTable() {
  if (!pool) return;
  if (!ensurePromise) {
    ensurePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS beaver_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source TEXT NOT NULL,
        total_images INT NOT NULL,
        completed_images INT NOT NULL DEFAULT 0,
        error TEXT,
        results JSONB,
        csv_s3_key TEXT
      );
    `).then(() => undefined);
  }
  await ensurePromise;
}

async function requireDb() {
  if (!pool) {
    throw new Error("Job DB not configured. Set BEAVER_DB_URL or DATABASE_URL.");
  }
  await ensureTable();
  return pool;
}

async function createJob(params) {
  const db = await requireDb();
  await db.query(
    `
    INSERT INTO beaver_jobs (id, status, source, total_images, completed_images)
    VALUES ($1, $2, $3, $4, $5);
  `,
    [params.id, "queued", params.source, params.totalImages, 0],
  );
}

async function updateJob(id, fields) {
  const db = await requireDb();
  const entries = Object.entries(fields).map(([key, value]) => {
    if (key === "results" && value !== null && value !== undefined) {
      try {
        const payload = JSON.stringify(value);
        return [key, payload];
      } catch (error) {
        console.warn("Failed to serialize results JSON:", error);
        return [key, "[]"];
      }
    }
    return [key, value];
  });
  if (entries.length === 0) return;

  const setClauses = entries.map(([key], idx) => `${key} = $${idx + 2}`);
  setClauses.push(`updated_at = now()`);
  const values = entries.map(([, value]) => value);

  await db.query(
    `
    UPDATE beaver_jobs
    SET ${setClauses.join(", ")}
    WHERE id = $1;
  `,
    [id, ...values],
  );
}

async function getJob(id) {
  const db = await requireDb();
  const result = await db.query(`SELECT * FROM beaver_jobs WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

module.exports = {
  createJob,
  getJob,
  updateJob,
};
