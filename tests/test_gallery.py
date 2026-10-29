"""Run with ComfyUI's Python: python -m unittest discover -s tests -v."""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
import torch

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("pose_gallery_test")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package
gallery = importlib.import_module("pose_gallery_test.gallery")
nodes = importlib.import_module("pose_gallery_test.nodes")


def make_library(root, sizes=((80, 96), (80, 96))):
    (root / "data").mkdir()
    (root / "img").mkdir()
    rows = []
    for index, size in enumerate(sizes):
        pixels = np.zeros((size[1], size[0], 3), dtype=np.uint8)
        pixels[:, :size[0] // 2] = [255, 0, 0]
        pixels[:, size[0] // 2:] = [0, 0, 255]
        Image.fromarray(pixels).save(root / "img" / f"{index}.png")
        rows.append({"id": f"p{index}", "体系": "测试", "姿势编号": "P001",
                     "分类": "坐姿", "姿势名称": "测试姿势", "角度": ("侧面", "正面")[index % 2],
                     "原图": f"img/{index}.png", "缩略图": f"thumbs/{index}.jpg"})
    (root / "data" / "pose-zh.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return rows


class BundledAssets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cat = gallery.catalogue("builtin")

    def test_catalogue_groups_and_missing_angle(self):
        self.assertEqual(len(self.cat.items), 1439)
        self.assertEqual(len(self.cat.groups), 288)
        self.assertEqual(sum(len(group) == 4 for group in self.cat.groups.values()), 1)
        self.assertEqual(sum(item["角度"] == "仰视" for item in self.cat.items), 287)
        self.assertEqual(len(self.cat.group(gallery.DEFAULT_ID)), 5)

    def test_every_bundled_file_exists(self):
        for item in self.cat.items:
            for key in ("原图", "缩略图"):
                self.assertTrue(gallery.safe_image_path(ROOT, item[key]).is_file(), item[key])

    def test_single_output_is_comfy_image(self):
        image, pose_id, description = nodes.PoseGalleryImage().execute()
        self.assertEqual(tuple(image.shape), (1, 1200, 900, 3))
        self.assertEqual(image.dtype, torch.float32)
        self.assertGreaterEqual(float(image.min()), 0)
        self.assertLessEqual(float(image.max()), 1)
        self.assertEqual(pose_id, gallery.DEFAULT_ID)
        self.assertIn(pose_id, description)

    def test_batch_correspondence_and_all_angles(self):
        image, metadata = nodes.PoseGalleryBatch().execute(selection_mode="当前姿势全部角度", width=64, height=80)
        rows = json.loads(metadata)
        self.assertEqual(tuple(image.shape), (5, 80, 64, 3))
        self.assertEqual([row["角度"] for row in rows], list(gallery.ANGLE_ORDER))
        self.assertEqual([row["index"] for row in rows], list(range(5)))
        self.assertTrue(all(row["width"] == 64 and row["asset_source"] == "builtin" for row in rows))

    def test_id_parsing_and_limits(self):
        self.assertEqual(gallery.parse_ids("a,b；a\nc，d"), ["a", "b", "c", "d"])
        for value in ("", " ", " ".join(f"id{i}" for i in range(33))):
            with self.assertRaises(gallery.GalleryError):
                gallery.parse_ids(value)
        with self.assertRaises(gallery.GalleryError):
            self.cat.item("missing-image")
        with self.assertRaises(gallery.GalleryError):
            nodes.PoseGalleryBatch().execute(selection_mode="当前姿势全部角度", width=4096, height=4096)


class CustomAssets(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rows = make_library(self.root)
        self.config = self.root / "settings.json"
        self.patcher = patch.object(gallery, "config_path", return_value=self.config)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.temp.cleanup()

    def test_optional_setting_and_failed_update(self):
        self.assertEqual(gallery.read_settings(), {"custom_directory": ""})
        with self.assertRaises(gallery.GalleryError):
            gallery.catalogue("custom")
        gallery.save_settings(str(self.root))
        self.assertEqual(gallery.catalogue("custom").item("p0")["姿势名称"], "测试姿势")
        before = self.config.read_bytes()
        for invalid in ("relative/path", str(self.root / "missing")):
            with self.assertRaises(gallery.GalleryError):
                gallery.save_settings(invalid)
            self.assertEqual(self.config.read_bytes(), before)
        (self.root / "img" / "0.png").unlink()
        with self.assertRaisesRegex(gallery.GalleryError, "图片文件缺失"):
            gallery.save_settings(str(self.root))
        self.assertEqual(self.config.read_bytes(), before)
        gallery.save_settings("")
        self.assertEqual(gallery.read_settings()["custom_directory"], "")

    def test_paths_cannot_leave_library(self):
        for invalid in ("../outside.png", "/etc/photo.png", "C:/private/photo.png", "img\\0.png", "img/../../outside.jpg", "img/secret.txt"):
            with self.subTest(path=invalid), self.assertRaises(gallery.GalleryError):
                gallery.safe_image_path(self.root, invalid)

    def test_thumbnail_fallback_and_flip_padding(self):
        cat = gallery.catalogue_at(self.root)
        item = cat.item("p0")
        self.assertEqual(cat.path(item, thumbnail=True), cat.path(item))
        original = nodes.load_image(cat, item, "原始尺寸", 64, 64, False)
        flipped = nodes.load_image(cat, item, "原始尺寸", 64, 64, True)
        torch.testing.assert_close(flipped, original.flip(1))
        padded = nodes.load_image(cat, item, "等比留边", 160, 96, False)
        self.assertEqual(tuple(padded.shape), (96, 160, 3))
        self.assertTrue(torch.all(padded[:, 0] == 1))
        self.assertTrue(torch.all(padded[:, -1] == 1))
        self.assertLess(float(padded[:, 80, 0].mean()), .1)

    def test_ordering(self):
        cat = gallery.catalogue_at(self.root)
        manual = gallery.batch_items(cat, "p0\np1", "手动选择", "p0", "选择顺序")
        angles = gallery.batch_items(cat, "p0\np1", "手动选择", "p0", "视角顺序")
        self.assertEqual([row["id"] for row in manual], ["p0", "p1"])
        self.assertEqual([row["id"] for row in angles], ["p1", "p0"])

    def test_file_changes_invalidate_execution_cache(self):
        gallery.save_settings(str(self.root))
        before = nodes.PoseGalleryImage.IS_CHANGED("p0", "custom")
        image = self.root / "img" / "0.png"
        stat = image.stat()
        os.utime(image, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))
        self.assertNotEqual(before, nodes.PoseGalleryImage.IS_CHANGED("p0", "custom"))

    def test_mixed_original_dimensions_explain_fix(self):
        gallery.save_settings(str(self.root))
        Image.new("RGB", (96, 80)).save(self.root / "img" / "1.png")
        with self.assertRaisesRegex(gallery.GalleryError, "尺寸不一致"):
            nodes.PoseGalleryBatch().execute("p0\np1", asset_source="custom", resize_mode="原始尺寸")
        images, _ = nodes.PoseGalleryBatch().execute("p0\np1", asset_source="custom", width=64, height=64)
        self.assertEqual(tuple(images.shape), (2, 64, 64, 3))

    def test_manifest_validation_and_missing_file(self):
        for mutate in (lambda rows: rows.append(dict(rows[0])), lambda rows: rows[0].pop("原图"), lambda rows: rows[0].update(原图="../outside.png")):
            rows = json.loads(json.dumps(self.rows))
            mutate(rows)
            (self.root / "data" / "pose-zh.json").write_text(json.dumps(rows), encoding="utf-8")
            with self.assertRaises(gallery.GalleryError):
                gallery.Catalogue(self.root, ())


if __name__ == "__main__":
    unittest.main()
