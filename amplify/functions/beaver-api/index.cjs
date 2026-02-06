const Busboy = require("busboy");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { Readable } = require("node:stream");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { parse: parseCsv } = require("csv-parse/sync");
const { bedrock } = require("@ai-sdk/amazon-bedrock");
const { generateText } = require("ai");
const { classifyImageBuffer } = require("./lib/classify");
const { createJob, updateJob, getJob } = require("./lib/jobsDb");

const MAX_CLASSIFY = 5;
const MAX_FILES = 1000;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function jsonResponse(status, payload) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(payload),
  };
}

function textResponse(status, body, contentType) {
  return {
    statusCode: status,
    headers: { "content-type": contentType, ...corsHeaders },
    body,
  };
}

function getHeader(event, name) {
  const lower = name.toLowerCase();
  const headers = event.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType = getHeader(event, "content-type");
    if (!contentType) {
      reject(new Error("Missing content-type header."));
      return;
    }

    const body = Buffer.from(
      event.body || "",
      event.isBase64Encoded ? "base64" : "utf8",
    );
    const fields = {};
    const files = [];

    const busboy = Busboy({ headers: { "content-type": contentType } });
    busboy.on("file", (name, file, info) => {
      const chunks = [];
      file.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      file.on("end", () => {
        files.push({
          fieldName: name,
          filename: info.filename || "upload.bin",
          mimeType: info.mimeType || "application/octet-stream",
          buffer: Buffer.concat(chunks),
        });
      });
    });
    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("error", reject);
    busboy.on("finish", () => resolve({ fields, files }));

    Readable.from(body).pipe(busboy);
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function parseS3Path(value) {
  if (!value.startsWith("s3://")) {
    throw new Error("Invalid S3 path. Use s3://bucket/prefix");
  }
  const withoutScheme = value.slice("s3://".length);
  const [bucket, ...rest] = withoutScheme.split("/");
  const prefix = rest.join("/");
  if (!bucket) {
    throw new Error("Invalid S3 path. Missing bucket.");
  }
  return { bucket, prefix };
}

function inferS3Region(bucket) {
  const match = bucket.match(/-(us-[a-z]+-\d)$/);
  return match ? match[1] : null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listS3Images(client, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    const contents = response.Contents || [];
    for (const item of contents) {
      if (!item.Key) continue;
      const ext = path.extname(item.Key).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        keys.push(item.Key);
      }
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function runWithConcurrency(tasks, limit, onComplete) {
  const results = [];
  let index = 0;

  const worker = async () => {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      const result = await tasks[current]();
      results.push(result);
      if (onComplete) {
        await onComplete();
      }
    }
  };

  const concurrency = Math.max(1, Math.min(limit, tasks.length));
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

function buildCsv(results) {
  const headers = [
    "filename",
    "is_beaver",
    "confidence",
    "common_name",
    "group",
    "notes",
    "overlay_location",
    "overlay_confidence",
    "overlay_reason",
    "overlay_temperature",
    "exif_timestamp",
  ];
  const lines = [
    headers.join(","),
    ...results.map((row) =>
      headers
        .map((key) => {
          const value = String(row[key] ?? "");
          if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
            return `"${value.replace(/"/g, "\"\"")}"`;
          }
          return value;
        })
        .join(","),
    ),
  ];
  return lines.join("\n");
}

async function processJob(params) {
  const { jobId, files, s3Inputs, modelId, bucket, region, s3Region } = params;
  const jobClient = new S3Client({ region });
  const inputClient = new S3Client({ region: s3Region });

  await updateJob(jobId, { status: "running" });

  const total = files.length + s3Inputs.length;
  let completed = 0;
  const concurrency = Number(process.env.BEAVER_JOB_CONCURRENCY || "3") || 3;

  const tasks = [
    ...files.map((file) => async () => {
      const key = `jobs/${jobId}/input/${file.filename}`;
      await jobClient.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimeType || "application/octet-stream",
        }),
      );
      const output = await classifyImageBuffer(modelId, file.buffer);
      return {
        filename: file.filename,
        ...output,
        s3_key: key,
      };
    }),
    ...s3Inputs.map((item) => async () => {
      const getResult = await inputClient.send(
        new GetObjectCommand({
          Bucket: item.bucket,
          Key: item.key,
        }),
      );
      const body = getResult.Body;
      if (!body) {
        return {
          filename: path.basename(item.key),
          is_beaver: false,
          confidence: 0,
          common_name: "unknown",
          group: "unknown",
          notes: "Missing S3 body",
          s3_key: item.key,
          s3_bucket: item.bucket,
        };
      }
      const buffer = await streamToBuffer(body);
      const output = await classifyImageBuffer(modelId, buffer);
      return {
        filename: path.basename(item.key),
        ...output,
        s3_key: item.key,
        s3_bucket: item.bucket,
      };
    }),
  ];

  const results = await runWithConcurrency(tasks, concurrency, async () => {
    completed += 1;
    if (completed % 10 === 0 || completed === total) {
      await updateJob(jobId, { completed_images: completed });
    }
  });

  const csv = buildCsv(results);
  const csvKey = `jobs/${jobId}/results/results.csv`;
  await jobClient.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: csvKey,
      Body: csv,
      ContentType: "text/csv",
    }),
  );

  await updateJob(jobId, {
    status: "complete",
    completed_images: completed,
    results,
    csv_s3_key: csvKey,
    error: null,
  });
}

