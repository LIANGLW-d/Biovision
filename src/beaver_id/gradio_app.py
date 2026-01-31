import io
import os
import pathlib
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from typing import Any, Iterable
import time

os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "0")

import boto3
import gradio as gr
from dotenv import load_dotenv
from PIL import Image, ImageDraw

from beaver_id.cli import (
    IMAGE_EXTENSIONS,
    detect_beaver,
    detect_animal,
    detect_overlay_location,
    error_row,
    iter_input_images,
    load_exif_location,
    load_exif_timestamp,
    normalize_row,
    shrink_to_jpeg_under_5mb,
    write_csv,
)


def env_default(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value:
        return value
    return default


@lru_cache(maxsize=4)
def build_clients_cached(
    aws_region: str | None,
    aws_profile: str | None,
    s3_region: str | None,
):
    session_kwargs: dict[str, Any] = {}
    if aws_region:
        session_kwargs["region_name"] = aws_region
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile
    session = boto3.Session(**session_kwargs)
    bedrock_client = session.client("bedrock-runtime")
    s3_client = session.client("s3", region_name=s3_region) if s3_region else session.client("s3")
    return bedrock_client, s3_client


def draw_bbox_on_image(image: Image.Image, bbox: list[float] | None) -> Image.Image:
    if not bbox:
        return image
    w, h = image.size
    x1, y1, x2, y2 = bbox
    x1, y1, x2, y2 = int(x1 * w), int(y1 * h), int(x2 * w), int(y2 * h)
    output = image.copy()
    draw = ImageDraw.Draw(output)
    draw.rectangle([x1, y1, x2, y2], width=4)
    return output


def run_uploaded_image(
    file_path: str | None,
    task: str,
    model_id: str,
    animal_model_id: str,
    overlay_model_id: str,
    overlay_codes: str,
    run_exif: bool,
    aws_region: str | None,
    aws_profile: str | None,
    s3_region: str | None,
    max_dim: int,
    run_animal: bool,
    run_overlay: bool,
):
    if not file_path:
        return {"error": "No image provided."}, None

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile, s3_region)
    image = Image.open(file_path).convert("RGB")
    animal_data = None
    if run_animal:
        animal_data = detect_animal(
            file_path,
            bedrock_client,
            s3_client,
            animal_model_id,
            max_dim,
        )
    overlay_data = None
    if run_overlay:
        codes = [code.strip() for code in overlay_codes.split(",") if code.strip()]
        overlay_data = detect_overlay_location(
            file_path,
            bedrock_client,
            s3_client,
            overlay_model_id,
            max_dim,
            codes,
        )
    exif_timestamp = ""
    exif_location = ""
    if run_exif:
        exif_timestamp = load_exif_timestamp(file_path, s3_client)
        exif_location = load_exif_location(file_path, s3_client)
    data = detect_beaver(
        file_path,
        bedrock_client,
        s3_client,
        model_id,
        task,
        max_dim,
    )

    bbox_image = None
    if task == "bbox":
        bbox_image = draw_bbox_on_image(image, data.get("bbox"))

    row = normalize_row(file_path, data, model_id, animal_data, overlay_data)
    row["exif_timestamp"] = exif_timestamp
    row["exif_location"] = exif_location
    return row, bbox_image


def run_s3_path(
    s3_path: str,
    task: str,
    model_id: str,
    animal_model_id: str,
    overlay_model_id: str,
    overlay_codes: str,
    run_exif: bool,
    aws_region: str | None,
    aws_profile: str | None,
    s3_region: str | None,
    max_dim: int,
    run_animal: bool,
    run_overlay: bool,
):
    if not s3_path:
        return {"error": "No S3 path provided."}, None

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile, s3_region)
    animal_data = None
    if run_animal:
        animal_data = detect_animal(
            s3_path,
            bedrock_client,
            s3_client,
            animal_model_id,
            max_dim,
        )
    overlay_data = None
    if run_overlay:
        codes = [code.strip() for code in overlay_codes.split(",") if code.strip()]
        overlay_data = detect_overlay_location(
            s3_path,
            bedrock_client,
            s3_client,
            overlay_model_id,
            max_dim,
            codes,
        )
    exif_timestamp = ""
    exif_location = ""
    if run_exif:
        exif_timestamp = load_exif_timestamp(s3_path, s3_client)
        exif_location = load_exif_location(s3_path, s3_client)
    data = detect_beaver(s3_path, bedrock_client, s3_client, model_id, task, max_dim)

    preview = None
    if task == "bbox":
        raw = s3_client.get_object(
            Bucket=s3_path.split("/")[2],
            Key="/".join(s3_path.split("/")[3:]),
        )["Body"].read()
        jpeg_bytes = shrink_to_jpeg_under_5mb(raw, max_dim=max_dim)
        image = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB")
        preview = draw_bbox_on_image(image, data.get("bbox"))

    row = normalize_row(s3_path, data, model_id, animal_data, overlay_data)
    row["exif_timestamp"] = exif_timestamp
    row["exif_location"] = exif_location
    return row, preview


