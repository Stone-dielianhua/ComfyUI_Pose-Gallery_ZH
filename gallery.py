"""Catalogue and local configuration shared by nodes and HTTP routes."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ANGLE_ORDER = ("正面", "斜侧", "侧面", "俯视", "仰视")
SOURCES = ("内置素材库", "自定义素材库")
SOURCE_KEYS = {"内置素材库": "builtin", "自定义素材库": "custom",
               "builtin": "builtin", "custom": "custom"}
DEFAULT_ID = "full_single_P001_front"
MAX_BATCH = 32
MAX_BATCH_PIXELS = 32_000_000
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


class GalleryError(ValueError):
    """An actionable error safe to show in the UI."""


def config_path() -> Path:
    # Keep machine-specific paths outside the Git checkout when ComfyUI is available.
    try:
        import folder_paths
        return Path(folder_paths.get_user_directory()) / "pose_gallery" / "settings.json"
    except (ImportError, AttributeError):
        return ROOT / ".pose-gallery.settings.json"


def read_settings() -> dict:
    path = config_path()
    if not path.is_file():
        return {"custom_directory": ""}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        directory = data.get("custom_directory", "")
        if not isinstance(directory, str):
            raise ValueError("目录须为文本")
        return {"custom_directory": directory}
    except (OSError, ValueError, AttributeError) as exc:
        raise GalleryError(f"无法读取图库设置：{path}。请检查或移除该设置文件。") from exc


def save_settings(directory: str) -> dict:
    if not isinstance(directory, str):
        raise GalleryError("自定义素材目录须为文本。")
    directory = directory.strip()
    if directory:
        root = Path(directory).expanduser()
        if not root.is_absolute():
            raise GalleryError("请填写 ComfyUI 所在电脑上的绝对路径。")
        root = root.resolve()
        # Validate before replacing the previous working configuration.
        cat = catalogue_at(root)
        for item in cat.items:
            cat.path(item)
        directory = str(root)
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    settings = {"custom_directory": directory}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix="pose-gallery-", suffix=".tmp", delete=False) as stream:
            temporary = stream.name
            json.dump(settings, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return settings


def source_key(source: str) -> str:
    try:
        return SOURCE_KEYS[source]
    except (KeyError, TypeError) as exc:
        raise GalleryError("未知素材库，请选择内置素材库或自定义素材库。") from exc


def asset_root(source: str) -> Path:
    if source_key(source) == "builtin":
        return ROOT
    directory = read_settings()["custom_directory"]
    if not directory:
        raise GalleryError("尚未设置自定义素材目录，请在姿势图库的「素材设置」中填写目录。")
    return Path(directory).resolve()


def safe_image_path(root: Path, value: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise GalleryError("素材路径不能为空。")
    # JSON paths are relative to the library root, on every operating system.
    if "\\" in value or value.startswith("/") or re.match(r"^[a-zA-Z]:", value):
        raise GalleryError(f"素材须使用库内的相对路径：{value}")
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()) or path.suffix.lower() not in IMAGE_EXTENSIONS:
        raise GalleryError(f"素材路径不合法：{value}")
    return path


class Catalogue:
    def __init__(self, root: Path, signature: tuple):
        self.root = root.resolve()
        self.signature = signature
        manifest = self.root / "data" / "pose-zh.json"
        try:
            rows = json.loads(manifest.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise GalleryError("无法读取 data/pose-zh.json，请检查素材目录结构和 JSON 格式。") from exc
        if not isinstance(rows, list) or not rows:
            raise GalleryError("data/pose-zh.json 须为非空的图片记录数组。")
        self.items = []
        self.by_id = {}
        self.groups = {}
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise GalleryError(f"第 {index + 1} 条素材须为对象。")
            required = ("id", "体系", "姿势编号", "分类", "姿势名称", "角度", "原图")
            for key in required:
                if not isinstance(row.get(key), str) or not row[key].strip():
                    raise GalleryError(f"第 {index + 1} 条素材缺少文本字段：{key}")
            if row["id"] in self.by_id:
                raise GalleryError(f"素材 ID 重复：{row['id']}")
            original = row["原图"]
            thumbnail = row.get("缩略图") or original
            safe_image_path(self.root, original)
            safe_image_path(self.root, thumbnail)
            item = {key: row[key] for key in required}
            item["缩略图"] = thumbnail
            item["检索"] = " ".join(item[key] for key in required if key != "原图").lower()
            self.items.append(item)
            self.by_id[item["id"]] = item
            self.groups.setdefault((item["体系"], item["姿势编号"]), []).append(item)
        for group in self.groups.values():
            group.sort(key=lambda item: angle_rank(item["角度"]))

    def item(self, pose_id: str) -> dict:
        try:
            return self.by_id[pose_id]
        except (KeyError, TypeError) as exc:
            raise GalleryError(f"素材库中找不到图片 ID「{pose_id}」。请重新选图或检查所选素材库。") from exc

    def path(self, item: dict, thumbnail: bool = False) -> Path:
        path = safe_image_path(self.root, item["缩略图" if thumbnail else "原图"])
        if thumbnail and not path.is_file():
            path = safe_image_path(self.root, item["原图"])
        if not path.is_file():
            raise GalleryError(f"图片文件缺失：{path.name}。请检查素材是否完整。")
        return path

    def group(self, pose_id: str) -> list[dict]:
        item = self.item(pose_id)
        return self.groups[(item["体系"], item["姿势编号"])]

    def fingerprint(self, items: list[dict]) -> str:
        parts = [str(self.root), repr(self.signature)]
        for item in items:
            path = self.path(item)
            stat = path.stat()
            parts.extend((item["id"], str(stat.st_mtime_ns), str(stat.st_size)))
        return hashlib.sha256("|".join(parts).encode()).hexdigest()


def angle_rank(angle: str) -> int:
    return ANGLE_ORDER.index(angle) if angle in ANGLE_ORDER else len(ANGLE_ORDER)


@lru_cache(maxsize=8)
def _catalogue_cached(root: str, signature: tuple) -> Catalogue:
    return Catalogue(Path(root), signature)


def catalogue_at(root: Path) -> Catalogue:
    manifest = root / "data" / "pose-zh.json"
    try:
        stat = manifest.stat()
    except OSError as exc:
        raise GalleryError("素材目录中找不到 data/pose-zh.json。请填写包含 data、img、thumbs 的目录。") from exc
    return _catalogue_cached(str(root.resolve()), (stat.st_mtime_ns, stat.st_size))


def catalogue(source: str = "builtin") -> Catalogue:
    return catalogue_at(asset_root(source))


def parse_ids(value: str) -> list[str]:
    if not isinstance(value, str):
        raise GalleryError("图片 ID 清单须为文本。")
    ids = list(dict.fromkeys(part for part in re.split(r"[\s,，;；]+", value.strip()) if part))
    if not ids:
        raise GalleryError("请先在图库中选择至少一张图片。")
    if len(ids) > MAX_BATCH:
        raise GalleryError(f"单批最多 {MAX_BATCH} 张，请减少所选图片。")
    return ids


def batch_items(cat: Catalogue, pose_ids: str, selection_mode: str, pose_id: str, order: str) -> list[dict]:
    if selection_mode == "当前姿势全部角度":
        items = list(cat.group(pose_id))
    elif selection_mode == "手动选择":
        items = [cat.item(value) for value in parse_ids(pose_ids)]
    else:
        raise GalleryError("未知批量选择方式。")
    if len(items) > MAX_BATCH:
        raise GalleryError(f"单批最多 {MAX_BATCH} 张，请减少所选图片。")
    if order == "视角顺序":
        items.sort(key=lambda item: (item["体系"], item["姿势编号"], angle_rank(item["角度"])))
    elif order == "编号顺序":
        items.sort(key=lambda item: item["id"])
    elif order != "选择顺序":
        raise GalleryError("未知图片排列方式。")
    return items