async function handleClassify(event) {
  const { fields, files } = await parseMultipart(event);
  const allFiles = files.filter((file) => file.fieldName === "file" || file.fieldName === "files");
  if (allFiles.length === 0) {
    return jsonResponse(400, { error: "No files uploaded." });
  }
  if (allFiles.length > MAX_CLASSIFY) {
    return jsonResponse(400, { error: `Too many files. Max ${MAX_CLASSIFY}.` });
  }

  const modelId =
    fields.modelId ||
    process.env.BEAVER_BEDROCK_MODEL_ID ||
    process.env.BEDROCK_MODEL_ID;

  if (!modelId) {
    return jsonResponse(400, {
      error: "Missing Bedrock model id. Set BEAVER_BEDROCK_MODEL_ID.",
    });
  }

  const results = [];
  for (const file of allFiles) {
    const output = await classifyImageBuffer(modelId, file.buffer);
    results.push({ filename: file.filename, ...output });
  }

  return jsonResponse(200, { results });
}

async function handleJobs(event) {
  const { fields, files } = await parseMultipart(event);
  const uploadFiles = files.filter((file) => file.fieldName === "files");
  const s3Path = String(fields.s3Path || fields.s3_path || "").trim();

  if (uploadFiles.length === 0 && !s3Path) {
    return jsonResponse(400, { error: "No files or S3 path provided." });
  }
  if (uploadFiles.length > MAX_FILES) {
    return jsonResponse(400, { error: `Too many files. Max ${MAX_FILES}.` });
  }

  const jobId = randomUUID();
  const bucket = requireEnv("BEAVER_JOB_BUCKET");
  const region = requireEnv("AWS_REGION");
  let s3Region =
    fields.s3Region || fields.s3_region || process.env.S3_REGION || region;
  const modelId =
    fields.modelId ||
    process.env.BEAVER_BEDROCK_MODEL_ID ||
    process.env.BEDROCK_MODEL_ID;

  if (!modelId) {
    return jsonResponse(400, {
      error: "Missing Bedrock model id. Set BEAVER_BEDROCK_MODEL_ID.",
    });
  }

  let parsedS3;
  let s3Inputs = [];
  if (s3Path) {
    parsedS3 = parseS3Path(s3Path);
    if (!process.env.S3_REGION) {
      const inferred = inferS3Region(parsedS3.bucket);
      if (inferred) {
        s3Region = inferred;
      }
    }
  }

  const s3Client = new S3Client({ region: s3Region });

  if (s3Path) {
    const keys = await listS3Images(s3Client, parsedS3.bucket, parsedS3.prefix);
    if (keys.length === 0) {
      return jsonResponse(400, { error: "No images found for S3 prefix." });
    }
    if (keys.length > MAX_FILES) {
      return jsonResponse(400, { error: `Too many S3 images. Max ${MAX_FILES}.` });
    }
    s3Inputs = keys.map((key) => ({ bucket: parsedS3.bucket, key }));
  }

  await createJob({
    id: jobId,
    source: s3Path ? "s3" : "upload",
    totalImages: uploadFiles.length + s3Inputs.length,
  });

  void processJob({
    jobId,
    files: uploadFiles,
    s3Inputs,
    modelId,
    bucket,
    region,
    s3Region,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[jobs] processing error", error);
    updateJob(jobId, { status: "error", error: message }).catch(() => undefined);
  });

  return jsonResponse(202, {
    job_id: jobId,
    status: "queued",
    total_images: uploadFiles.length + s3Inputs.length,
  });
}

async function handleJobStatus(jobId) {
  const job = await getJob(jobId);
  if (!job) {
    return jsonResponse(404, { error: "Job not found." });
  }
  return jsonResponse(200, {
    job_id: job.id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    total_images: job.total_images,
    completed_images: job.completed_images,
    error: job.error,
    results: job.results || [],
    csv_s3_key: job.csv_s3_key,
  });
}

