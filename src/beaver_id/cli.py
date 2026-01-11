import argparse
import csv
import io
import json
import os
import pathlib
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterable
from urllib.parse import urlparse

import boto3
from dotenv import load_dotenv
from PIL import Image

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}

CLASSIFY_PROMPT = (
    "You are a wildlife expert. Decide whether the image contains a beaver.\n"
    "IMPORTANT: - Many beavers are partially occluded, far away, or only show tails, "
    "silhouettes, or water disturbance.\n"
    "If there is ANY reasonable visual evidence of a beaver, classify as beaver.\n"
    "Return STRICT JSON only:\n"
    '{"is_beaver": true/false, "confidence": 0-1, "reason": "short"}'
)

BBOX_PROMPT = """
You are a wildlife vision annotator.

Task:
1) Decide if there is a beaver in the image.
2) If yes, output ONE bounding box that tightly encloses the most visible beaver.

Return STRICT JSON only:
{
  "is_beaver": true/false,
  "confidence": 0-1,
  "bbox": [x1, y1, x2, y2]  // normalized 0-1 coordinates, top-left (x1,y1) to bottom-right (x2,y2)
}
Output MUST start with "{" and end with "}" and contain nothing else.

Rules:
- If no beaver, set bbox to null.
- Coordinates must be within [0,1].
""".strip()


