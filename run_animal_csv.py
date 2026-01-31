import ast
import csv
import datetime
import pathlib
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed

SOURCE_PATH = pathlib.Path("/Users/qiongran.h/Downloads/animal-agent (2).py")
BUCKET = "training-data2-727117753557-us-west-2"
PREFIX = "training-data2-images/"
MAX_WORKERS = 4
timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
OUTPUT_CSV = pathlib.Path(f"/Users/qiongran.h/Downloads/animal_labels_{timestamp}.csv")

source = SOURCE_PATH.read_text()
module = ast.parse(source)
keep = []
for node in module.body:
    if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef)):
        keep.append(node)
module.body = keep
code = compile(module, filename=str(SOURCE_PATH), mode="exec")
ns = {}
exec(code, ns)

ns["bedrock"] = boto3.client("bedrock-runtime", region_name="us-east-2")
ns["s3"] = boto3.client("s3")
ns["INFERENCE_PROFILE_ARN"] = (
    "arn:aws:bedrock:us-east-2:727117753557:"
    "inference-profile/us.anthropic.claude-opus-4-5-20251101-v1:0"
)

list_s3_images = ns["list_s3_images"]
has_animal_agent = ns["has_animal_agent"]

image_paths = list(list_s3_images(BUCKET, PREFIX, limit=None))
total = len(image_paths)

print(f"Start scanning {total} images from s3://{BUCKET}/{PREFIX}")

rows = []
errors = 0

with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
    futures = {pool.submit(has_animal_agent, p): p for p in image_paths}
    done = 0
    for fut in as_completed(futures):
        path = futures[fut]
        done += 1
        filename = path.split("/")[-1]
        try:
            r = fut.result()
            rows.append(
                {
                    "filename": filename,
                    "s3_uri": path,
                    "has_animal": r.get("has_animal"),
                    "animal_type": r.get("animal_type"),
                    "confidence": r.get("confidence"),
                    "reason": r.get("reason"),
                    "error": "",
                }
            )
        except Exception as exc:
            errors += 1
            rows.append(
                {
                    "filename": filename,
                    "s3_uri": path,
                    "has_animal": "",
                    "animal_type": "",
                    "confidence": "",
                    "reason": "",
                    "error": str(exc),
                }
            )

        if done % 50 == 0 or done == total:
            print(f"Progress {done}/{total} | errors={errors}")

rows.sort(key=lambda row: row["filename"])
OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)

with OUTPUT_CSV.open("w", newline="") as handle:
    writer = csv.DictWriter(
        handle,
        fieldnames=[
            "filename",
            "s3_uri",
            "has_animal",
            "animal_type",
            "confidence",
            "reason",
            "error",
        ],
    )
    writer.writeheader()
    for row in rows:
        writer.writerow(row)

print("\nRESULT")
print(f"Total images: {total}")
print(f"Errors: {errors}")
print(f"CSV written to: {OUTPUT_CSV}")