def run_batch_upload(
    file_paths: list[str] | None,
    task: str,
    model_id: str,
    animal_model_id: str,
    overlay_model_id: str,
    overlay_codes: str,
    run_exif: bool,
    aws_region: str | None,
    aws_profile: str | None,
    s3_region: str | None,
    max_dim: int,
    max_workers: int,
    batch_size: int,
    batch_pause_sec: float,
    run_animal: bool,
    run_overlay: bool,
):
    if not file_paths:
        return [], None, "No files provided."

    max_workers = max(1, int(max_workers))
    batch_size = max(1, int(batch_size))
    batch_pause_sec = max(0.0, float(batch_pause_sec))

    image_paths = [
        path for path in file_paths if pathlib.Path(path).suffix.lower() in IMAGE_EXTENSIONS
    ]
    if not image_paths:
        return [], None, "No supported image files provided."

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile, s3_region)

    def _run(path: str) -> dict:
        animal_data = None
        if run_animal:
            animal_data = detect_animal(
                path,
                bedrock_client,
                s3_client,
                animal_model_id,
                max_dim,
            )
        overlay_data = None
        if run_overlay:
            codes = [code.strip() for code in overlay_codes.split(",") if code.strip()]
            overlay_data = detect_overlay_location(
                path,
                bedrock_client,
                s3_client,
                overlay_model_id,
                max_dim,
                codes,
            )
        exif_timestamp = ""
        exif_location = ""
        if run_exif:
            exif_timestamp = load_exif_timestamp(path, s3_client)
            exif_location = load_exif_location(path, s3_client)
        data = detect_beaver(path, bedrock_client, s3_client, model_id, task, max_dim)
        row = normalize_row(path, data, model_id, animal_data, overlay_data)
        row["exif_timestamp"] = exif_timestamp
        row["exif_location"] = exif_location
        return row

    def batched(items: list[str], size: int) -> Iterable[list[str]]:
        for i in range(0, len(items), size):
            yield items[i : i + size]

    rows: list[dict] = []
    for batch in batched(image_paths, batch_size):
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(_run, path): path for path in batch}
            for future in as_completed(futures):
                path = futures[future]
                try:
                    rows.append(future.result())
                except Exception as exc:
                    rows.append(error_row(path, model_id, exc))
        if batch_pause_sec:
            time.sleep(batch_pause_sec)

    rows.sort(key=lambda row: row["image_path"])
    beaver_rows = [row for row in rows if row.get("has_beaver") is True]
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as handle:
        output_path = pathlib.Path(handle.name)
    write_csv(rows, output_path)

    return (
        beaver_rows,
        str(output_path),
        f"Processed {len(rows)} images. Beaver detected in {len(beaver_rows)} images.",
    )


