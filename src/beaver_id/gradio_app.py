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
    error_row,
    iter_input_images,
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
def build_clients_cached(aws_region: str | None, aws_profile: str | None):
    session_kwargs: dict[str, Any] = {}
    if aws_region:
        session_kwargs["region_name"] = aws_region
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile
    session = boto3.Session(**session_kwargs)
    return session.client("bedrock-runtime"), session.client("s3")


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
    image: Image.Image | None,
    task: str,
    model_id: str,
    aws_region: str | None,
    aws_profile: str | None,
    max_dim: int,
):
    if image is None:
        return {"error": "No image provided."}, None

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile)
    with tempfile.NamedTemporaryFile(suffix=".jpg") as handle:
        image.convert("RGB").save(handle.name, format="JPEG")
        data = detect_beaver(
            handle.name,
            bedrock_client,
            s3_client,
            model_id,
            task,
            max_dim,
        )

    bbox_image = None
    if task == "bbox":
        bbox_image = draw_bbox_on_image(image.convert("RGB"), data.get("bbox"))

    return data, bbox_image


def run_s3_path(
    s3_path: str,
    task: str,
    model_id: str,
    aws_region: str | None,
    aws_profile: str | None,
    max_dim: int,
):
    if not s3_path:
        return {"error": "No S3 path provided."}, None

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile)
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

    return data, preview


def run_batch_upload(
    file_paths: list[str] | None,
    task: str,
    model_id: str,
    aws_region: str | None,
    aws_profile: str | None,
    max_dim: int,
    max_workers: int,
    batch_size: int,
    batch_pause_sec: float,
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

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile)

    def _run(path: str) -> dict:
        data = detect_beaver(path, bedrock_client, s3_client, model_id, task, max_dim)
        return normalize_row(path, data, model_id)

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
    aws_region: str | None,
    aws_profile: str | None,
    max_dim: int,
    max_workers: int,
    limit: int,
    batch_size: int,
    batch_pause_sec: float,
):
    if not s3_prefix:
        return [], None, "No S3 prefix provided."

    max_workers = max(1, int(max_workers))
    batch_size = max(1, int(batch_size))
    batch_pause_sec = max(0.0, float(batch_pause_sec))

    bedrock_client, s3_client = build_clients_cached(aws_region, aws_profile)
    limit_value = None if limit <= 0 else limit
    image_paths = list(iter_input_images(s3_prefix, s3_client, limit_value))
    if not image_paths:
        return [], None, "No images found for prefix."

    def _run(path: str) -> dict:
        data = detect_beaver(path, bedrock_client, s3_client, model_id, task, max_dim)
        return normalize_row(path, data, model_id)

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

    with gr.Blocks(title="Beaver Detector") as demo:
        gr.Markdown("# Beaver Detector")
        gr.Markdown("Run AWS Bedrock beaver detection on a local image or an S3 object.")

        with gr.Row():
            task = gr.Radio(["classify", "bbox"], value=default_task, label="Task")
            model_id = gr.Textbox(value=default_model_id, label="Bedrock Model ID / ARN")
        with gr.Row():
            aws_region = gr.Textbox(value=default_region or "", label="AWS Region")
            aws_profile = gr.Textbox(value=default_profile or "", label="AWS Profile")
            max_dim = gr.Number(value=default_max_dim, label="Max Image Dimension")

        with gr.Tab("Upload Image"):
            upload = gr.Image(type="pil", label="Image")
            run_upload = gr.Button("Run")
            result_json = gr.JSON(label="Result")
            bbox_preview = gr.Image(type="pil", label="BBox Preview")
            run_upload.click(
                run_uploaded_image,
                inputs=[upload, task, model_id, aws_region, aws_profile, max_dim],
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
                inputs=[s3_path, task, model_id, aws_region, aws_profile, max_dim],
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
                    aws_region,
                    aws_profile,
                    max_dim,
                    s3_workers,
                    s3_limit,
                    s3_batch_size,
                    s3_batch_pause,
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
                    aws_region,
                    aws_profile,
                    max_dim,
                    batch_workers,
                    batch_size,
                    batch_pause,
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
