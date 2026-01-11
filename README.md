# dfw-beaver-id
CLI scaffold for batch beaver detection using AWS Bedrock.

## Goals
- Accept a single image or a directory of images.
- Call AWS-hosted models to detect beaver presence (Bedrock).
- Emit a standardized CSV output for downstream workflows.

## Project layout
- `src/beaver_id/cli.py`: CLI entrypoint and CSV writer.
- `src/beaver_id/__init__.py`: Package marker.

## Requirements
- Python 3.11+
- uv (https://docs.astral.sh/uv/)
- AWS credentials configured locally (e.g. via `aws configure`)

## Setup
```bash
uv venv
source .venv/bin/activate
uv pip install -e .
```

## Configuration
Copy `.env.example` to `.env` and set values for your environment:
```
AWS_REGION=us-east-2
AWS_PROFILE=default
BEAVER_BEDROCK_MODEL_ID=arn:aws:bedrock:us-east-2:727117753557:inference-profile/us.anthropic.claude-opus-4-5-20251101-v1:0
BEAVER_TASK=classify
BEAVER_MAX_WORKERS=4
BEAVER_LIMIT=0
BEAVER_MAX_DIM=2048
BEAVER_OUTPUT=beaver_results.csv
```
The CLI loads `.env` automatically.

## Usage
```bash
beaver-id /path/to/images --output beaver_results.csv --model-id my-model
```
Local example (your dataset path):
```bash
beaver-id /Users/qiongran.h/Downloads/dfw-beaver-aug-ohio/original/train --task classify
```
S3 prefixes are supported:
```bash
beaver-id s3://my-bucket/path/prefix/ --task classify --max-workers 6
```
Bounding box mode:
```bash
beaver-id s3://my-bucket/path/prefix/ --task bbox --output beaver_bbox.csv
```

## Gradio UI
```bash
beaver-id-ui
```
Then open the local URL shown in the terminal.

## Tests
```bash
python -m unittest
```

## Output schema
The CSV contains:
- `image_path`: absolute or relative path to the image.
- `has_beaver`: boolean result from the model.
- `confidence`: float confidence score.
- `reason`: short model-provided rationale (classify task).
- `bbox`: JSON array of normalized coords when using bbox task.
- `model_id`: AWS model identifier used for inference.
- `error`: error string if inference failed for a given image.

## Next steps
- Add retries/backoff for Bedrock failures.
- Add metrics/logging for batch runs.
