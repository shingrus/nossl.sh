from dagster import Field, op
from datetime import datetime
import json
import mimetypes
import os
from pathlib import Path
from urllib import error, parse, request


@op
def build_date_tag(_context):
    return datetime.now().strftime("%Y%m%d")


def date_tag_to_folder(date_tag: str) -> str:
    if len(date_tag) != 8 or not date_tag.isdigit():
        raise RuntimeError(f"Invalid date tag (expected YYYYMMDD): {date_tag!r}")
    return f"{date_tag[:4]}-{date_tag[4:6]}-{date_tag[6:8]}"


def _github_headers(token: str, content_type: str | None = None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _github_error_message(exc: error.HTTPError) -> str:
    try:
        raw_body = exc.read().decode("utf-8", errors="replace")
    except Exception:
        raw_body = ""

    if not raw_body:
        return f"GitHub API request failed with HTTP {exc.code}"

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        return f"GitHub API request failed with HTTP {exc.code}: {raw_body}"

    message = payload.get("message")
    errors_payload = payload.get("errors")
    if errors_payload:
        return f"GitHub API request failed with HTTP {exc.code}: {message}; errors={errors_payload}"
    if message:
        return f"GitHub API request failed with HTTP {exc.code}: {message}"
    return f"GitHub API request failed with HTTP {exc.code}: {payload}"


def _github_json_request(url: str, token: str, method: str = "GET", payload: dict | None = None):
    data = None
    headers = _github_headers(token)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = request.Request(url, data=data, headers=headers, method=method)
    try:
        with request.urlopen(req) as response:
            body = response.read()
    except error.HTTPError as exc:
        raise RuntimeError(_github_error_message(exc)) from exc

    if not body:
        return {}
    return json.loads(body.decode("utf-8"))


def _github_get_release_by_tag(owner: str, repo: str, tag: str, token: str):
    url = (
        f"https://api.github.com/repos/{parse.quote(owner)}/{parse.quote(repo)}"
        f"/releases/tags/{parse.quote(tag)}"
    )
    req = request.Request(url, headers=_github_headers(token), method="GET")
    try:
        with request.urlopen(req) as response:
            body = response.read()
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise RuntimeError(_github_error_message(exc)) from exc

    if not body:
        return None
    return json.loads(body.decode("utf-8"))


def _github_delete_release_asset(asset_api_url: str, token: str):
    req = request.Request(asset_api_url, headers=_github_headers(token), method="DELETE")
    try:
        with request.urlopen(req):
            return
    except error.HTTPError as exc:
        raise RuntimeError(_github_error_message(exc)) from exc


def _github_upload_release_asset(upload_url_template: str, asset_name: str, src: Path, token: str):
    upload_url = upload_url_template.split("{", 1)[0]
    upload_url = f"{upload_url}?{parse.urlencode({'name': asset_name})}"
    content_type = mimetypes.guess_type(asset_name)[0] or "application/octet-stream"

    req = request.Request(
        upload_url,
        data=src.read_bytes(),
        headers=_github_headers(token, content_type=content_type),
        method="POST",
    )
    try:
        with request.urlopen(req) as response:
            body = response.read()
    except error.HTTPError as exc:
        raise RuntimeError(_github_error_message(exc)) from exc

    if not body:
        raise RuntimeError("GitHub upload succeeded but returned an empty response body")
    return json.loads(body.decode("utf-8"))


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


@op(
    config_schema={
        "enabled": Field(
            bool,
            default_value=False,
            is_required=False,
            description="Enable upload. When false, op logs and skips.",
        ),
        "owner": Field(
            str,
            default_value="",
            is_required=False,
            description="GitHub repository owner.",
        ),
        "repo": Field(
            str,
            default_value="",
            is_required=False,
            description="GitHub repository name.",
        ),
        "release_tag": Field(
            str,
            default_value="latest",
            is_required=False,
            description="Rolling release tag to create or update.",
        ),
        "release_name": Field(
            str,
            default_value="Latest MMDBs",
            is_required=False,
            description="Release display name.",
        ),
        "release_body": Field(
            str,
            default_value="Rolling release.\n\nLast build date: {date_tag}",
            is_required=False,
            description=(
                "Release body template. Supported placeholders: "
                "{date_tag}, {asset_name}, {source_file_name}."
            ),
        ),
        "asset_name": Field(
            str,
            default_value="",
            is_required=False,
            description="Uploaded asset name. Defaults to the local file name.",
        ),
        "target_commitish": Field(
            str,
            default_value="",
            is_required=False,
            description="Optional branch or commit SHA used when creating the release tag.",
        ),
        "make_latest": Field(
            bool,
            default_value=True,
            is_required=False,
            description="Mark the release as the repository latest release.",
        ),
    }
)
def upload_file_to_github_release(context, local_path: str, date_tag: str):
    if not context.op_config["enabled"]:
        context.log.info("GitHub upload disabled; skipping upload_file_to_github_release")
        return ""

    owner = (context.op_config.get("owner") or "").strip()
    repo = (context.op_config.get("repo") or "").strip()
    release_tag = (context.op_config.get("release_tag") or "").strip()
    release_name = (context.op_config.get("release_name") or "").strip()
    release_body_template = context.op_config.get("release_body") or ""
    requested_asset_name = (context.op_config.get("asset_name") or "").strip()
    target_commitish = (context.op_config.get("target_commitish") or "").strip()
    make_latest = "true" if context.op_config.get("make_latest", True) else "false"

    src = Path(local_path)
    source_file_name = src.name
    asset_name = requested_asset_name or source_file_name

    if not owner:
        raise RuntimeError("GitHub upload config 'owner' is required when enabled=true")
    if not repo:
        raise RuntimeError("GitHub upload config 'repo' is required when enabled=true")
    if not release_tag:
        raise RuntimeError("GitHub upload config 'release_tag' is required when enabled=true")
    if not release_name:
        raise RuntimeError("GitHub upload config 'release_name' is required when enabled=true")
    if not src.is_file():
        raise RuntimeError(f"GitHub upload source file not found: {src}")
    if not asset_name:
        raise RuntimeError(f"Could not derive GitHub asset name from path: {local_path!r}")

    token = (os.getenv("GITHUB_TOKEN") or "").strip()
    if not token:
        raise RuntimeError(
            "Missing GitHub token for release upload. Set environment variable GITHUB_TOKEN."
        )

    release_body = (
        release_body_template.replace("{date_tag}", date_tag)
        .replace("{asset_name}", asset_name)
        .replace("{source_file_name}", source_file_name)
    )

    release = _github_get_release_by_tag(owner, repo, release_tag, token)
    if release is None:
        payload = {
            "tag_name": release_tag,
            "name": release_name,
            "body": release_body,
            "draft": False,
            "prerelease": False,
            "generate_release_notes": False,
            "make_latest": make_latest,
        }
        if target_commitish:
            payload["target_commitish"] = target_commitish
        context.log.info(f"Creating GitHub release {owner}/{repo}@{release_tag}")
        release = _github_json_request(
            f"https://api.github.com/repos/{parse.quote(owner)}/{parse.quote(repo)}/releases",
            token,
            method="POST",
            payload=payload,
        )
    else:
        release_id = release["id"]
        context.log.info(f"Updating GitHub release {owner}/{repo}@{release_tag}")
        release = _github_json_request(
            f"https://api.github.com/repos/{parse.quote(owner)}/{parse.quote(repo)}/releases/{release_id}",
            token,
            method="PATCH",
            payload={
                "name": release_name,
                "body": release_body,
                "draft": False,
                "prerelease": False,
                "make_latest": make_latest,
            },
        )

    existing_assets = release.get("assets") or []
    for asset in existing_assets:
        if asset.get("name") != asset_name:
            continue
        asset_id = asset.get("id")
        context.log.info(f"Deleting existing GitHub release asset {asset_name} (id={asset_id})")
        _github_delete_release_asset(asset["url"], token)
        break

    context.log.info(f"Uploading {src} to GitHub release asset {asset_name}")
    uploaded_asset = _github_upload_release_asset(release["upload_url"], asset_name, src, token)

    browser_download_url = uploaded_asset.get("browser_download_url") or ""
    release_asset_url = (
        f"https://github.com/{owner}/{repo}/releases/download/"
        f"{parse.quote(release_tag)}/{parse.quote(asset_name)}"
    )
    stable_latest_url = (
        f"https://github.com/{owner}/{repo}/releases/latest/download/{parse.quote(asset_name)}"
    )
    if browser_download_url:
        context.log.info(f"GitHub release asset uploaded: {browser_download_url}")
    context.log.info(f"Release asset URL: {release_asset_url}")
    if make_latest == "true":
        context.log.info(f"Stable latest asset URL: {stable_latest_url}")
        return stable_latest_url
    return release_asset_url
