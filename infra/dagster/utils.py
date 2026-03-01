import shutil
from pathlib import Path
from typing import Tuple

from dagster import failure_hook


def get_work_and_bin_dirs(context) -> Tuple[Path, Path]:
    paths = context.resources.paths
    return paths["work_dir"], paths["bin_dir"]


def get_work_dir(context) -> Path:
    return context.resources.paths["work_dir"]


def safe_remove_dir(target: Path):
    target_str = str(target).strip()
    if not target_str or target_str == "/":
        raise RuntimeError(f"Refusing to remove unsafe directory: {target_str!r}")
    if target.exists():
        shutil.rmtree(target)


def remove_if_exists(path: Path):
    if path.exists():
        path.unlink()


def update_symlink_to_latest(target_path: Path, link_path: Path):
    if not target_path.is_file():
        raise RuntimeError(f"Cannot link missing file: {target_path}")
    if link_path.exists() or link_path.is_symlink():
        link_path.unlink()
    link_path.symlink_to(target_path.name)


def make_temp_cleanup_failure_hook(temp_dir_name: str, label: str):
    @failure_hook(required_resource_keys={"paths"})
    def _cleanup_temp_on_failure(context):
        work_dir = get_work_dir(context)
        temp_dir = work_dir / temp_dir_name
        safe_remove_dir(temp_dir)
        context.log.info(f"failure hook cleaned {label} temp dir: {temp_dir}")

    return _cleanup_temp_on_failure
