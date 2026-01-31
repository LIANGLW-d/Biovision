import ast
import pathlib
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed

SOURCE_PATH = pathlib.Path("/Users/qiongran.h/Downloads/animal-agent (2).py")
BUCKET = "training-data2-727117753557-us-west-2"
PREFIX = "training-data2-images/"
MAX_WORKERS = 4

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

detected = 0
errors = 0

with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
    futures = {pool.submit(has_animal_agent, p): p for p in image_paths}
    done = 0
    for fut in as_completed(futures):
        done += 1
        try:
            r = fut.result()
            if r.get("has_animal"):
                detected += 1
        except Exception:
            errors += 1
        if done % 50 == 0 or done == total:
            print(f"Progress {done}/{total} | detected={detected} | errors={errors}")

print("\nRESULT")
print(f"Total images: {total}")
print(f"Images with animal: {detected}")
print(f"Errors: {errors}")
