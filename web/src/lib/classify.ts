import { bedrock } from "@ai-sdk/amazon-bedrock";
import { generateText } from "ai";
import sharp from "sharp";
import * as exifr from "exifr";

const MAX_JPEG_BYTES = 5 * 1024 * 1024;

const ALLOWED_COMMON_NAMES = new Set([
  "Beaver",
  "Nutria",
  "Raccoon",
  "Black bear",
  "Long-tailed weasel",
  "Mink",
  "River otter",
  "Striped skunk",
  "Bobcat",
  "Mountain lion (Cougar)",
  "Coyote",
  "Elk",
  "Mule and black-tailed deer",
  "human",
  "Band-tailed pigeon",
  "Barred owl",
  "Western screech-owl",
  "Great blue heron",
  "other mammal",
  "other bird",
  "unknown",
  "No animal",
]);

const CLASSIFY_PROMPT = [
  "You are a wildlife image classification assistant.",
  "",
  "Task:",
  "1) Decide if there is ANY animal in the image.",
  "2) If yes, identify the most likely species from the allowed list.",
  "3) Decide if the animal is a beaver.",
  "",
  "Animal definition:",
  "- Any real animal (mammal or bird)",
  "- Can be partial, far away, blurred, low-light, silhouette",
  "",
  "Allowed Common_Name values (exact casing):",
  Array.from(ALLOWED_COMMON_NAMES).join(", "),
  "",
  "Rules:",
  "- If there is ANY reasonable evidence of an animal, answer YES.",
  "- If uncertain, lean toward YES.",
  "- Do NOT count logs, rocks, shadows, plants, or water ripples.",
  "- Do NOT guess species if there is no clear visual evidence.",
  "- If you identify a species not on the list, choose \"other mammal\" or \"other bird\".",
  "- If there is no animal, set common_name to \"No animal\" and group to \"none\".",
  "- If the common_name is \"Beaver\", is_beaver must be true.",
  "",
  "Return STRICT JSON only:",
  "{\"is_beaver\": true/false, \"confidence\": 0-1, \"common_name\": \"...\", \"group\": \"mammal | bird | none | unknown\", \"notes\": \"short\"}",
  "Output MUST start with { and end with } and contain nothing else.",
].join("\n");

type ModelOutput = {
  is_beaver: boolean;
  confidence: number;
  common_name: string;
  group: "mammal" | "bird" | "none" | "unknown";
  notes: string;
  overlay_location?: string;
  overlay_confidence?: number;
  overlay_reason?: string;
  overlay_temperature?: string;
  exif_timestamp?: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeModelOutput(raw: unknown): ModelOutput {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  const isBeaver = Boolean((obj as { is_beaver?: unknown }).is_beaver);
  const confidenceRaw = (obj as { confidence?: unknown }).confidence;
  const confidence =
    typeof confidenceRaw === "number" ? clamp(confidenceRaw, 0, 1) : 0;
  const commonNameRaw = (obj as { common_name?: unknown }).common_name;
  const commonName =
    typeof commonNameRaw === "string" && commonNameRaw.trim()
      ? commonNameRaw.trim()
      : "unknown";
  const groupRaw = (obj as { group?: unknown }).group;
  const group =
    groupRaw === "mammal" || groupRaw === "bird" || groupRaw === "none"
      ? groupRaw
      : "unknown";
  const notesRaw = (obj as { notes?: unknown }).notes;
  const notes = typeof notesRaw === "string" ? notesRaw : "";

  return {
    is_beaver: isBeaver,
    confidence,
    common_name: commonName,
    group,
    notes,
  };
}

function buildOverlayPrompt(allowedCodes: string[], allowAny: boolean) {
  const allowedLine =
    !allowAny && allowedCodes.length > 0
      ? `Allowed site codes (exact match): ${allowedCodes.join(", ")}`
      : "If you see a site code, return it exactly as shown.";

  return [
    "You read trail camera overlays. Extract the site/location code from the overlay text.",
    allowedLine,
    "",
    "Return STRICT JSON only:",
    '{"location_code": "<code or unknown>", "temperature": "<value or unknown>", "confidence": 0-1, "reason": "short"}',
    "Output MUST start with { and end with } and contain nothing else.",
  ].join("\n");
}

function normalizeOverlayOutput(raw: unknown) {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  const codeRaw = (obj as { location_code?: unknown }).location_code;
  const locationCode =
    typeof codeRaw === "string" && codeRaw.trim() ? codeRaw.trim() : "unknown";
  const temperatureRaw = (obj as { temperature?: unknown }).temperature;
  const temperature =
    typeof temperatureRaw === "string" && temperatureRaw.trim()
      ? temperatureRaw.trim()
      : "unknown";
  const confidenceRaw = (obj as { confidence?: unknown }).confidence;
  const confidence =
    typeof confidenceRaw === "number" ? clamp(confidenceRaw, 0, 1) : 0;
  const reasonRaw = (obj as { reason?: unknown }).reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : "";
  return { location_code: locationCode, temperature, confidence, reason };
}

async function extractExifTimestamp(imageBytes: Buffer) {
  try {
    const data = await exifr.parse(imageBytes, {
      pick: ["DateTimeOriginal", "CreateDate", "ModifyDate"],
    });
    const date =
      data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate || null;
    if (date instanceof Date) {
      return date.toISOString();
    }
  } catch {
    return "";
  }
  return "";
}

async function toJpegUnderLimit(input: Buffer) {
  const base = sharp(input).rotate().resize({
    width: 2000,
    height: 2000,
    fit: "inside",
    withoutEnlargement: true,
  });

  const qualitySteps = [85, 75, 65, 55, 45];
  for (const quality of qualitySteps) {
    const jpeg = await base.jpeg({ quality }).toBuffer();
    if (jpeg.length <= MAX_JPEG_BYTES) {
      return jpeg;
    }
  }

  const smaller = await base
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 45 })
    .toBuffer();
  return smaller;
}