def run_s3_batch(
    s3_prefix: str,
    task: str,
    model_id: str,
    animal_model_id: str,
    overlay_model_id: str,
    overlay_codes: str,
    run_exif: bool,
    aws_region: str | None,
    aws_profile: str | None,
    s3_region: str | None,
    max_dim: int,
    max_workers: int,
    limit: int,
    batch_size: int,
    batch_pause_sec: float,
    run_animal: bool,
    run_overlay: bool,
):
    if not s3_prefix:
        return [], None, "No S3 prefix provided."

    max_workers = max(1, int(max_workers))
    batch_size = max(1, int(batch_size))
    batch_pause_sec = max(0.0, float(batch_pause_sec))

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile, s3_region)
    limit_value = None if limit <= 0 else limit
    image_paths = list(iter_input_images(s3_prefix, s3_client, limit_value))
    if not image_paths:
        return [], None, "No images found for prefix."

    def _run(path: str) -> dict:
        animal_data = None
        if run_animal:
            animal_data = detect_animal(
                path,
                bedrock_client,
                s3_client,
                animal_model_id,
                max_dim,
            )
        overlay_data = None
        if run_overlay:
            codes = [code.strip() for code in overlay_codes.split(",") if code.strip()]
            overlay_data = detect_overlay_location(
                path,
                bedrock_client,
                s3_client,
                overlay_model_id,
                max_dim,
                codes,
            )
        exif_timestamp = ""
        exif_location = ""
        if run_exif:
            exif_timestamp = load_exif_timestamp(path, s3_client)
            exif_location = load_exif_location(path, s3_client)
        data = detect_beaver(path, bedrock_client, s3_client, model_id, task, max_dim)
        row = normalize_row(path, data, model_id, animal_data, overlay_data)
        row["exif_timestamp"] = exif_timestamp
        row["exif_location"] = exif_location
        return row

    def batched(items: list[str], size: int) -> Iterable[list[str]]:
        for i in range(0, len(items), size):
            yield items[i : i + size]

    rows: list[dict] = []
    for batch in batched(image_paths, batch_size):
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(_run, path): path for path in batch}
            for future in as_completed(futures):
                path = futures[future]
                try:
                    rows.append(future.result())
                except Exception as exc:
                    rows.append(error_row(path, model_id, exc))
        if batch_pause_sec:
            time.sleep(batch_pause_sec)

    rows.sort(key=lambda row: row["image_path"])
    beaver_rows = [row for row in rows if row.get("has_beaver") is True]
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as handle:
        output_path = pathlib.Path(handle.name)
    write_csv(rows, output_path)

    return (
        beaver_rows,
        str(output_path),
        f"Processed {len(rows)} images. Beaver detected in {len(beaver_rows)} images.",
    )