def env_default(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value:
        return value
    return default


def iter_local_image_paths(input_path: pathlib.Path) -> Iterable[pathlib.Path]:
    if input_path.is_file():
        yield input_path
        return

    for path in sorted(input_path.rglob("*")):
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
            yield path


def is_s3_path(path: str) -> bool:
    return path.startswith("s3://")


def list_s3_images(s3_client, bucket: str, prefix: str, limit: int | None) -> Iterable[str]:
    paginator = s3_client.get_paginator("list_objects_v2")
    count = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if pathlib.Path(key).suffix.lower() in IMAGE_EXTENSIONS:
                yield f"s3://{bucket}/{key}"
                count += 1
                if limit is not None and count >= limit:
                    return


def iter_input_images(input_value: str, s3_client, limit: int | None) -> Iterable[str]:
    if is_s3_path(input_value):
        parsed = urlparse(input_value)
        bucket = parsed.netloc
        key = parsed.path.lstrip("/")
        if pathlib.Path(key).suffix.lower() in IMAGE_EXTENSIONS:
            yield input_value
            return
        yield from list_s3_images(s3_client, bucket, key, limit)
        return

    path = pathlib.Path(input_value)
    if not path.exists():
        raise FileNotFoundError(f"Input path not found: {path}")

    for file_path in iter_local_image_paths(path):
        yield str(file_path)


def build_clients(aws_region: str | None, aws_profile: str | None):
    session_kwargs = {}
    if aws_region:
        session_kwargs["region_name"] = aws_region
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile
    session = boto3.Session(**session_kwargs)
    return session.client("bedrock-runtime"), session.client("s3")


def load_image_bytes(image_path: str, s3_client) -> bytes:
    if is_s3_path(image_path):
        parsed = urlparse(image_path)
        obj = s3_client.get_object(Bucket=parsed.netloc, Key=parsed.path.lstrip("/"))
        return obj["Body"].read()
    return pathlib.Path(image_path).read_bytes()


def shrink_to_jpeg_under_5mb(img_bytes: bytes, max_dim: int) -> bytes:
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    img.thumbnail((max_dim, max_dim))

    quality = 90
    while True:
        buf = io.BytesIO()
        img.save(
            buf,
            format="JPEG",
            quality=quality,
            optimize=True,
            progressive=False,
        )
        out = buf.getvalue()
        if len(out) <= 5 * 1024 * 1024 or quality <= 40:
            return out
        quality -= 10


def extract_json_object(text: str) -> dict:
    if not text:
        raise ValueError("Empty model output")

    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError(f"No JSON object found in model output: {text[:200]!r}")

    return json.loads(match.group(0))


def call_bedrock(
    bedrock_client,
    model_id: str,
    jpeg_bytes: bytes,
    prompt: str,
    max_tokens: int,
) -> dict:
    resp = bedrock_client.converse(
        modelId=model_id,
        messages=[
            {
                "role": "user",
                "content": [
                    {"image": {"format": "jpeg", "source": {"bytes": jpeg_bytes}}},
                    {"text": prompt},
                ],
            }
        ],
        inferenceConfig={"temperature": 0.0, "maxTokens": max_tokens},
    )
    text = resp["output"]["message"]["content"][0]["text"].strip()
    return extract_json_object(text)


def detect_beaver(
    image_path: str,
    bedrock_client,
    s3_client,
    model_id: str,
    task: str,
    max_dim: int,
) -> dict:
    raw = load_image_bytes(image_path, s3_client)
    jpeg_bytes = shrink_to_jpeg_under_5mb(raw, max_dim=max_dim)

    if task == "bbox":
        data = call_bedrock(
            bedrock_client,
            model_id,
            jpeg_bytes,
            prompt=BBOX_PROMPT,
            max_tokens=300,
        )
    else:
        data = call_bedrock(
            bedrock_client,
            model_id,
            jpeg_bytes,
            prompt=CLASSIFY_PROMPT,
            max_tokens=200,
        )

    return data


def normalize_row(image_path: str, data: dict, model_id: str) -> dict:
    bbox = data.get("bbox")
    return {
        "image_path": image_path,
        "has_beaver": bool(data.get("is_beaver")) if "is_beaver" in data else "",
        "confidence": data.get("confidence", ""),
        "reason": data.get("reason", ""),
        "bbox": json.dumps(bbox) if bbox is not None else "",
        "model_id": model_id,
        "error": "",
    }


def error_row(image_path: str, model_id: str, error: Exception) -> dict:
    return {
        "image_path": image_path,
        "has_beaver": "",
        "confidence": "",
        "reason": "",
        "bbox": "",
        "model_id": model_id,
        "error": str(error),
    }


def write_csv(rows: Iterable[dict], output_path: pathlib.Path) -> None:
    fieldnames = [
        "image_path",
        "has_beaver",
        "confidence",
        "reason",
        "bbox",
        "model_id",
        "error",
    ]
    with output_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def parse_args() -> argparse.Namespace:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description="Batch beaver detection over images using AWS Bedrock.",
    )
    parser.add_argument(
        "input",
        help="Local file/dir or s3://bucket/key-or-prefix.",
    )
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        default=pathlib.Path(env_default("BEAVER_OUTPUT", "beaver_results.csv")),
        help="Output CSV path (default: beaver_results.csv).",
    )
    parser.add_argument(
        "--model-id",
        default=env_default(
            "BEAVER_BEDROCK_MODEL_ID",
            env_default(
                "BEAVER_MODEL_ID",
                env_default("BEDROCK_MODEL_ID", "anthropic.claude-opus-4-5-20251101-v1:0"),
            ),
        ),
        help="Bedrock modelId or inference profile ARN.",
    )
    parser.add_argument(
        "--task",
        choices=("classify", "bbox"),
        default=env_default("BEAVER_TASK", "classify"),
        help="Inference task to run (classify or bbox).",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=int(env_default("BEAVER_MAX_WORKERS", "4")),
        help="Concurrent workers for batch inference.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=int(env_default("BEAVER_LIMIT", "0")),
        help="Optional limit for S3 prefix enumeration (0 = no limit).",
    )
    parser.add_argument(
        "--max-dim",
        type=int,
        default=int(env_default("BEAVER_MAX_DIM", "2048")),
        help="Max dimension for resize before JPEG compression.",
    )
    parser.add_argument(
        "--aws-region",
        default=env_default("AWS_REGION"),
        help="AWS region for Bedrock calls (e.g. us-east-2).",
    )
    parser.add_argument(
        "--aws-profile",
        default=env_default("AWS_PROFILE"),
        help="AWS profile for credentials (e.g. default).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    limit = None if args.limit == 0 else args.limit

    bedrock_client, s3_client = build_clients(args.aws_region, args.aws_profile)
    image_paths = list(iter_input_images(args.input, s3_client, limit))
    if not image_paths:
        raise SystemExit("No images found for input.")

    def _run(path: str) -> dict:
        data = detect_beaver(
            path,
            bedrock_client,
            s3_client,
            args.model_id,
            args.task,
            args.max_dim,
        )
        return normalize_row(path, data, args.model_id)

    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        futures = {executor.submit(_run, path): path for path in image_paths}
        for future in as_completed(futures):
            path = futures[future]
            try:
                rows.append(future.result())
            except Exception as exc:
                rows.append(error_row(path, args.model_id, exc))

    rows.sort(key=lambda row: row["image_path"])
    write_csv(rows, args.output)
    print(f"Wrote results to {args.output}")


if __name__ == "__main__":
    main()