async function classifyImageBuffer(modelId: string, imageBytes: Buffer) {
  const jpegBytes = await toJpegUnderLimit(imageBytes);
  const overlayEnabled =
    process.env.BEAVER_OVERLAY_ENABLED === "1" ||
    process.env.BEAVER_OVERLAY_ENABLED === "true";
  const overlayAllowAny =
    process.env.BEAVER_OVERLAY_ALLOW_ANY === "1" ||
    process.env.BEAVER_OVERLAY_ALLOW_ANY === "true";
  const allowedCodes = String(process.env.BEAVER_OVERLAY_CODES || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

  const [classifyResult, overlayResult, exifTimestamp] = await Promise.all([
    generateText({
      model: bedrock(modelId),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: CLASSIFY_PROMPT },
            { type: "image", image: jpegBytes, mediaType: "image/jpeg" },
          ],
        },
      ],
    }),
    overlayEnabled
      ? generateText({
          model: bedrock(modelId),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: buildOverlayPrompt(allowedCodes, overlayAllowAny) },
                { type: "image", image: jpegBytes, mediaType: "image/jpeg" },
              ],
            },
          ],
        })
      : Promise.resolve(null),
    extractExifTimestamp(imageBytes),
  ]);

  const text = classifyResult.text ?? "";
  let parsed: ModelOutput;
  try {
    parsed = normalizeModelOutput(JSON.parse(text));
  } catch {
    parsed = normalizeModelOutput({});
  }

  if (overlayResult?.text) {
    try {
      const overlay = normalizeOverlayOutput(JSON.parse(overlayResult.text));
      parsed = {
        ...parsed,
        overlay_location: overlay.location_code,
        overlay_temperature: overlay.temperature,
        overlay_confidence: overlay.confidence,
        overlay_reason: overlay.reason,
      };
    } catch {
      parsed = {
        ...parsed,
        overlay_location: "unknown",
        overlay_temperature: "unknown",
        overlay_confidence: 0,
        overlay_reason: "",
      };
    }
  }

  if (exifTimestamp) {
    parsed = { ...parsed, exif_timestamp: exifTimestamp };
  }

  if (!ALLOWED_COMMON_NAMES.has(parsed.common_name)) {
    parsed = {
      ...parsed,
      common_name: "unknown",
      group: "unknown",
    };
  }

  if (parsed.common_name === "Beaver") {
    parsed = { ...parsed, is_beaver: true };
  }
  if (parsed.common_name === "No animal") {
    parsed = { ...parsed, is_beaver: false, group: "none" };
  }

  return parsed;
}

export {
  ALLOWED_COMMON_NAMES,
  CLASSIFY_PROMPT,
  classifyImageBuffer,
  normalizeModelOutput,
  toJpegUnderLimit,
};
export type { ModelOutput };
