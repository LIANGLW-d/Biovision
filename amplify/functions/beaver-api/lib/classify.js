const { createAmazonBedrock } = require("@ai-sdk/amazon-bedrock");
const { generateText } = require("ai");
const exifr = require("exifr");
const fs = require("node:fs");

const MAX_JPEG_BYTES = 5 * 1024 * 1024;
let sharpStatusLogged = false;
let sharpAvailable = null;
const bedrock = createAmazonBedrock({
  region:
    process.env.BEAVER_BEDROCK_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-2",
});

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
  "Input:",
  "- You may receive 1-2 images from the SAME camera captured within a short time window (a sequence).",
  "- Use ALL provided images to decide animal presence and species.",
  "- If an object looks like an animal in one frame but does NOT move/change across frames, it may be a log/rock/shadow; do NOT count it as an animal.",
  "- An animal may appear in ONLY ONE frame; still count it if there is reasonable evidence.",
  "",
  "Task:",
  "1) Decide if there is ANY animal in the image.",
  "2) If yes, identify the most likely species from the allowed list.",
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
  "",
  "Return STRICT JSON only:",
  "{\"confidence\": 0-1, \"common_name\": \"...\", \"group\": \"mammal | bird | none | unknown\", \"notes\": \"short\"}",
  "Output MUST start with { and end with } and contain nothing else.",
].join("\n");

// Legacy "Prompt 1" from the Python CLI: beaver-only detection.
// Keep the schema stable so the UI/CSV can treat this as the beaver agent output.
const BEAVER_ONLY_PROMPT = [
  "You are a wildlife expert. Decide whether the image contains a beaver.",
  "IMPORTANT:",
  "- You may receive 1-2 images from the SAME camera captured within a short time window (a sequence).",
  "- Use ALL provided images to decide.",
  "- If something looks like a beaver in one frame but does NOT move/change across frames, it may be a log/wood in water; do NOT call it beaver.",
  "- A beaver may appear in ONLY ONE frame; still count it if there is reasonable visual evidence.",
  "- Many beavers are partially occluded, far away, or only show tails, silhouettes, or water disturbance.",
  "- If there is ANY reasonable visual evidence of a beaver, classify as beaver.",
  "",
  "Return STRICT JSON only:",
  '{"is_beaver": true/false, "confidence": 0-1, "reason": "short"}',
  "Output MUST start with { and end with } and contain nothing else.",
].join("\n");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeModelOutput(raw) {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  const isBeaver = Boolean(obj.is_beaver);
  const confidence =
    typeof obj.confidence === "number" ? clamp(obj.confidence, 0, 1) : 0;
  const commonName =
    typeof obj.common_name === "string" && obj.common_name.trim()
      ? obj.common_name.trim()
      : "unknown";
  const group =
    obj.group === "mammal" || obj.group === "bird" || obj.group === "none"
      ? obj.group
      : "unknown";
  const notes = typeof obj.notes === "string" ? obj.notes : "";

  return {
    is_beaver: isBeaver,
    confidence,
    common_name: commonName,
    group,
    notes,
  };
}

function normalizeBeaverOnlyOutput(raw) {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  const isBeaver = Boolean(obj.is_beaver);
  const confidence =
    typeof obj.confidence === "number" ? clamp(obj.confidence, 0, 1) : 0;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { is_beaver: isBeaver, confidence, reason };
}

function buildOverlayPrompt(allowedCodes, allowAny) {
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

function normalizeOverlayOutput(raw) {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  const locationCode =
    typeof obj.location_code === "string" && obj.location_code.trim()
      ? obj.location_code.trim()
      : "unknown";
  const temperature =
    typeof obj.temperature === "string" && obj.temperature.trim()
      ? obj.temperature.trim()
      : "unknown";
  const confidence =
    typeof obj.confidence === "number" ? clamp(obj.confidence, 0, 1) : 0;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { location_code: locationCode, temperature, confidence, reason };
}

async function extractExifTimestamp(imageBytes) {
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

function pickOverlayConfigFromEnv() {
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
  return { overlayEnabled, overlayAllowAny, allowedCodes };
}

async function extractOverlayOnce(modelId, jpegBytes, overlayConfig) {
  const cfg = overlayConfig || pickOverlayConfigFromEnv();
  if (!cfg.overlayEnabled) return null;
  const result = await generateText({
    model: bedrock(modelId),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildOverlayPrompt(cfg.allowedCodes, cfg.overlayAllowAny) },
          { type: "image", image: jpegBytes, mediaType: "image/jpeg" },
        ],
      },
    ],
  });
  try {
    return normalizeOverlayOutput(JSON.parse(result.text ?? ""));
  } catch {
    return { location_code: "unknown", temperature: "unknown", confidence: 0, reason: "" };
  }
}

