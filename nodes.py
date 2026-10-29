"""Standard ComfyUI image nodes. No inference models or downloads required."""

from __future__ import annotations

import json

import numpy as np
import torch
from PIL import Image, ImageOps

from .gallery import (DEFAULT_ID, MAX_BATCH_PIXELS, SOURCES, GalleryError, batch_items,
                      catalogue, source_key)

RESIZE_MODES = ["原始尺寸", "等比留边", "居中裁剪", "拉伸"]


def image_inputs(batch=False):
    return {
        "asset_source": (list(SOURCES), {"default": SOURCES[0], "tooltip": "默认使用插件内附素材。自定义目录在图库的素材设置中配置。"}),
        "resize_mode": (RESIZE_MODES, {"default": "等比留边" if batch else "原始尺寸"}),
        "width": ("INT", {"default": 768, "min": 64, "max": 4096, "step": 8}),
        "height": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}),
        "flip_horizontal": ("BOOLEAN", {"default": False, "label_on": "翻转", "label_off": "不翻转"}),
    }


def load_image(cat, item, resize_mode, width, height, flip_horizontal):
    if resize_mode not in RESIZE_MODES:
        raise GalleryError("未知图片尺寸处理方式。")
    if not 64 <= width <= 4096 or not 64 <= height <= 4096:
        raise GalleryError("输出宽高须在 64 至 4096 之间。")
    path = cat.path(item)
    try:
        with Image.open(path) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGBA")
            background = Image.new("RGBA", image.size, "white")
            background.alpha_composite(image)
            image = background.convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise GalleryError(f"图片无法读取或已损坏：{path.name}") from exc
    if flip_horizontal:
        image = ImageOps.mirror(image)
    size = (int(width), int(height))
    if resize_mode == "等比留边":
        image = ImageOps.pad(image, size, method=Image.Resampling.LANCZOS, color="white")
    elif resize_mode == "居中裁剪":
        image = ImageOps.fit(image, size, method=Image.Resampling.LANCZOS)
    elif resize_mode == "拉伸":
        image = image.resize(size, Image.Resampling.LANCZOS)
    return torch.from_numpy(np.asarray(image, dtype=np.float32) / 255.0)


def describe(item):
    return f"{item['姿势名称']}｜{item['体系']}｜{item['分类']}｜{item['角度']}｜{item['id']}"


class PoseGalleryImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "pose_id": ("STRING", {"default": DEFAULT_ID, "tooltip": "点击「打开姿势图库」选图，无需手动输入。"}),
            **image_inputs(),
        }}

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("图片", "图片ID", "姿势说明")
    FUNCTION = "execute"
    CATEGORY = "ComfyUI_Pose-Gallery_ZH/姿势图库"
    DESCRIPTION = "从内置或自定义姿势图库读取参考图。控制姿势时请接 DWPose/OpenPose 预处理和匹配的 ControlNet。"

    def execute(self, pose_id=DEFAULT_ID, asset_source=SOURCES[0], resize_mode="原始尺寸",
                width=768, height=1024, flip_horizontal=False):
        cat = catalogue(asset_source)
        item = cat.item(pose_id)
        image = load_image(cat, item, resize_mode, width, height, flip_horizontal)
        return image.unsqueeze(0), item["id"], describe(item)

    @classmethod
    def IS_CHANGED(cls, pose_id=DEFAULT_ID, asset_source=SOURCES[0], **kwargs):
        cat = catalogue(asset_source)
        return cat.fingerprint([cat.item(pose_id)])


class PoseGalleryBatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "pose_ids": ("STRING", {"multiline": True, "default": DEFAULT_ID, "tooltip": "每行一个图片 ID。可在图库勾选后发送到此节点，最多32张。"}),
            "selection_mode": (["手动选择", "当前姿势全部角度"],),
            "pose_id": ("STRING", {"default": DEFAULT_ID, "tooltip": "选择全部角度模式时，以此 ID 所属姿势为准。"}),
            "order": (["选择顺序", "视角顺序", "编号顺序"],),
            **image_inputs(batch=True),
        }}

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图片批次", "信息清单JSON")
    FUNCTION = "execute"
    CATEGORY = "ComfyUI_Pose-Gallery_ZH/姿势图库"
    DESCRIPTION = "批量读取独立参考图。默认等比留边统一尺寸，清单与输出批次的顺序一致。最多32张，总像素最多3200万。"

    def execute(self, pose_ids=DEFAULT_ID, selection_mode="手动选择", pose_id=DEFAULT_ID,
                order="选择顺序", asset_source=SOURCES[0], resize_mode="等比留边",
                width=768, height=1024, flip_horizontal=False):
        cat = catalogue(asset_source)
        items = batch_items(cat, pose_ids, selection_mode, pose_id, order)
        if resize_mode != "原始尺寸" and len(items) * width * height > MAX_BATCH_PIXELS:
            raise GalleryError("单批图片总像素超过3200万，请减少图片数量或输出尺寸。")
        images, records = [], []
        shape = None
        total_pixels = 0
        for index, item in enumerate(items):
            image = load_image(cat, item, resize_mode, width, height, flip_horizontal)
            if shape is not None and tuple(image.shape) != shape:
                raise GalleryError("原始图片尺寸不一致，请改用等比留边、居中裁剪或拉伸来统一尺寸。")
            shape = tuple(image.shape)
            total_pixels += shape[0] * shape[1]
            if total_pixels > MAX_BATCH_PIXELS:
                raise GalleryError("单批图片总像素超过3200万，请减少图片数量或输出尺寸。")
            images.append(image)
            records.append({"index": index, "id": item["id"], "体系": item["体系"],
                            "姿势编号": item["姿势编号"], "姿势名称": item["姿势名称"],
                            "分类": item["分类"], "角度": item["角度"],
                            "asset_source": source_key(asset_source),
                            "width": shape[1], "height": shape[0],
                            "resize_mode": resize_mode, "flip_horizontal": flip_horizontal})
        return torch.stack(images), json.dumps(records, ensure_ascii=False, indent=2)

    @classmethod
    def IS_CHANGED(cls, pose_ids=DEFAULT_ID, selection_mode="手动选择", pose_id=DEFAULT_ID,
                   order="选择顺序", asset_source=SOURCES[0], **kwargs):
        cat = catalogue(asset_source)
        return cat.fingerprint(batch_items(cat, pose_ids, selection_mode, pose_id, order))


NODE_CLASS_MAPPINGS = {"PoseGalleryImage": PoseGalleryImage, "PoseGalleryBatch": PoseGalleryBatch}
NODE_DISPLAY_NAME_MAPPINGS = {"PoseGalleryImage": "姿势图库 · 单图", "PoseGalleryBatch": "姿势图库 · 批量"}
