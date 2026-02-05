import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import path from "node:path";
import { Readable } from "node:stream";
import { postProcessAnimalOutput } from "@/lib/animalPostProcess";
import { classifyImageBuffer } from "@/lib/classify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);
const MAX_FILES = 500;

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
  limit: number,
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
        if (limit > 0 && keys.length >= limit) {
          return keys;
        }
      }
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);

  return keys;
}

function mapClassifyResult(
  output: {
    is_beaver: boolean;
    confidence: number;
    common_name: string;
    group: string;
    notes: string;
    overlay_location?: string;
    overlay_confidence?: number;
    overlay_reason?: string;
    overlay_temperature?: string;
    exif_timestamp?: string;
  },
  imagePath: string,
  index: number,
) {
  const animalPostRaw = postProcessAnimalOutput({
    common_name: output.common_name,
    confidence: output.confidence,
    group: output.group,
    notes: output.notes,
  });

  const animalPost = output.is_beaver
    ? {
        ...animalPostRaw,
        Common_Name: "Beaver",
        confidence: output.confidence,
        manual_review: false,
      }
    : animalPostRaw;

  const hasAnimal = animalPost.Common_Name !== "No animal";
  const predicted_label = output.is_beaver
    ? "beaver"
    : animalPost.Common_Name === "No animal"
      ? "no_animal"
      : animalPost.Common_Name && animalPost.Common_Name !== "unknown"
        ? "other_animal"
        : hasAnimal
          ? "other_animal"
          : "no_animal";

  return {
    id: `row_${index}`,
    image_path: imagePath,
    filename: path.basename(imagePath),
    predicted_label,
    confidence: output.confidence,
    reason: output.notes || "",
    review_label: predicted_label,
    was_corrected: false,
    notes: "",
    model_id: "",
    has_beaver: output.is_beaver,
    has_animal: hasAnimal,
    Common_Name: animalPost.Common_Name,
    manual_review: animalPost.manual_review,
    animal_type: animalPost.Common_Name,
    animal_group: output.group,
    animal_confidence: animalPost.confidence,
    animal_reason: animalPost.notes,
    bbox: "",
    overlay_location: output.overlay_location || "",
    overlay_confidence: output.overlay_confidence ?? "",
    overlay_reason: output.overlay_reason || "",
    overlay_temperature: output.overlay_temperature || "",
    exif_timestamp: output.exif_timestamp || "",
    exif_location: "",
    error: "",
  };
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const s3Path = String(formData.get("s3Path") || "").trim();
    const files = formData.getAll("files").filter((f) => f instanceof File) as File[];

    if (!s3Path && files.length === 0) {
      return new Response(JSON.stringify({ error: "No files or S3 path provided." }), {
        status: 400,
      });
    }

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

    const results = [];
    const limitValue = Number(process.env.BEAVER_LIMIT || "0");
    const limit = Number.isFinite(limitValue) ? limitValue : 0;
    const s3Region = process.env.S3_REGION || process.env.AWS_REGION || "us-east-2";

    if (s3Path) {
      const parsed = parseS3Path(s3Path);
      const s3Client = new S3Client({ region: s3Region });
      const keys = await listS3Images(s3Client, parsed.bucket, parsed.prefix, limit);
      if (keys.length === 0) {
        return new Response(JSON.stringify({ error: "No images found for S3 prefix." }), {
          status: 400,
        });
      }
      if (keys.length > MAX_FILES) {
        return new Response(
          JSON.stringify({ error: `Too many images. Max ${MAX_FILES}.` }),
          { status: 400 },
        );
      }

      let index = 0;
      for (const key of keys) {
        const getResult = await s3Client.send(
          new GetObjectCommand({
            Bucket: parsed.bucket,
            Key: key,
          }),
        );
        const body = getResult.Body as Readable | undefined;
        if (!body) continue;
        const buffer = await streamToBuffer(body);
        const output = await classifyImageBuffer(modelId, buffer);
        const imagePath = `s3://${parsed.bucket}/${key}`;
        results.push(mapClassifyResult(output, imagePath, index));
        index += 1;
      }
    } else {
      if (files.length > MAX_FILES) {
        return new Response(
          JSON.stringify({ error: `Too many files. Max ${MAX_FILES}.` }),
          { status: 400 },
        );
      }
      let index = 0;
      for (const file of files) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const output = await classifyImageBuffer(modelId, buffer);
        results.push(mapClassifyResult(output, file.name, index));
        index += 1;
      }
    }

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Beaver run error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
