const Busboy = require("busboy");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { Readable } = require("node:stream");
const { webcrypto } = require("node:crypto");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
} = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { parse: parseCsv } = require("csv-parse/sync");
const { createAmazonBedrock } = require("@ai-sdk/amazon-bedrock");
const { generateText } = require("ai");
const {
  classifyImageBuffer,
  classifySequenceBuffers,
  extractExifTimestamp,
  getSharpAvailability,
} = require("./lib/classify");
const { createJob, updateJob, getJob } = require("./lib/jobsDb");

const bedrock = createAmazonBedrock({
  region:
    process.env.BEAVER_BEDROCK_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-2",
});

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const MAX_CLASSIFY = 5;
// Guardrail for a single batch job (S3 prefix). Higher values increase runtime/cost.
const MAX_FILES = 2000;
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

function parseJsonBody(event) {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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

function isOversizeNoSharpError(error) {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("sharp is unavailable") && message.includes("5MB");
}

function isBedrockOversizeError(error) {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("exceeds 5 MB maximum");
}

function buildErrorResult(filename, message, extra = {}) {
  return {
    filename,
    image_path: filename,
    // Animal agent fields (Prompt 2, plus legacy fields used by the UI).
    common_name: "unknown",
    group: "unknown",
    notes: message,
    confidence: 0,
    has_animal: "",
    animal_type: "",
    animal_common_name: "",
    animal_confidence: "",
    animal_group: "",
    animal_reason: "",
    animal_notes: "",
    // Beaver agent fields (Prompt 1).
    is_beaver: false,
    has_beaver: false,
    beaver_confidence: 0,
    beaver_reason: message,
    reason: message,
    error: message,
    ...extra,
  };
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

async function resolveS3Region(bucket, fallbackRegion) {
  const envRegion = process.env.S3_REGION;
  if (envRegion) {
    return envRegion;
  }
  const inferred = inferS3Region(bucket);
  if (inferred) {
    return inferred;
  }

  const region = fallbackRegion || "us-east-2";
  const probeClient = new S3Client({ region });
  try {
    await probeClient.send(new HeadBucketCommand({ Bucket: bucket }));
    return region;
  } catch (error) {
    const headerRegion =
      error?.$metadata?.httpHeaders?.["x-amz-bucket-region"] ||
      error?.$response?.headers?.["x-amz-bucket-region"];
    if (headerRegion) {
      return headerRegion;
    }
    throw error;
  }
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
  // CSV schema aligned with the UI exporter + sequence aggregator.
  const headers = [
    "image_path",
    "has_beaver",
    "confidence",
    "reason",
    "bbox",
    "has_animal",
    "animal_type",
    "manual_review",
    "animal_group",
    "animal_confidence",
    "animal_reason",
    "overlay_location",
    "overlay_confidence",
    "overlay_reason",
    "overlay_temperature",
    "model_id",
    "exif_timestamp",
    "exif_location",
    "error",
    // Keep a few legacy columns at the end for debugging/back-compat.
    "filename",
    "is_beaver",
    "beaver_confidence",
    "beaver_reason",
    "common_name",
    "group",
    "notes",
  ];

  const rows = results.map((row) => {
    const imagePath = String(row.image_path ?? row.filename ?? "");
    const hasBeaver = Boolean(row.has_beaver ?? row.is_beaver ?? false);
    const beaverConfidence =
      typeof row.beaver_confidence === "number"
        ? row.beaver_confidence
        : typeof row.confidence === "number" && row.is_beaver === true
          ? row.confidence
          : 0;
    const beaverReason = String(row.beaver_reason ?? row.reason ?? "");

    const animalType = String(
      row.animal_type ?? row.animal_common_name ?? row.common_name ?? "",
    );
    const hasAnimal =
      typeof row.has_animal === "boolean"
        ? row.has_animal
        : animalType && animalType !== "No animal";

    return {
      image_path: imagePath,
      has_beaver: hasBeaver,
      confidence: beaverConfidence,
      reason: beaverReason,
      bbox: row.bbox ?? "",
      has_animal: hasAnimal,
      animal_type: animalType,
      manual_review: row.manual_review ?? "",
      animal_group: row.animal_group ?? row.group ?? "",
      animal_confidence:
        row.animal_confidence ?? (typeof row.confidence === "number" ? row.confidence : ""),
      animal_reason: row.animal_reason ?? row.notes ?? "",
      overlay_location: row.overlay_location ?? "",
      overlay_confidence: row.overlay_confidence ?? "",
      overlay_reason: row.overlay_reason ?? "",
      overlay_temperature: row.overlay_temperature ?? "",
      model_id: row.model_id ?? "",
      exif_timestamp: row.exif_timestamp ?? "",
      exif_location: row.exif_location ?? "",
      error: row.error ?? "",
      filename: row.filename ?? "",
      is_beaver: row.is_beaver ?? "",
      beaver_confidence: row.beaver_confidence ?? "",
      beaver_reason: row.beaver_reason ?? "",
      common_name: row.common_name ?? "",
      group: row.group ?? "",
      notes: row.notes ?? "",
    };
  });

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
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
  const {
    jobId,
    files = [],
    s3Inputs = [],
    modelId,
    bucket,
    region,
    s3Region,
    manifestKey,
    chunkIndex = 0,
    chunkSize = 0,
    totalImages: totalImagesFromPayload = 0,
    progressBase = 0,
  } = params;
  const jobClient = new S3Client({ region });
  const inputClient = new S3Client({ region: s3Region });

  await updateJob(jobId, { status: "running" });

  let effectiveS3Inputs = s3Inputs;
  let totalJobImages = Number(totalImagesFromPayload || 0);
  if (manifestKey) {
    const manifestResp = await jobClient.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: manifestKey,
      }),
    );
    if (!manifestResp.Body) {
      throw new Error("Job inputs manifest missing from S3.");
    }
    const manifestBuf = await streamToBuffer(manifestResp.Body);
    const manifestAll = JSON.parse(manifestBuf.toString("utf8"));
    if (!Array.isArray(manifestAll)) {
      throw new Error("Invalid job inputs manifest.");
    }
    const perChunk = Math.max(1, Number(chunkSize || 0));
    const start = Number(chunkIndex || 0) * perChunk;
    effectiveS3Inputs = manifestAll.slice(start, start + perChunk);
    if (!totalJobImages) totalJobImages = manifestAll.length;
  }

  const total = files.length + effectiveS3Inputs.length;
  let completed = 0;
  const eventGapSeconds = Number(process.env.BEAVER_SEQUENCE_EVENT_GAP_SECONDS || "30") || 30;
  const burstGapSeconds = Number(process.env.BEAVER_SEQUENCE_BURST_GAP_SECONDS || "6") || 6;

  function parseTsMs(ts) {
    const ms = Date.parse(String(ts || "").trim());
    return Number.isFinite(ms) ? ms : null;
  }

  function sampleUpToN(frames, max) {
    const n = frames.length;
    const k = Math.max(1, Math.min(Number(max || 5), 5));
    if (n <= k) return frames;
    if (k === 1) return [frames[0]];
    const idx = [];
    for (let i = 0; i < k; i++) {
      const t = i / (k - 1);
      idx.push(Math.round((n - 1) * t));
    }
    const unique = [...new Set(idx)].sort((a, b) => a - b);
    return unique.map((i) => frames[i]);
  }

  function pickFramesForSequence(frames) {
    if (frames.length <= 1) return frames;

    const msList = frames.map((f) => parseTsMs(f.exif_timestamp));
    if (msList.some((v) => v == null)) {
      return sampleUpToN(frames, 5);
    }

    // Find the longest burst run where adjacent frames are within burstGapSeconds.
    let bestStart = 0;
    let bestLen = 1;
    let runStart = 0;
    for (let i = 1; i < frames.length; i++) {
      const gap = msList[i] - msList[i - 1];
      if (gap <= burstGapSeconds * 1000) continue;
      const runLen = i - runStart;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
      runStart = i;
    }
    const lastRunLen = frames.length - runStart;
    if (lastRunLen > bestLen) {
      bestLen = lastRunLen;
      bestStart = runStart;
    }

    const burstFrames =
      bestLen >= 2 ? frames.slice(bestStart, bestStart + bestLen) : [];
    const source = burstFrames.length >= 2 ? burstFrames : frames;
    return sampleUpToN(source, 5);
  }

  const results = [];
  let sequenceIndex = 0;
  let current = [];
  let lastMs = null;
  const isChunked = Boolean(manifestKey);

  async function maybeUpdateProgress() {
    if (isChunked) {
      const absolute = Math.min(totalJobImages, Number(progressBase || 0) + completed);
      await updateJob(jobId, { status: "running", completed_images: absolute });
      return;
    }
    await updateJob(jobId, { completed_images: completed });
  }

  async function flushSequence() {
    if (current.length === 0) return;
    sequenceIndex += 1;

    const startTs = current[0].exif_timestamp || "";
    const startMs = parseTsMs(startTs);
    const startId = startMs
      ? new Date(startMs).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")
      : "no_ts";
    const seqId = `${jobId}_${startId}_${sequenceIndex}`;

    const picked = pickFramesForSequence(current);
    const allowOversizeNoSharp = current[0].allowOversizeNoSharp === true;

    let seqOutput;
    try {
      seqOutput = await classifySequenceBuffers(
        modelId,
        picked.map((f) => f.buffer),
        { allowOversizeNoSharp, maxImages: picked.length },
      );
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (isOversizeNoSharpError(error)) {
        message =
          "Image exceeds 5MB and sharp is unavailable. Please upload a smaller image or enable the sharp Lambda layer.";
      } else if (isBedrockOversizeError(error)) {
        message =
          "Bedrock rejected the image because it exceeds 5MB. Enable the sharp Lambda layer or provide smaller images.";
      }
      for (const frame of current) {
        results.push(
          buildErrorResult(frame.filename, message, {
            image_path: frame.image_path,
            s3_key: frame.s3_key,
            s3_bucket: frame.s3_bucket,
            exif_timestamp: frame.exif_timestamp,
            sequence_id: seqId,
            sequence_size: current.length,
            sequence_start_ts: startTs,
          }),
        );
      }
      completed += current.length;
      if (completed % 10 === 0 || completed === total) {
        await maybeUpdateProgress();
      }
      current = [];
      lastMs = null;
      return;
    }

    for (const frame of current) {
      results.push({
        filename: frame.filename,
        image_path: frame.image_path,
        ...seqOutput,
        exif_timestamp: frame.exif_timestamp,
        s3_key: frame.s3_key,
        s3_bucket: frame.s3_bucket,
        sequence_id: seqId,
        sequence_size: current.length,
        sequence_start_ts: startTs,
        sequence_event_gap_seconds: eventGapSeconds,
        sequence_burst_gap_seconds: burstGapSeconds,
      });
    }

    completed += current.length;
    if (completed % 10 === 0 || completed === total) {
      await maybeUpdateProgress();
    }
    current = [];
    lastMs = null;
  }

  // Upload inputs are already in memory. S3 inputs are fetched on demand.
  const items = [
    ...files.map((file) => ({ kind: "upload", file })),
    ...effectiveS3Inputs.map((input) => ({ kind: "s3", input })),
  ];

  for (const item of items) {
    let filename;
    let imagePath;
    let buffer;
    let s3Key = "";
    let s3Bucket = "";
    let allowOversizeNoSharp = false;

    if (item.kind === "upload") {
      const file = item.file;
      filename = file.filename;
      imagePath = file.filename;
      buffer = file.buffer;
      allowOversizeNoSharp = false;

      const key = `jobs/${jobId}/input/${file.filename}`;
      s3Key = key;
      await jobClient.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimeType || "application/octet-stream",
        }),
      );
    } else {
      const input = item.input;
      filename = path.basename(input.key);
      imagePath = filename;
      s3Key = input.key;
      s3Bucket = input.bucket;
      allowOversizeNoSharp = true;

      const getResult = await inputClient.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
      );
      const body = getResult.Body;
      if (!body) {
        await flushSequence();
        completed += 1;
        results.push(
          buildErrorResult(filename, "Missing S3 body", {
            image_path: imagePath,
            s3_key: s3Key,
            s3_bucket: s3Bucket,
          }),
        );
        if (completed % 10 === 0 || completed === total) {
          await maybeUpdateProgress();
        }
        continue;
      }
      buffer = await streamToBuffer(body);
    }

    const exif = await extractExifTimestamp(buffer);
    const ms = parseTsMs(exif);
    if (ms == null) {
      await flushSequence();
      current = [
        {
          filename,
          image_path: imagePath,
          buffer,
          s3_key: s3Key,
          s3_bucket: s3Bucket,
          exif_timestamp: exif || "",
          allowOversizeNoSharp,
        },
      ];
      await flushSequence();
      continue;
    }

    if (current.length === 0) {
      current.push({
        filename,
        image_path: imagePath,
        buffer,
        s3_key: s3Key,
        s3_bucket: s3Bucket,
        exif_timestamp: exif,
        allowOversizeNoSharp,
      });
      lastMs = ms;
      continue;
    }

    if (lastMs != null && ms - lastMs <= eventGapSeconds * 1000) {
      current.push({
        filename,
        image_path: imagePath,
        buffer,
        s3_key: s3Key,
        s3_bucket: s3Bucket,
        exif_timestamp: exif,
        allowOversizeNoSharp,
      });
      lastMs = ms;
      continue;
    }

    await flushSequence();
    current.push({
      filename,
      image_path: imagePath,
      buffer,
      s3_key: s3Key,
      s3_bucket: s3Bucket,
      exif_timestamp: exif,
      allowOversizeNoSharp,
    });
    lastMs = ms;
  }

  await flushSequence();
  if (!isChunked) {
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
    return;
  }

  const existing = await getJob(jobId);
  if (!existing) {
    throw new Error(`Job not found while appending chunk: ${jobId}`);
  }
  const prevResults = Array.isArray(existing.results) ? existing.results : [];
  const mergedResults = [...prevResults, ...results];
  const newCompleted = Math.min(totalJobImages, Number(progressBase || 0) + completed);
  const isLastChunk = newCompleted >= totalJobImages;

  if (!isLastChunk) {
    await updateJob(jobId, {
      status: "running",
      completed_images: newCompleted,
      results: mergedResults,
      error: null,
    });

    const queueUrl = process.env.BEAVER_JOB_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("Missing BEAVER_JOB_QUEUE_URL for chunk continuation.");
    }
    const sqsClient = new SQSClient({ region });
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          jobId,
          modelId,
          bucket,
          region,
          s3Region,
          manifest_key: manifestKey,
          chunk_index: Number(chunkIndex || 0) + 1,
          chunk_size: Number(chunkSize || 0),
          total_images: totalJobImages,
          progress_base: newCompleted,
        }),
      }),
    );
    return;
  }

  const csv = buildCsv(mergedResults);
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
    completed_images: totalJobImages,
    results: mergedResults,
    csv_s3_key: csvKey,
    error: null,
  });
}

