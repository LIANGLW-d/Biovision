import argparse
import csv
import io
import json
import os
import pathlib
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterable
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError, EndpointConnectionError, ReadTimeoutError
from dotenv import load_dotenv
from PIL import Image
from PIL.ExifTags import TAGS

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}

CLASSIFY_PROMPT = (
    "You are a wildlife expert. Decide whether the image contains a beaver.\n"
    "IMPORTANT: - Many beavers are partially occluded, far away, or only show tails, "
    "silhouettes, or water disturbance.\n"
    "If there is ANY reasonable visual evidence of a beaver, classify as beaver.\n"
    "Return STRICT JSON only:\n"
    '{"is_beaver": true/false, "confidence": 0-1, "reason": "short"}'
)

BASIC_ANIMAL_PROMPT = """
You are a wildlife image classification assistant.

Task:
Decide whether there is ANY animal in the image.
If there is an animal, identify the most likely species.
If the animal cannot be confidently identified, respond with "unknown".

Animal definition:
- Any real animal (mammal, bird, reptile, amphibian)
- Can be partial, far away, blurred, low-light, silhouette

Rules:
- If there is ANY reasonable evidence of an animal, answer YES.
- If uncertain, lean toward YES.
- Do NOT count logs, rocks, shadows, plants, or water ripples.
- Do NOT guess species if there is no clear visual evidence.

Return STRICT JSON only:
{
  "has_animal": true or false,
  "animal_type": "beaver | raccoon | deer | otter | bird | unknown | none",
  "confidence": 0-1,
  "reason": "short"
}

Output MUST start with { and end with } and contain nothing else.
""".strip()

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

