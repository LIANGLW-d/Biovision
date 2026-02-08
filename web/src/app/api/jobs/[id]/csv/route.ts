export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { resolveBeaverApiBase } from "@/lib/beaverApiBase";
import { parse } from "csv-parse/sync";

type SequenceConfig = {
  enabled: boolean;
  gapSeconds: number;
  lowConf: number;
  highConf: number;
  speciesMargin: number;
};

function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readSequenceConfig(req: Request): SequenceConfig {
  const url = new URL(req.url);
  const enabledParam = url.searchParams.get("sequence");
  const enabled = enabledParam == null ? true : enabledParam !== "0";

  const gapSeconds = clampNumber(
    Number(url.searchParams.get("sequenceGapSeconds") ?? "6"),
    1,
    30,
  );
  const lowConf = clampNumber(
    Number(url.searchParams.get("sequenceLowConf") ?? "0.6"),
    0,
    1,
  );
  const highConf = clampNumber(
    Number(url.searchParams.get("sequenceHighConf") ?? "0.8"),
    0,
    1,
  );
  const speciesMargin = clampNumber(
    Number(url.searchParams.get("sequenceSpeciesMargin") ?? "0.25"),
    0,
    10,
  );

  return { enabled, gapSeconds, lowConf, highConf, speciesMargin };
}

function parseBool(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text);
  if (!Number.isFinite(num)) return null;
  return num;
}

function parseExifTimestampToMs(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  // EXIF commonly: "YYYY:MM:DD HH:MM:SS"
  const m = text.match(
    /^(\d{4})[:\/-](\d{2})[:\/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/,
  );
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6]);
  if (![y, mo, d, hh, mm, ss].every(Number.isFinite)) return null;

  // We only care about relative gaps, so treating it as UTC is fine.
  return Date.UTC(y, mo - 1, d, hh, mm, ss);
}

function slug(value: string, maxLen: number = 48) {
  const cleaned = (value || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "unknown").slice(0, maxLen);
}

type Vote = {
  hasAnimal: boolean;
  species: string;
  confidence: number;
  explicitNegative: boolean;
};

function voteForRow(row: Record<string, unknown>): Vote | null {
  const hasBeaver = parseBool(row.has_beaver);
  if (hasBeaver === true) {
    return {
      hasAnimal: true,
      species: "Beaver",
      confidence: parseNumber(row.confidence) ?? 0,
      explicitNegative: false,
    };
  }

  const hasAnimal = parseBool(row.has_animal);
  const animalType = String(row.animal_type ?? "").trim();
  const animalGroup = String(row.animal_group ?? "").trim();

  // Prefer explicit animal_type if present (job CSVs sometimes omit has_animal).
  if (animalType) {
    if (animalType === "No animal") {
      return {
        hasAnimal: false,
        species: "none",
        confidence: 0,
        explicitNegative: true,
      };
    }
    return {
      hasAnimal: true,
      species: animalType,
      confidence: parseNumber(row.animal_confidence) ?? 0,
      explicitNegative: false,
    };
  }

  if (hasAnimal === true) {
    const species = animalGroup || "animal";
    return {
      hasAnimal: true,
      species,
      confidence: parseNumber(row.animal_confidence) ?? 0,
      explicitNegative: false,
    };
  }

  // Important: has_beaver=false does NOT mean "no animal", only "not beaver".
  if (hasAnimal === false) {
    return {
      hasAnimal: false,
      species: "none",
      confidence: 0,
      explicitNegative: true,
    };
  }

  return null;
}