async function handleClassify(event) {
  const { fields, files } = await parseMultipart(event);
  const allFiles = files.filter((file) => file.fieldName === "file" || file.fieldName === "files");
  const s3Path = String(fields.s3Path || fields.s3_path || "").trim();
  if (allFiles.length === 0 && !s3Path) {
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

  if (s3Path) {
    const parsed = parseS3Path(s3Path);
    if (parsed.prefix.endsWith("/")) {
      return jsonResponse(400, { error: "S3 path is a folder; use batch jobs." });
    }
    const ext = path.extname(parsed.prefix).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return jsonResponse(400, { error: "S3 path must point to an image file." });
    }
    const region = requireEnv("AWS_REGION");
    const s3Region = await resolveS3Region(parsed.bucket, region);
    const s3Client = new S3Client({ region: s3Region });
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: parsed.bucket,
        Key: parsed.prefix,
      }),
    );
    if (!response.Body) {
      return jsonResponse(404, { error: "S3 object not found." });
    }
    const buffer = await streamToBuffer(response.Body);
    try {
      const output = await classifyImageBuffer(modelId, buffer, {
        allowOversizeNoSharp: true,
      });
      return jsonResponse(200, {
        results: [{ filename: path.basename(parsed.prefix), ...output }],
      });
    } catch (error) {
      if (isOversizeNoSharpError(error)) {
        return jsonResponse(413, {
          error:
            "Image exceeds 5MB and sharp is unavailable. Please upload a smaller image or enable the sharp Lambda layer.",
          sharp_available: getSharpAvailability(),
        });
      }
      if (isBedrockOversizeError(error)) {
        return jsonResponse(422, {
          error:
            "Bedrock rejected the image because it exceeds 5MB. Enable the sharp Lambda layer or provide smaller images.",
          sharp_available: getSharpAvailability(),
        });
      }
      throw error;
    }
  }

  const results = [];
  for (const file of allFiles) {
    try {
      const output = await classifyImageBuffer(modelId, file.buffer, {
        allowOversizeNoSharp: false,
      });
      results.push({ filename: file.filename, ...output });
    } catch (error) {
      if (isOversizeNoSharpError(error)) {
        return jsonResponse(413, {
          error:
            "Image exceeds 5MB and sharp is unavailable. Please upload a smaller image or enable the sharp Lambda layer.",
          sharp_available: getSharpAvailability(),
        });
      }
      if (isBedrockOversizeError(error)) {
        return jsonResponse(422, {
          error:
            "Bedrock rejected the image because it exceeds 5MB. Enable the sharp Lambda layer or provide smaller images.",
          sharp_available: getSharpAvailability(),
        });
      }
      throw error;
    }
  }

  return jsonResponse(200, { results });
}