def build_app() -> gr.Blocks:
    load_dotenv()

    default_region = env_default("AWS_REGION")
    default_profile = env_default("AWS_PROFILE")
    default_model_id = env_default(
        "BEAVER_BEDROCK_MODEL_ID",
        env_default(
            "BEAVER_MODEL_ID",
            env_default("BEDROCK_MODEL_ID", "anthropic.claude-opus-4-5-20251101-v1:0"),
        ),
    )
    default_task = env_default("BEAVER_TASK", "classify")
    default_max_dim = int(env_default("BEAVER_MAX_DIM", "2048"))
    default_batch_size = int(env_default("BEAVER_BATCH_SIZE", "20"))
    default_batch_pause = float(env_default("BEAVER_BATCH_PAUSE_SEC", "0"))
    default_s3_region = env_default("S3_REGION")
    default_run_animal = env_default("BEAVER_RUN_ANIMAL", "true").lower() in {"1", "true", "yes"}
    default_animal_model_id = env_default("BEAVER_ANIMAL_MODEL_ID", default_model_id)
    default_run_overlay = env_default("BEAVER_RUN_OVERLAY", "false").lower() in {"1", "true", "yes"}
    default_overlay_codes = env_default("BEAVER_OVERLAY_CODES", "")
    default_overlay_model_id = env_default("BEAVER_OVERLAY_MODEL_ID", default_model_id)
    default_run_exif = env_default("BEAVER_RUN_EXIF", "false").lower() in {"1", "true", "yes"}

    with gr.Blocks(title="Beaver Detector") as demo:
        gr.Markdown("# Beaver Detector")
        gr.Markdown("Run AWS Bedrock beaver detection on a local image or an S3 object.")

        with gr.Row():
            task = gr.Radio(["classify", "bbox"], value=default_task, label="Task")
            model_id = gr.Textbox(value=default_model_id, label="Bedrock Model ID / ARN")
            run_animal = gr.Checkbox(value=default_run_animal, label="Run Animal Detection")
            run_overlay = gr.Checkbox(value=default_run_overlay, label="Read Overlay Location")
            run_exif = gr.Checkbox(value=default_run_exif, label="Read EXIF")
        animal_model_id = gr.Textbox(
            value=default_animal_model_id,
            label="Animal Model ID / ARN",
        )
        overlay_model_id = gr.Textbox(
            value=default_overlay_model_id,
            label="Overlay Model ID / ARN",
        )
        overlay_codes = gr.Textbox(
            value=default_overlay_codes,
            label="Overlay Allowed Codes (comma-separated, optional)",
        )
        with gr.Row():
            aws_region = gr.Textbox(value=default_region or "", label="AWS Region")
            aws_profile = gr.Textbox(value=default_profile or "", label="AWS Profile")
            s3_region = gr.Textbox(value=default_s3_region or "", label="S3 Region")
            max_dim = gr.Number(value=default_max_dim, label="Max Image Dimension")

        with gr.Tab("Upload Image"):
            upload = gr.File(label="Image File", file_types=["image"])
            run_upload = gr.Button("Run")
            result_json = gr.JSON(label="Result")
            bbox_preview = gr.Image(type="pil", label="BBox Preview")
            run_upload.click(
                run_uploaded_image,
                inputs=[
                    upload,
                    task,
                    model_id,
                    animal_model_id,
                    overlay_model_id,
                    overlay_codes,
                    run_exif,
                    aws_region,
                    aws_profile,
                    s3_region,
                    max_dim,
                    run_animal,
                    run_overlay,
                ],
                outputs=[result_json, bbox_preview],
            )

        with gr.Tab("S3 Path"):
            s3_path = gr.Textbox(
                label="S3 Path",
                placeholder="s3://bucket/key.jpg",
            )
            run_s3 = gr.Button("Run")
            s3_result_json = gr.JSON(label="Result")
            s3_bbox_preview = gr.Image(type="pil", label="BBox Preview")
            run_s3.click(
                run_s3_path,
                inputs=[
                    s3_path,
                    task,
                    model_id,
                    animal_model_id,
                    overlay_model_id,
                    overlay_codes,
                    run_exif,
                    aws_region,
                    aws_profile,
                    s3_region,
                    max_dim,
                    run_animal,
                    run_overlay,
                ],
                outputs=[s3_result_json, s3_bbox_preview],
            )

        with gr.Tab("S3 Batch"):
            s3_prefix = gr.Textbox(
                label="S3 Prefix",
                placeholder="s3://bucket/prefix/",
            )
            s3_limit = gr.Number(value=0, label="Limit (0 = no limit)")
            s3_workers = gr.Number(value=4, label="Max Workers")
            s3_batch_size = gr.Number(value=default_batch_size, label="Batch Size")
            s3_batch_pause = gr.Number(value=default_batch_pause, label="Batch Pause (sec)")
            run_s3_batch_button = gr.Button("Run Batch")
            s3_batch_table = gr.JSON(label="Results")
            s3_batch_csv = gr.File(label="Download CSV")
            s3_batch_status = gr.Textbox(label="Status")
            run_s3_batch_button.click(
                run_s3_batch,
                inputs=[
                    s3_prefix,
                    task,
                    model_id,
                    animal_model_id,
                    overlay_model_id,
                    overlay_codes,
                    run_exif,
                    aws_region,
                    aws_profile,
                    s3_region,
                    max_dim,
                    s3_workers,
                    s3_limit,
                    s3_batch_size,
                    s3_batch_pause,
                    run_animal,
                    run_overlay,
                ],
                outputs=[s3_batch_table, s3_batch_csv, s3_batch_status],
            )

        with gr.Tab("Batch Upload"):
            batch_files = gr.Files(label="Images", file_count="multiple", type="filepath")
            batch_workers = gr.Number(value=4, label="Max Workers")
            batch_size = gr.Number(value=default_batch_size, label="Batch Size")
            batch_pause = gr.Number(value=default_batch_pause, label="Batch Pause (sec)")
            run_batch = gr.Button("Run Batch")
            batch_table = gr.JSON(label="Results")
            batch_csv = gr.File(label="Download CSV")
            batch_status = gr.Textbox(label="Status")
            run_batch.click(
                run_batch_upload,
                inputs=[
                    batch_files,
                    task,
                    model_id,
                    animal_model_id,
                    overlay_model_id,
                    overlay_codes,
                    run_exif,
                    aws_region,
                    aws_profile,
                    s3_region,
                    max_dim,
                    batch_workers,
                    batch_size,
                    batch_pause,
                    run_animal,
                    run_overlay,
                ],
                outputs=[batch_table, batch_csv, batch_status],
            )

    return demo


def main() -> None:
    app = build_app()
    share = env_default("BEAVER_GRADIO_SHARE", "false").lower() in {"1", "true", "yes"}
    app.launch(share=share)


if __name__ == "__main__":
    main()
