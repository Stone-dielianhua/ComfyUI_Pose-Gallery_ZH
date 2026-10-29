"""HTTP checks use aiohttp, already included with ComfyUI."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from test_gallery import gallery, make_library


class GalleryRoutes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.library = self.root / "assets"
        self.library.mkdir()
        make_library(self.library)
        self.config_patch = patch.object(gallery, "config_path", return_value=self.root / "settings.json")
        self.config_patch.start()
        route_table = web.RouteTableDef()
        fake_server = types.ModuleType("server")
        fake_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=route_table))
        with patch.dict(sys.modules, {"server": fake_server}):
            importlib.import_module("pose_gallery_test.routes").register_routes()
        app = web.Application()
        app.add_routes(route_table)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.config_patch.stop()
        self.temp.cleanup()

    async def test_bundled_catalogue_and_image(self):
        response = await self.client.get("/pose_gallery/catalogue")
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertEqual(data["count"], 1439)
        self.assertEqual(data["groups"], 288)
        response = await self.client.get("/pose_gallery/image", params={"id": gallery.DEFAULT_ID})
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.read()).startswith(b"\x89PNG\r\n\x1a\n"))

    async def test_custom_setting_and_fallback_thumbnail(self):
        response = await self.client.post("/pose_gallery/settings", json={"custom_directory": str(self.library)})
        self.assertEqual(response.status, 200)
        response = await self.client.get("/pose_gallery/catalogue?source=custom")
        self.assertEqual((await response.json())["count"], 2)
        response = await self.client.get("/pose_gallery/image?source=custom&id=p0&kind=thumb")
        self.assertEqual(response.status, 200)
        response = await self.client.post("/pose_gallery/settings", json={"custom_directory": "relative"})
        self.assertEqual(response.status, 400)
        response = await self.client.get("/pose_gallery/settings")
        self.assertEqual((await response.json())["custom_directory"], str(self.library.resolve()))

    async def test_invalid_requests_and_cross_origin_change(self):
        response = await self.client.get("/pose_gallery/catalogue?source=unknown")
        self.assertEqual(response.status, 400)
        response = await self.client.get("/pose_gallery/image?id=../../private")
        self.assertEqual(response.status, 404)
        response = await self.client.post("/pose_gallery/settings", data="{}")
        self.assertEqual(response.status, 415)
        response = await self.client.post("/pose_gallery/settings", json={}, headers={"Origin": "https://unrelated.example"})
        self.assertEqual(response.status, 403)
        response = await self.client.post("/pose_gallery/settings", json=[])
        self.assertEqual(response.status, 400)
        response = await self.client.post("/pose_gallery/settings", data="{broken", headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)


if __name__ == "__main__":
    unittest.main()