OVERLAY_LOCATION_PROMPT_TEMPLATE = """
You read trail camera overlays. Extract the site/location code from the overlay text.

{allowed_codes_line}

Return STRICT JSON only:
{{
  "location_code": "<exact code from overlay or 'unknown'>",
  "confidence": 0-1,
  "reason": "short"
}}

Output MUST start with {{ and end with }} and contain nothing else.
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


def build_clients(
    aws_region: str | None,
    aws_profile: str | None,
    s3_region: str | None,
):
    session_kwargs = {}
    if aws_region:
        session_kwargs["region_name"] = aws_region
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile
    session = boto3.Session(**session_kwargs)
    bedrock_client = session.client("bedrock-runtime")
    s3_client = session.client("s3", region_name=s3_region) if s3_region else session.client("s3")
    return bedrock_client, s3_client


def load_image_bytes(image_path: str, s3_client) -> bytes:
    if is_s3_path(image_path):
        parsed = urlparse(image_path)
        obj = s3_client.get_object(Bucket=parsed.netloc, Key=parsed.path.lstrip("/"))
        return obj["Body"].read()
    return pathlib.Path(image_path).read_bytes()


def extract_exif_timestamp(image_bytes: bytes) -> str:
    try:
        image = Image.open(io.BytesIO(image_bytes))
        exif = image.getexif()
        if not exif:
            return ""
        exif_dict = {TAGS.get(tag_id, tag_id): value for tag_id, value in exif.items()}
        return (
            exif_dict.get("DateTimeOriginal")
            or exif_dict.get("DateTimeDigitized")
            or exif_dict.get("DateTime")
            or ""
        )
    except Exception:
        return ""


def _to_float(value) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _gps_coord_to_decimal(coord, ref: str | None) -> float | None:
    try:
        degrees = _to_float(coord[0])
        minutes = _to_float(coord[1])
        seconds = _to_float(coord[2])
        if degrees is None or minutes is None or seconds is None:
            return None
        decimal = degrees + minutes / 60.0 + seconds / 3600.0
        if ref in {"S", "W"}:
            decimal *= -1
        return decimal
    except Exception:
        return None


def extract_exif_location(image_bytes: bytes) -> str:
    try:
        image = Image.open(io.BytesIO(image_bytes))
        exif = image.getexif()
        if not exif:
            return ""
        exif_dict = {TAGS.get(tag_id, tag_id): value for tag_id, value in exif.items()}
        gps_info = exif_dict.get("GPSInfo")
        if not gps_info:
            return ""
        gps = {TAGS.get(tag_id, tag_id): value for tag_id, value in gps_info.items()}
        lat = _gps_coord_to_decimal(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef"))
        lon = _gps_coord_to_decimal(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef"))
        if lat is None or lon is None:
            return ""
        return f"{lat:.6f},{lon:.6f}"
    except Exception:
        return ""


def load_exif_timestamp(image_path: str, s3_client) -> str:
    return extract_exif_timestamp(load_image_bytes(image_path, s3_client))


def load_exif_location(image_path: str, s3_client) -> str:
    return extract_exif_location(load_image_bytes(image_path, s3_client))


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
    max_retries = int(env_default("BEAVER_BEDROCK_MAX_RETRIES", "3"))
    backoff_base = float(env_default("BEAVER_BEDROCK_BACKOFF_BASE", "1.0"))
    backoff_max = float(env_default("BEAVER_BEDROCK_BACKOFF_MAX", "10.0"))

    for attempt in range(max_retries + 1):
        try:
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
        except (EndpointConnectionError, ReadTimeoutError) as exc:
            if attempt >= max_retries:
                raise exc
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            retryable = code in {
                "ThrottlingException",
                "TooManyRequestsException",
                "ServiceQuotaExceededException",
                "RequestTimeoutException",
            }
            if not retryable or attempt >= max_retries:
                raise exc

        delay = min(backoff_max, backoff_base * (2**attempt)) + random.uniform(0, 0.5)
        time.sleep(delay)

    raise RuntimeError("Bedrock request failed after retries.")


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


def detect_animal(
    image_path: str,
    bedrock_client,
    s3_client,
    model_id: str,
    max_dim: int,
) -> dict:
    raw = load_image_bytes(image_path, s3_client)
    jpeg_bytes = shrink_to_jpeg_under_5mb(raw, max_dim=max_dim)
    return call_bedrock(
        bedrock_client,
        model_id,
        jpeg_bytes,
        prompt=BASIC_ANIMAL_PROMPT,
        max_tokens=200,
    )


def detect_overlay_location(
    image_path: str,
    bedrock_client,
    s3_client,
    model_id: str,
    max_dim: int,
    allowed_codes: list[str],
) -> dict:
    raw = load_image_bytes(image_path, s3_client)
    jpeg_bytes = shrink_to_jpeg_under_5mb(raw, max_dim=max_dim)
    if allowed_codes:
        allowed_line = f"Allowed codes: {', '.join(allowed_codes)}"
    else:
        allowed_line = (
            "Return the full code as shown in the overlay (letters/numbers/underscore)."
        )
    prompt = OVERLAY_LOCATION_PROMPT_TEMPLATE.format(allowed_codes_line=allowed_line)
    return call_bedrock(
        bedrock_client,
        model_id,
        jpeg_bytes,
        prompt=prompt,
        max_tokens=150,
    )


def normalize_row(
    image_path: str,
    beaver_data: dict,
    model_id: str,
    animal_data: dict | None = None,
    overlay_data: dict | None = None,
) -> dict:
    bbox = beaver_data.get("bbox")
    return {
        "image_path": image_path,
        "has_beaver": (
            bool(beaver_data.get("is_beaver")) if "is_beaver" in beaver_data else ""
        ),
        "confidence": beaver_data.get("confidence", ""),
        "reason": beaver_data.get("reason", ""),
        "bbox": json.dumps(bbox) if bbox is not None else "",
        "has_animal": (
            bool(animal_data.get("has_animal")) if animal_data and "has_animal" in animal_data else ""
        ),
        "animal_type": animal_data.get("animal_type", "") if animal_data else "",
        "animal_confidence": animal_data.get("confidence", "") if animal_data else "",
        "animal_reason": animal_data.get("reason", "") if animal_data else "",
        "overlay_location": overlay_data.get("location_code", "") if overlay_data else "",
        "overlay_confidence": overlay_data.get("confidence", "") if overlay_data else "",
        "overlay_reason": overlay_data.get("reason", "") if overlay_data else "",
        "model_id": model_id,
        "exif_timestamp": "",
        "exif_location": "",
        "error": "",
    }


def error_row(image_path: str, model_id: str, error: Exception) -> dict:
    return {
        "image_path": image_path,
        "has_beaver": "",
        "confidence": "",
        "reason": "",
        "bbox": "",
        "has_animal": "",
        "animal_type": "",
        "animal_confidence": "",
        "animal_reason": "",
        "overlay_location": "",
        "overlay_confidence": "",
        "overlay_reason": "",
        "model_id": model_id,
        "exif_timestamp": "",
        "exif_location": "",
        "error": str(error),
    }


def write_csv(rows: Iterable[dict], output_path: pathlib.Path) -> None:
    fieldnames = [
        "image_path",
        "has_beaver",
        "confidence",
        "reason",
        "bbox",
        "has_animal",
        "animal_type",
        "animal_confidence",
        "animal_reason",
        "overlay_location",
        "overlay_confidence",
        "overlay_reason",
        "model_id",
        "exif_timestamp",
        "exif_location",
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
        "--run-animal",
        action="store_true",
        default=env_default("BEAVER_RUN_ANIMAL", "true").lower() in {"1", "true", "yes"},
        help="Run animal detection before beaver detection.",
    )
    parser.add_argument(
        "--animal-model-id",
        default=env_default(
            "BEAVER_ANIMAL_MODEL_ID",
            env_default(
                "BEAVER_MODEL_ID",
                env_default("BEDROCK_MODEL_ID", "anthropic.claude-opus-4-5-20251101-v1:0"),
            ),
        ),
        help="Bedrock modelId or inference profile ARN for animal detection.",
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
        "--print-exif",
        action="store_true",
        help="Print EXIF timestamp for each image (if present).",
    )
    parser.add_argument(
        "--overlay-location",
        action="store_true",
        help="Use Bedrock vision to extract overlay location code and print it.",
    )
    parser.add_argument(
        "--overlay-to-csv",
        action="store_true",
        help="Include overlay location code in CSV output (if present).",
    )
    parser.add_argument(
        "--overlay-codes",
        default=env_default("BEAVER_OVERLAY_CODES", ""),
        help="Comma-separated overlay location codes to allow (e.g., BT_,EBN_D0).",
    )
    parser.add_argument(
        "--exif-to-csv",
        action="store_true",
        help="Include EXIF timestamp in CSV output (if present).",
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
    parser.add_argument(
        "--s3-region",
        default=env_default("S3_REGION"),
        help="AWS region for S3 reads (e.g. us-west-2).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    limit = None if args.limit == 0 else args.limit
    overlay_codes = [code.strip() for code in args.overlay_codes.split(",") if code.strip()]

    bedrock_client, s3_client = build_clients(
        args.aws_region,
        args.aws_profile,
        args.s3_region,
    )
    image_paths = list(iter_input_images(args.input, s3_client, limit))
    if not image_paths:
        raise SystemExit("No images found for input.")

    def _run(path: str) -> dict:
        exif_timestamp = ""
        exif_location = ""
        overlay_data = None
        if args.print_exif:
            timestamp = load_exif_timestamp(path, s3_client)
            label = timestamp if timestamp else "unknown"
            exif_location = load_exif_location(path, s3_client)
            location_label = exif_location if exif_location else "unknown"
            print(f"EXIF timestamp: {label} | EXIF location: {location_label} | {path}")
            exif_timestamp = timestamp
        elif args.exif_to_csv:
            exif_timestamp = load_exif_timestamp(path, s3_client)
            exif_location = load_exif_location(path, s3_client)
        if args.overlay_location or args.overlay_to_csv:
            overlay_data = detect_overlay_location(
                path,
                bedrock_client,
                s3_client,
                args.model_id,
                args.max_dim,
                overlay_codes,
            )
            if args.overlay_location:
                location = overlay_data.get("location_code", "unknown")
                print(f"Overlay location: {location} | {path}")
        animal_data = None
        if args.run_animal:
            animal_data = detect_animal(
                path,
                bedrock_client,
                s3_client,
                args.animal_model_id,
                args.max_dim,
            )
        data = detect_beaver(
            path,
            bedrock_client,
            s3_client,
            args.model_id,
            args.task,
            args.max_dim,
        )
        row = normalize_row(path, data, args.model_id, animal_data, overlay_data)
        row["exif_timestamp"] = exif_timestamp
        row["exif_location"] = exif_location
        return row

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