async function handleJobCsv(jobId) {
  const job = await getJob(jobId);
  if (!job || !job.csv_s3_key) {
    return jsonResponse(404, { error: "CSV not available." });
  }
  const bucket = requireEnv("BEAVER_JOB_BUCKET");
  const region = requireEnv("AWS_REGION");
  const client = new S3Client({ region });
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: job.csv_s3_key,
    }),
  );
  const body = response.Body;
  if (!body) {
    return jsonResponse(404, { error: "CSV missing from S3." });
  }
  const buffer = await streamToBuffer(body);
  return textResponse(200, buffer.toString("utf8"), "text/csv");
}

async function handleChat(event) {
  const payload = JSON.parse(event.body || "{}");
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const csvText = payload.csvText;

  if (!csvText) {
    return jsonResponse(400, { error: "CSV text missing. Upload CSV in chat panel." });
  }

  const modelId =
    payload.modelId ||
    process.env.BEAVER_CHAT_MODEL_ID ||
    process.env.BEAVER_BEDROCK_MODEL_ID ||
    process.env.BEDROCK_MODEL_ID;

  if (!modelId) {
    return jsonResponse(400, { error: "Missing Bedrock model id. Set BEAVER_CHAT_MODEL_ID." });
  }

  const rows = parseCsv(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const stats = buildStats(rows);
  const system = buildSystemPrompt(stats);
  const directPrompt =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "";
  const prompt = directPrompt || getLastUserText(messages);
  if (!prompt) {
    return jsonResponse(400, { error: "No user message provided." });
  }

  const result = await generateText({
    model: bedrock(modelId),
    system,
    prompt,
  });

  return jsonResponse(200, { text: result.text ?? "" });
}

function buildStats(rows) {
  const animalCounts = {};
  let totalAnimals = 0;
  let totalBeavers = 0;
  let totalImages = rows.length;

  for (const row of rows) {
    const animalType = String(row.animal_type || "").toLowerCase().trim();
    const hasBeaver = String(row.has_beaver || "").toLowerCase() === "true";
    const hasAnimal = String(row.has_animal || "").toLowerCase() === "true";

    if (hasBeaver) totalBeavers += 1;

    if (animalType && animalType !== "none") {
      animalCounts[animalType] = (animalCounts[animalType] || 0) + 1;
      totalAnimals += 1;
    } else if (hasAnimal) {
      totalAnimals += 1;
    }
  }

  const sortedAnimals = Object.entries(animalCounts).sort((a, b) => b[1] - a[1]);
  return {
    totalImages,
    totalAnimals,
    totalBeavers,
    animalCounts,
    sortedAnimals,
  };
}

function buildSystemPrompt(stats) {
  const summaryLines = stats.sortedAnimals.map(([animal, count]) => `- ${animal}: ${count}`);
  const summaryText =
    summaryLines.length > 0 ? summaryLines.join("\n") : "- no animals detected";

  return [
    "You are a wildlife dataset assistant.",
    "Answer ONLY using the dataset summary below. If a question cannot be answered, say so.",
    `Total images: ${stats.totalImages}`,
    `Total animals (any type): ${stats.totalAnimals}`,
    `Beaver detections: ${stats.totalBeavers}`,
    "Animal counts:",
    summaryText,
  ].join("\n");
}

function getLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    if (typeof message.text === "string" && message.text.trim()) {
      return message.text.trim();
    }
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts
      .filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

exports.handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS" || event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const rawPath = event.rawPath || event.path || "/";
  const normalizedPath = rawPath.startsWith("/api") ? rawPath : `/api${rawPath}`;

  try {
    if (method === "POST" && normalizedPath === "/api/classify") {
      return await handleClassify(event);
    }
    if (method === "POST" && normalizedPath === "/api/jobs") {
      return await handleJobs(event);
    }
    if (method === "GET" && normalizedPath.startsWith("/api/jobs/")) {
      const parts = normalizedPath.split("/").filter(Boolean);
      if (parts.length === 3) {
        return await handleJobStatus(parts[2]);
      }
      if (parts.length === 4 && parts[3] === "csv") {
        return await handleJobCsv(parts[2]);
      }
    }
    if (method === "POST" && normalizedPath === "/api/chat") {
      return await handleChat(event);
    }
    return jsonResponse(404, { error: "Not found." });
  } catch (error) {
    console.error("Function error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse(500, { error: message });
  }
};