async function classifySequenceBuffers(modelId, imageBytesList, options = {}) {
  const list = Array.isArray(imageBytesList) ? imageBytesList.filter(Boolean) : [];
  if (list.length === 0) return normalizeModelOutput({});

  const maxImages = Math.max(1, Math.min(Number(options.maxImages || 2), 5));
  const selected = list.slice(0, maxImages);
  const overlayConfig = options.overlayConfig || pickOverlayConfigFromEnv();

  const jpegs = await Promise.all(selected.map((b) => toJpegUnderLimit(b, options)));
  const imageParts = jpegs.map((jpegBytes) => ({
    type: "image",
    image: jpegBytes,
    mediaType: "image/jpeg",
  }));

  const [beaverResult, animalResult, overlay, exifTimestamp] = await Promise.all([
    generateText({
      model: bedrock(modelId),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: BEAVER_ONLY_PROMPT }, ...imageParts],
        },
      ],
    }),
    generateText({
      model: bedrock(modelId),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: CLASSIFY_PROMPT }, ...imageParts],
        },
      ],
    }),
    // Overlay is identical across frames; run once on the first image.
    extractOverlayOnce(modelId, jpegs[0], overlayConfig),
    extractExifTimestamp(selected[0]),
  ]);

  let beaverParsed;
  try {
    beaverParsed = normalizeBeaverOnlyOutput(JSON.parse(beaverResult.text ?? ""));
  } catch {
    beaverParsed = normalizeBeaverOnlyOutput({});
  }

  let animalParsed;
  try {
    animalParsed = normalizeModelOutput(JSON.parse(animalResult.text ?? ""));
  } catch {
    animalParsed = normalizeModelOutput({});
  }

  if (!ALLOWED_COMMON_NAMES.has(animalParsed.common_name)) {
    animalParsed = { ...animalParsed, common_name: "unknown", group: "unknown" };
  }

  let merged = {
    ...animalParsed,
    is_beaver: beaverParsed.is_beaver,
    has_beaver: beaverParsed.is_beaver,
    beaver_confidence: beaverParsed.confidence,
    beaver_reason: beaverParsed.reason,
    reason: beaverParsed.reason,
    confidence: beaverParsed.confidence,
    has_animal:
      animalParsed.common_name !== "No animal" && animalParsed.group !== "none",
    animal_type: animalParsed.common_name,
    animal_common_name: animalParsed.common_name,
    animal_confidence: animalParsed.confidence,
    animal_group: animalParsed.group,
    animal_reason: animalParsed.notes,
    animal_notes: animalParsed.notes,
    sequence_images_used: selected.length,
  };

  if (overlay) {
    merged = {
      ...merged,
      overlay_location: overlay.location_code,
      overlay_temperature: overlay.temperature,
      overlay_confidence: overlay.confidence,
      overlay_reason: overlay.reason,
    };
  }

  if (exifTimestamp) {
    merged = { ...merged, exif_timestamp: exifTimestamp };
  }

  if (merged.common_name === "No animal") {
    merged = { ...merged, group: "none", has_animal: false };
  }

  return merged;
}

