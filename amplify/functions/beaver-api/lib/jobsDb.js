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
    ensurePromise = (async () => {
      await pool.query(`
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
          csv_s3_key TEXT,
          total_chunks INT NOT NULL DEFAULT 1,
          completed_chunks INT NOT NULL DEFAULT 0,
          finalized BOOLEAN NOT NULL DEFAULT false
        );
      `);
      await pool.query(`
        ALTER TABLE beaver_jobs
        ADD COLUMN IF NOT EXISTS total_chunks INT NOT NULL DEFAULT 1;
      `);
      await pool.query(`
        ALTER TABLE beaver_jobs
        ADD COLUMN IF NOT EXISTS completed_chunks INT NOT NULL DEFAULT 0;
      `);
      await pool.query(`
        ALTER TABLE beaver_jobs
        ADD COLUMN IF NOT EXISTS finalized BOOLEAN NOT NULL DEFAULT false;
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS beaver_job_chunks (
          job_id TEXT NOT NULL,
          chunk_index INT NOT NULL,
          processed_images INT NOT NULL,
          chunk_s3_key TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (job_id, chunk_index)
        );
      `);
    })().then(() => undefined);
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
    INSERT INTO beaver_jobs (
      id,
      status,
      source,
      total_images,
      completed_images,
      total_chunks,
      completed_chunks,
      finalized
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
  `,
    [
      params.id,
      "queued",
      params.source,
      params.totalImages,
      0,
      Math.max(1, Number(params.totalChunks || 1)),
      0,
      false,
    ],
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

async function markChunkComplete(params) {
  const db = await requireDb();
  const chunkIndex = Number(params.chunkIndex || 0);
  const processedImages = Math.max(0, Number(params.processedImages || 0));
  const chunkS3Key = String(params.chunkS3Key || "").trim();
  if (!chunkS3Key) {
    throw new Error("Missing chunkS3Key.");
  }

  const insert = await db.query(
    `
    INSERT INTO beaver_job_chunks (job_id, chunk_index, processed_images, chunk_s3_key)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (job_id, chunk_index) DO NOTHING
    RETURNING job_id;
  `,
    [params.jobId, chunkIndex, processedImages, chunkS3Key],
  );
  if (insert.rowCount === 0) {
    const current = await getJob(params.jobId);
    return { applied: false, job: current };
  }

  const updated = await db.query(
    `
    UPDATE beaver_jobs
    SET
      status = 'running',
      completed_images = LEAST(total_images, completed_images + $2),
      completed_chunks = completed_chunks + 1,
      updated_at = now()
    WHERE id = $1
    RETURNING *;
  `,
    [params.jobId, processedImages],
  );
  return { applied: true, job: updated.rows[0] || null };
}

async function claimFinalize(jobId) {
  const db = await requireDb();
  const result = await db.query(
    `
    UPDATE beaver_jobs
    SET finalized = true, updated_at = now()
    WHERE id = $1 AND finalized = false
    RETURNING *;
  `,
    [jobId],
  );
  return result.rows[0] || null;
}

module.exports = {
  claimFinalize,
  createJob,
  getJob,
  markChunkComplete,
  updateJob,
};