async function handleJobs(event) {
  const { fields, files } = await parseMultipart(event);
  const uploadFiles = files.filter((file) => file.fieldName === "files");
  const s3Path = String(fields.s3Path || fields.s3_path || "").trim();
  console.log("[jobs] request", {
    uploadCount: uploadFiles.length,
    hasS3Path: Boolean(s3Path),
  });

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
    if (!fields.s3Region && !fields.s3_region && !process.env.S3_REGION) {
      s3Region = await resolveS3Region(parsedS3.bucket, region);
    }
  }

  const s3Client = new S3Client({ region: s3Region });
  const jobClient = new S3Client({ region });

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

  const queueUrl = process.env.BEAVER_JOB_QUEUE_URL;
  if (queueUrl) {
    console.log("[jobs] enqueue", { queueUrl, jobId });
    const uploadedInputs = [];
    if (uploadFiles.length > 0) {
      for (const file of uploadFiles) {
        const key = `jobs/${jobId}/input/${file.filename}`;
        await jobClient.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimeType || "application/octet-stream",
          }),
        );
        uploadedInputs.push({ bucket, key });
      }
    }
    const allInputs = [...uploadedInputs, ...s3Inputs];
    await createJob({
      id: jobId,
      source: s3Path ? "s3" : "upload",
      totalImages: allInputs.length,
    });
    const chunkSize = Math.max(
      50,
      Math.min(Number(process.env.BEAVER_JOB_CHUNK_SIZE || "250") || 250, 500),
    );
    const manifestKey = `jobs/${jobId}/meta/inputs.json`;
    await jobClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: manifestKey,
        Body: JSON.stringify(allInputs),
        ContentType: "application/json",
      }),
    );
    const sqsClient = new SQSClient({ region });
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          jobId,
          modelId,
          bucket,
          region,
          s3Region,
          manifest_key: manifestKey,
          chunk_index: 0,
          chunk_size: chunkSize,
          total_images: allInputs.length,
          progress_base: 0,
        }),
      }),
    );
    console.log("[jobs] enqueued", {
      jobId,
      total: allInputs.length,
      chunkSize,
      chunks: Math.ceil(allInputs.length / chunkSize),
    });
    return jsonResponse(202, {
      job_id: jobId,
      status: "queued",
      total_images: allInputs.length,
    });
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