function escapeCsv(value: unknown) {
  const text = value == null ? "" : String(value);
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function parseCsvWithHeaders(csvText: string): {
  headers: string[];
  records: Record<string, unknown>[];
} {
  const headerRows = parse(csvText, { to_line: 1, relax_column_count: true }) as string[][];
  const headers = (headerRows[0] ?? []).map((h, idx) => {
    const text = String(h);
    return idx === 0 ? text.replace(/^\uFEFF/, "") : text;
  });
  const records = parse(csvText, {
    columns: headers,
    from_line: 2,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as Record<string, unknown>[];
  return { headers, records };
}

function buildCsv(headers: string[], records: Record<string, unknown>[]) {
  const lines: string[] = [];
  lines.push(headers.map(escapeCsv).join(","));
  for (const record of records) {
    lines.push(headers.map((h) => escapeCsv(record[h])).join(","));
  }
  return lines.join("\n");
}

function applySequenceAggregation(
  headers: string[],
  records: Record<string, unknown>[],
  config: SequenceConfig,
) {
  if (!config.enabled) return { headers, records };

  const extraHeaders = [
    "sequence_id",
    "sequence_size",
    "sequence_presence",
    "sequence_species",
    "sequence_species_score",
    "sequence_disagreement",
    "sequence_flag_manual_review",
    "sequence_reason",
    "sequence_group_key",
    "sequence_start_ts",
  ];
  for (const h of extraHeaders) {
    if (!headers.includes(h)) headers.push(h);
  }

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of records) {
    const groupKeyRaw =
      String(r.overlay_location ?? "").trim() ||
      String(r.exif_location ?? "").trim() ||
      "unknown";
    const groupKey = groupKeyRaw || "unknown";
    const list = groups.get(groupKey) ?? [];
    list.push(r);
    groups.set(groupKey, list);
  }

  for (const [groupKey, groupRecords] of groups.entries()) {
    groupRecords.sort((a, b) => {
      const ta = parseExifTimestampToMs(a.exif_timestamp);
      const tb = parseExifTimestampToMs(b.exif_timestamp);
      if (ta == null && tb == null) return String(a.image_path ?? "").localeCompare(String(b.image_path ?? ""));
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    });

    const sequences: Record<string, unknown>[][] = [];
    let current: Record<string, unknown>[] = [];
    let lastTs: number | null = null;

    for (const r of groupRecords) {
      const ts = parseExifTimestampToMs(r.exif_timestamp);
      if (ts == null) {
        if (current.length) sequences.push(current);
        current = [];
        lastTs = null;
        sequences.push([r]);
        continue;
      }

      if (lastTs == null) {
        current = [r];
        lastTs = ts;
        continue;
      }

      if (ts - lastTs > config.gapSeconds * 1000) {
        sequences.push(current);
        current = [r];
      } else {
        current.push(r);
      }
      lastTs = ts;
    }
    if (current.length) sequences.push(current);

    for (let i = 0; i < sequences.length; i++) {
      const seq = sequences[i]!;
      const seqIndex = i + 1;
      const startTsRaw = String(seq[0]?.exif_timestamp ?? "").trim();
      const startMs = parseExifTimestampToMs(startTsRaw);
      const startId =
        startMs == null
          ? "no_ts"
          : new Date(startMs).toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "_");
      const seqId = `${slug(groupKey)}_${startId}_${seqIndex}`;

      const votes = seq.map(voteForRow);
      const positive = votes
        .filter((v): v is Vote => Boolean(v && v.hasAnimal))
        .filter((v) => v.confidence >= config.lowConf);
      const explicitNegative = votes.some((v) => v?.explicitNegative);

      let presence: "present" | "possible" | "absent" | "unknown" = "unknown";
      let flagManual = false;
      const reasons: string[] = [];

      if (positive.length >= 2) {
        presence = "present";
      } else if (positive.length === 1) {
        if (positive[0]!.confidence >= config.highConf) {
          presence = "present";
        } else {
          presence = "possible";
          flagManual = true;
          reasons.push("single_frame_medium_confidence");
        }
      } else {
        if (explicitNegative) {
          presence = "absent";
        } else {
          presence = "unknown";
          flagManual = true;
          reasons.push("missing_or_low_confidence");
        }
      }

      const speciesScores = new Map<string, number>();
      for (const v of positive) {
        speciesScores.set(v.species, (speciesScores.get(v.species) ?? 0) + v.confidence);
      }

      let seqSpecies = "unknown";
      let seqSpeciesScore = 0;
      if (speciesScores.size === 0) {
        seqSpecies = presence === "absent" ? "none" : "unknown";
      } else {
        const ranked = [...speciesScores.entries()].sort((a, b) => b[1] - a[1]);
        const [bestSpecies, bestScore] = ranked[0]!;
        const secondScore = ranked[1]?.[1] ?? 0;
        seqSpecies = bestSpecies;
        seqSpeciesScore = bestScore;
        if (ranked.length > 1 && bestScore - secondScore < config.speciesMargin) {
          seqSpecies = "unknown";
          flagManual = true;
          reasons.push("species_conflict");
        }
      }

      const disagreement = new Set(positive.map((v) => v.species)).size > 1;

      // If any frame couldn't be voted on (missing fields), lean towards review.
      if (votes.some((v) => v == null)) {
        flagManual = true;
        reasons.push("missing_votes");
      }
      if (!startMs) {
        flagManual = true;
        reasons.push("missing_timestamp");
      }

      for (const r of seq) {
        r.sequence_id = seqId;
        r.sequence_size = seq.length;
        r.sequence_presence = presence;
        r.sequence_species = seqSpecies;
        r.sequence_species_score = Math.round(seqSpeciesScore * 10000) / 10000;
        r.sequence_disagreement = disagreement;
        r.sequence_flag_manual_review = flagManual;
        r.sequence_reason = reasons.join(",");
        r.sequence_group_key = groupKey;
        r.sequence_start_ts = startTsRaw;
      }
    }
  }

  return { headers, records };
}

function pickForwardHeaders(response: Response, id: string) {
  const forward = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) forward.set("content-type", contentType);

  const disposition = response.headers.get("content-disposition");
  forward.set(
    "content-disposition",
    disposition || `attachment; filename=\"job_${id}.csv\"`,
  );

  const errType = response.headers.get("x-amzn-errortype");
  if (errType) forward.set("x-amzn-errortype", errType);
  const reqId = response.headers.get("x-amzn-requestid");
  if (reqId) forward.set("x-amzn-requestid", reqId);

  return forward;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const base = resolveBeaverApiBase().value;
    const url = new URL(`/api/jobs/${id}/csv`, base);
    const response = await fetch(url);
    const forwardHeaders = pickForwardHeaders(response, id);

    // If upstream is erroring, forward the payload unchanged.
    if (!response.ok) {
      const buffer = await response.arrayBuffer();
      return new Response(buffer, {
        status: response.status,
        headers: forwardHeaders,
      });
    }

    const csvText = await response.text();
    const { headers, records } = parseCsvWithHeaders(csvText);
    const config = readSequenceConfig(req);
    const aggregated = applySequenceAggregation(headers, records, config);
    const out = buildCsv(aggregated.headers, aggregated.records);

    // Always return CSV, regardless of upstream content-type.
    forwardHeaders.set("content-type", "text/csv; charset=utf-8");
    return new Response(out, { status: 200, headers: forwardHeaders });
  } catch (error) {
    console.error("Job CSV API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
