import io
import os
import tempfile
from functools import lru_cache
from typing import Any

import boto3
import gradio as gr
from dotenv import load_dotenv
from PIL import Image, ImageDraw

from beaver_id.cli import detect_beaver, extract_json_object, shrink_to_jpeg_under_5mb


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

    return demo


def main() -> None:
    app = build_app()
    app.launch()


if __name__ == "__main__":
    main()
