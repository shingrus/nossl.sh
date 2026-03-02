from dagster import Field, op
from datetime import datetime
import os
from pathlib import Path


@op
def build_date_tag(_context):
    return datetime.now().strftime("%Y%m%d")


def date_tag_to_folder(date_tag: str) -> str:
    if len(date_tag) != 8 or not date_tag.isdigit():
        raise RuntimeError(f"Invalid date tag (expected YYYYMMDD): {date_tag!r}")
    return f"{date_tag[:4]}-{date_tag[4:6]}-{date_tag[6:8]}"


@op(
    config_schema={
        "enabled": Field(
            bool,
            default_value=False,
            is_required=False,
            description="Enable upload. When false, op logs and skips.",
        ),
        "bucket": Field(
            str,
            default_value="nossl-sh-dbs",
            is_required=False,
            description="Destination S3 bucket name.",
        ),
        "region": Field(
            str,
            default_value="eu-north-1",
            is_required=False,
            description="AWS region for the S3 client.",
        ),
    }
)
def upload_file_to_s3(context, local_path: str, date_tag: str):
    if not context.op_config["enabled"]:
        context.log.info("S3 upload disabled; skipping upload_file_to_s3")
        return ""

    bucket = (context.op_config.get("bucket") or "").strip()
    region = (context.op_config.get("region") or "").strip()

    src = Path(local_path)
    access_key = (os.getenv("AWS_ACCESS_KEY_ID") or "").strip()
    secret_key = (os.getenv("AWS_SECRET_ACCESS_KEY") or "").strip()
    file_name = src.name
    date_folder = date_tag_to_folder(date_tag)
    key = f"{date_folder}/{file_name}"


    if not bucket:
        raise RuntimeError("S3 upload config 'bucket' is required when enabled=true")
    if not region:
        raise RuntimeError("S3 upload config 'region' is required when enabled=true")
    if not access_key or not secret_key:
        raise RuntimeError(
            "Missing AWS credentials for S3 upload. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY."
        )
    if not src.is_file():
        raise RuntimeError(f"S3 upload source file not found: {src}")
    if not file_name:
        raise RuntimeError(f"Could not derive filename from path: {local_path!r}")

    try:
        import boto3
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Missing boto3 dependency. Install it in your Dagster environment."
        ) from exc

    client = boto3.client("s3", region_name=region)
    context.log.info(f"Uploading {src} to s3://{bucket}/{key}")
    client.upload_file(str(src), bucket, key)
    return f"s3://{bucket}/{key}"
