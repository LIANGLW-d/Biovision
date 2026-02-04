import { parse } from "csv-parse/sync";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { postProcessAnimalOutput } from "@/lib/animalPostProcess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CsvRow = Record<string, string>;

function parseBool(value: string | undefined) {
  if (!value) return false;
  return value.toLowerCase() === "true";
}

function safeJoin(root: string, filePath: string) {
  const normalized = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(root, normalized);
}

async function runBeaverCli(inputPath: string, outputPath: string) {
  const repoRoot = path.resolve(process.cwd(), "..");
  const python = process.env.BEAVER_PYTHON || "python3";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      python,
      ["-m", "beaver_id.cli", inputPath, "--output", outputPath],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PYTHONPATH: repoRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
        reject(new Error(`beaver-id exited with code ${code}${suffix}`));
      }
    });
  });
}

function rowToResult(row: CsvRow, index: number) {
  const hasBeaver = parseBool(row.has_beaver);
  const hasAnimal = parseBool(row.has_animal);
  const animalType = (row.animal_type || "").toLowerCase();
  const predicted_label = hasBeaver
    ? "beaver"
    : animalType && animalType !== "none"
      ? "other_animal"
      : hasAnimal
        ? "other_animal"
        : "no_animal";

  const confidence = row.confidence ? Number(row.confidence) : 0;
  const animalPost = postProcessAnimalOutput({
    common_name: row.animal_type,
    confidence: row.animal_confidence,
    group: row.animal_group,
    notes: row.animal_reason,
  });

  return {
    id: `row_${index}`,
    image_path: row.image_path || "",
    filename: path.basename(row.image_path || ""),
    predicted_label,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: row.reason || "",
    review_label: predicted_label,
    was_corrected: false,
    notes: "",
    model_id: row.model_id || "",
    has_beaver: hasBeaver,
    has_animal: hasAnimal,
    Common_Name: animalPost.Common_Name,
    manual_review: animalPost.manual_review,
    animal_type: animalPost.Common_Name,
    animal_group: row.animal_group || "",
    animal_confidence: animalPost.confidence,
    animal_reason: animalPost.notes,
    bbox: row.bbox || "",
    overlay_location: row.overlay_location || "",
    overlay_confidence: row.overlay_confidence || "",
    overlay_reason: row.overlay_reason || "",
    exif_timestamp: row.exif_timestamp || "",
    exif_location: row.exif_location || "",
    error: row.error || "",
  };
}

export async function POST(req: Request) {
  let tempDir: string | null = null;
  try {
    const formData = await req.formData();
    const s3Path = String(formData.get("s3Path") || "").trim();
    const files = formData.getAll("files").filter((f) => f instanceof File) as File[];

    if (!s3Path && files.length === 0) {
      return new Response(JSON.stringify({ error: "No files or S3 path provided." }), {
        status: 400,
      });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "beaver-upload-"));
    let inputPath = tempDir;

    if (s3Path) {
      inputPath = s3Path;
    } else {
      for (const file of files) {
        const relativePath = (file as File & { webkitRelativePath?: string })
          .webkitRelativePath;
        const name = relativePath && relativePath.length > 0 ? relativePath : file.name;
        const targetPath = safeJoin(tempDir, name);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.writeFile(targetPath, buffer);
      }
    }

    const outputPath = path.join(tempDir, "beaver_results.csv");
    await runBeaverCli(inputPath, outputPath);

    const csvText = await fs.readFile(outputPath, "utf8");
    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as CsvRow[];
    const results = rows.map((row, index) => rowToResult(row, index));

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Beaver run error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
