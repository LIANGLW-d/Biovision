import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { classifyImageBuffer } from "@/lib/classify";
import { createJob, updateJob } from "@/lib/jobsDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 1000;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function buildCsv(results: Array<Record<string, unknown>>) {
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

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseS3Path(value: string) {
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

async function listS3Images(
  client: S3Client,
  bucket: string,
  prefix: string,
) {
  const keys: string[] = [];
  let token: string | undefined;

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

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  onComplete?: () => Promise<void>,
) {
  const results: T[] = [];
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

async function processJob(params: {
  jobId: string;
  files: File[];
  s3Inputs: Array<{ bucket: string; key: string }>;
  modelId: string;
  bucket: string;
  region: string;
  s3Region: string;
}) {
  const { jobId, files, s3Inputs, modelId, bucket, region, s3Region } = params;
  const jobClient = new S3Client({ region });
  const inputClient = new S3Client({ region: s3Region });

  await updateJob(jobId, { status: "running" });

  const total = files.length + s3Inputs.length;
  let completed = 0;
  const concurrency = Number(process.env.BEAVER_JOB_CONCURRENCY || "3") || 3;

  const tasks: Array<() => Promise<Record<string, unknown>>> = [
    ...files.map((file) => async () => {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const key = `jobs/${jobId}/input/${file.name}`;

      await jobClient.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: file.type || "application/octet-stream",
        }),
      );

      const output = await classifyImageBuffer(modelId, buffer);
      return {
        filename: file.name,
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
      const body = getResult.Body as Readable | undefined;
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

export async function POST(req: Request) {
  try {
    console.log("[jobs] start");
    const formData = await req.formData();
    const files = formData
      .getAll("files")
      .filter((item): item is File => item instanceof File);
    const s3Path = String(formData.get("s3Path") || "").trim();

    if (files.length === 0 && !s3Path) {
      return new Response(JSON.stringify({ error: "No files or S3 path provided." }), {
        status: 400,
      });
    }
    if (files.length > MAX_FILES) {
      return new Response(
        JSON.stringify({ error: `Too many files. Max ${MAX_FILES}.` }),
        { status: 400 },
      );
    }

    const jobId = randomUUID();
    const bucket = requireEnv("BEAVER_JOB_BUCKET");
    const region = requireEnv("AWS_REGION");
    const s3Region = process.env.S3_REGION || region;
    console.log("[jobs] env", { bucket, region, s3Region });
    const modelId =
      (formData.get("modelId") as string | null) ||
      process.env.BEAVER_BEDROCK_MODEL_ID ||
      process.env.BEDROCK_MODEL_ID;

    if (!modelId) {
      return new Response(
        JSON.stringify({ error: "Missing Bedrock model id. Set BEAVER_BEDROCK_MODEL_ID." }),
        { status: 400 },
      );
    }

    const s3Client = new S3Client({ region: s3Region });
    let s3Inputs: Array<{ bucket: string; key: string }> = [];
    if (s3Path) {
      const parsed = parseS3Path(s3Path);
      const keys = await listS3Images(s3Client, parsed.bucket, parsed.prefix);
      if (keys.length === 0) {
        return new Response(JSON.stringify({ error: "No images found for S3 prefix." }), {
          status: 400,
        });
      }
      if (keys.length > MAX_FILES) {
        return new Response(
          JSON.stringify({ error: `Too many S3 images. Max ${MAX_FILES}.` }),
          { status: 400 },
        );
      }
      s3Inputs = keys.map((key) => ({ bucket: parsed.bucket, key }));
    }

    try {
      await createJob({
        id: jobId,
        source: s3Path ? "s3" : "upload",
        totalImages: files.length + s3Inputs.length,
      });
      console.log("[jobs] db: created");
    } catch (error) {
      console.error("[jobs] db error", error);
      throw error;
    }

    void processJob({ jobId, files, s3Inputs, modelId, bucket, region, s3Region }).catch(
      (error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[jobs] processing error", error);
      updateJob(jobId, { status: "error", error: message }).catch(() => undefined);
    },
    );

    return new Response(
      JSON.stringify({
        job_id: jobId,
        status: "queued",
        total_images: files.length + s3Inputs.length,
      }),
      { status: 202 },
    );
  } catch (error) {
    console.error("Jobs API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
