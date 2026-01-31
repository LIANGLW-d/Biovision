# Integration Test Plan - ML Agent <-> Backend

This plan validates real integration between the backend (CLI/Gradio) and the ML
agent (AWS Bedrock) by sending real images and verifying returned JSON results
and persisted outputs (CSV/UI). No mocks or simulators are used.

## Scope
- Subsystems: backend CLI/Gradio app + AWS Bedrock model (ML agent).
- Interface: HTTP API calls via AWS Bedrock runtime with image bytes and prompt.
- Evidence: CLI logs, CSV output, UI JSON + bbox preview (optional).

## Preconditions
- AWS credentials configured (env vars or AWS profile).
- Access to a Bedrock model ID / inference profile ARN.
- Access to test images (local files and/or S3 objects).

## Test Case 1: Local Image -> Bedrock -> CSV
### What
Run CLI with a local image file and verify output CSV row.

### Why
Confirms the backend can send real image bytes to Bedrock and parse JSON into CSV.

### Steps
1) Run:
   `beaver-id ./path/to/local_image.jpg --output ./beaver_results_local.csv`
2) Open `./beaver_results_local.csv` and verify a row exists for the image.

### Expected Behavior
- CLI prints: `Wrote results to ...`
- CSV contains 1 row for the image.
- `has_beaver` and `confidence` are populated OR `error` is empty.

### Pass/Fail Criteria
- Pass: CSV row exists and `error` is empty for the image.
- Fail: No row, or `error` populated.

## Test Case 2: Single S3 Image -> Bedrock -> CSV
### What
Run CLI on a single S3 image and verify CSV output.

### Why
Confirms backend can fetch S3 object and send to Bedrock.

### Steps
1) Run:
   `beaver-id s3://YOUR_BUCKET/path/to/image.jpg --output ./beaver_results_s3.csv`
2) Open `./beaver_results_s3.csv` and verify the row.

### Expected Behavior
- CLI prints: `Wrote results to ...`
- CSV contains a row for the S3 object.
- `has_beaver` and `confidence` are populated OR `error` is empty.

### Pass/Fail Criteria
- Pass: CSV row exists and `error` is empty for the S3 object.
- Fail: No row, or `error` populated.

## Test Case 3: S3 Prefix Batch -> Bedrock -> CSV
### What
Run CLI on an S3 prefix and verify multiple rows in CSV output.

### Why
Confirms backend handles batch workflows and aggregates results from Bedrock.

### Steps
1) Run:
   `beaver-id s3://YOUR_BUCKET/path/to/prefix/ --output ./beaver_results_batch.csv --limit 10`
2) Open `./beaver_results_batch.csv` and count rows (should match images processed).

### Expected Behavior
- CLI prints: `Wrote results to ...`
- CSV contains N rows matching input count (limit if set).
- At least one row has `has_beaver` or `has_animal` populated, and `error` empty.

### Pass/Fail Criteria
- Pass: Row count matches and most rows have empty `error`.
- Fail: No rows, mismatched count, or widespread errors.

## Evidence to Capture (Video)
- Terminal command + live output.
- CSV file opened showing rows populated.
- (Optional UI) `beaver-id-ui` showing JSON output and bbox preview for an image.

