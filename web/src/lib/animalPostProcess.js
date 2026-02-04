const ALLOWED_COMMON_NAMES = [
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
];

const CANONICAL_BY_LOWER = new Map(
  ALLOWED_COMMON_NAMES.map((name) => [name.toLowerCase(), name]),
);

function normalizeGroup(groupValue) {
  const group = String(groupValue || "").trim().toLowerCase();
  if (["mammal", "bird", "none", "unknown"].includes(group)) {
    return group;
  }
  return "unknown";
}

function normalizeConfidence(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numberValue)) {
    return Math.max(0, Math.min(1, numberValue));
  }
  return 0;
}

function postProcessAnimalOutput(raw) {
  const rawName = String(raw?.common_name || raw?.Common_Name || raw?.commonName || "").trim();
  const confidence = normalizeConfidence(raw?.confidence);
  const group = normalizeGroup(raw?.group);
  const notes = String(raw?.notes || "").trim();

  let commonName = rawName ? CANONICAL_BY_LOWER.get(rawName.toLowerCase()) : undefined;

  if (confidence < 0.7) {
    return {
      Common_Name: "unknown",
      confidence,
      manual_review: true,
      notes,
    };
  }

  if (!commonName) {
    if (group === "mammal") {
      commonName = "other mammal";
    } else if (group === "bird") {
      commonName = "other bird";
    } else if (group === "none") {
      commonName = "No animal";
    } else {
      commonName = "unknown";
    }
  }

  const manualReview = commonName === "unknown";

  return {
    Common_Name: commonName,
    confidence,
    manual_review: manualReview,
    notes,
  };
}

export { ALLOWED_COMMON_NAMES, postProcessAnimalOutput };