async function handleUploadUrl(event) {
  const payload = parseJsonBody(event);
  const filename = String(payload.filename || "").trim();
  if (!filename) {
    return jsonResponse(400, { error: "Missing filename." });
  }

  const contentType = String(payload.content_type || payload.contentType || "").trim();
  const prefix =
    String(payload.prefix || "").trim() || `uploads/${randomUUID()}`;
  const safeName = path.basename(filename).replace(/\s+/g, "_");
  const key = `${prefix}/${randomUUID()}_${safeName}`;

  const bucket = requireEnv("BEAVER_JOB_BUCKET");
  const region = requireEnv("AWS_REGION");
  const s3Client = new S3Client({ region });

  const uploadUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    }),
    { expiresIn: 300 },
  );

  return jsonResponse(200, {
    upload_url: uploadUrl,
    s3_path: `s3://${bucket}/${key}`,
    bucket,
    key,
    prefix,
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
  if (Array.isArray(event?.Records) && event.Records[0]?.eventSource === "aws:sqs") {
    for (const record of event.Records) {
      try {
        const payload = JSON.parse(record.body || "{}");
        if (!payload.jobId || !payload.modelId || !payload.bucket || !payload.region) {
          throw new Error("Invalid job payload.");
        }
        const manifestKey = String(payload.manifest_key || "").trim();
        const chunkIndex = Number(payload.chunk_index || 0) || 0;
        const chunkSize = Number(payload.chunk_size || 0) || 0;
        const totalImages = Number(payload.total_images || 0) || 0;
        const progressBase = Number(payload.progress_base || 0) || 0;
        console.log("[jobs] dequeue", {
          jobId: payload.jobId,
          manifest: Boolean(manifestKey),
          chunkIndex,
          chunkSize,
          totalImages,
          progressBase,
          total: Array.isArray(payload.s3Inputs) ? payload.s3Inputs.length : 0,
        });
        const s3Inputs = Array.isArray(payload.s3Inputs) ? payload.s3Inputs : [];
        await processJob({
          jobId: payload.jobId,
          files: [],
          s3Inputs,
          modelId: payload.modelId,
          bucket: payload.bucket,
          region: payload.region,
          s3Region: payload.s3Region || payload.region,
          manifestKey: manifestKey || undefined,
          chunkIndex,
          chunkSize,
          totalImages,
          progressBase,
        });
      } catch (error) {
        console.error("[jobs] queue processing error", error);
      }
    }
    return { statusCode: 200, body: "" };
  }
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
    if (method === "POST" && normalizedPath === "/api/upload-url") {
      return await handleUploadUrl(event);
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