async function toJpegUnderLimit(input, { allowOversizeNoSharp } = {}) {
  let sharpLib;
  try {
    sharpLib = require("sharp");
  } catch {
    try {
      sharpLib = require("/opt/nodejs/node_modules/sharp");
    } catch {
      try {
        sharpLib = require("/opt/nodejs/node18/node_modules/sharp");
      } catch {
        try {
          sharpLib = require("/opt/nodejs/nodejs/node_modules/sharp");
        } catch {
          sharpLib = null;
        }
      }
    }
  }

  if (!sharpLib) {
    if (!sharpStatusLogged) {
      const optParent = "/opt/nodejs";
      const optList = fs.existsSync(optParent)
        ? fs.readdirSync(optParent).slice(0, 20)
        : [];
      const optNodeModules = "/opt/nodejs/node_modules";
      const optNode18Modules = "/opt/nodejs/node18/node_modules";
      const optNodejsModules = "/opt/nodejs/nodejs/node_modules";
      const optExists = {
        nodeModules: fs.existsSync(optNodeModules),
        node18Modules: fs.existsSync(optNode18Modules),
        nodejsModules: fs.existsSync(optNodejsModules),
      };
      console.warn("[sharp] unavailable; layer not loaded");
      console.warn("[sharp] probe", {
        nodePath: process.env.NODE_PATH || "",
        optExists,
        optList,
      });
      sharpStatusLogged = true;
      sharpAvailable = false;
    }
    if (!allowOversizeNoSharp && input.length > MAX_JPEG_BYTES) {
      throw new Error(
        "Image exceeds 5MB and sharp is unavailable. Enable the sharp Lambda layer.",
      );
    }
    return input;
  }

  if (!sharpStatusLogged) {
    console.log("[sharp] loaded");
    sharpStatusLogged = true;
    sharpAvailable = true;
  }

  const base = sharpLib(input).rotate().resize({
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

async function classifyImageBuffer(modelId, imageBytes, options = {}) {
  const jpegBytes = await toJpegUnderLimit(imageBytes, options);
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

  // Two-pass: beaver-only (Prompt 1) + animal (Prompt 2).
  const [beaverResult, animalResult, overlayResult, exifTimestamp] =
    await Promise.all([
      generateText({
        model: bedrock(modelId),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: BEAVER_ONLY_PROMPT },
              { type: "image", image: jpegBytes, mediaType: "image/jpeg" },
            ],
          },
        ],
      }),
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

  let beaverParsed;
  try {
    beaverParsed = normalizeBeaverOnlyOutput(
      JSON.parse(beaverResult.text ?? ""),
    );
  } catch {
    beaverParsed = normalizeBeaverOnlyOutput({});
  }

  const text = animalResult.text ?? "";
  let animalParsed;
  try {
    animalParsed = normalizeModelOutput(JSON.parse(text));
  } catch {
    animalParsed = normalizeModelOutput({});
  }

  if (!ALLOWED_COMMON_NAMES.has(animalParsed.common_name)) {
    animalParsed = {
      ...animalParsed,
      common_name: "unknown",
      group: "unknown",
    };
  }

  // Convenience fields: keep the original shape for the UI, plus explicit
  // per-agent fields for CSV export + sequence aggregation.
  let merged = {
    ...animalParsed,
    is_beaver: beaverParsed.is_beaver,
    has_beaver: beaverParsed.is_beaver,
    beaver_confidence: beaverParsed.confidence,
    beaver_reason: beaverParsed.reason,
    // CSV-friendly columns (Prompt1/Prompt2 style).
    reason: beaverParsed.reason,
    has_animal:
      animalParsed.common_name !== "No animal" && animalParsed.group !== "none",
    animal_type: animalParsed.common_name,
    animal_common_name: animalParsed.common_name,
    animal_confidence: animalParsed.confidence,
    animal_group: animalParsed.group,
    animal_reason: animalParsed.notes,
    animal_notes: animalParsed.notes,
  };

  if (overlayResult?.text) {
    try {
      const overlay = normalizeOverlayOutput(JSON.parse(overlayResult.text));
      merged = {
        ...merged,
        overlay_location: overlay.location_code,
        overlay_temperature: overlay.temperature,
        overlay_confidence: overlay.confidence,
        overlay_reason: overlay.reason,
      };
    } catch {
      merged = {
        ...merged,
        overlay_location: "unknown",
        overlay_temperature: "unknown",
        overlay_confidence: 0,
        overlay_reason: "",
      };
    }
  }

  if (exifTimestamp) {
    merged = { ...merged, exif_timestamp: exifTimestamp };
  }

  // Keep these guardrails in case the animal agent returns "No animal".
  if (merged.common_name === "No animal") {
    merged = { ...merged, group: "none", has_animal: false };
  }

  return merged;
}

function getSharpAvailability() {
  return sharpAvailable;
}

module.exports = {
  ALLOWED_COMMON_NAMES,
  CLASSIFY_PROMPT,
  BEAVER_ONLY_PROMPT,
  classifyImageBuffer,
  classifySequenceBuffers,
  normalizeModelOutput,
  normalizeBeaverOnlyOutput,
  toJpegUnderLimit,
  getSharpAvailability,
  extractExifTimestamp,
};
