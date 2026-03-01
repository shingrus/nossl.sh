from pathlib import Path
from typing import Tuple


def get_work_and_bin_dirs(context) -> Tuple[Path, Path]:
    paths = context.resources.paths
    return paths["work_dir"], paths["bin_dir"]


def get_work_dir(context) -> Path:
    return context.resources.paths["work_dir"]
