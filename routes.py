"""Local assets are served by ComfyUI, with no additional web service."""

import asyncio
import logging
from urllib.parse import urlsplit

from aiohttp import web

from .gallery import ANGLE_ORDER, GalleryError, catalogue, read_settings, save_settings, source_key

logger = logging.getLogger(__name__)


def register_routes():
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/pose_gallery/catalogue")
    async def get_catalogue(request):
        try:
            source = source_key(request.query.get("source", "builtin"))
            cat = await asyncio.to_thread(catalogue, source)
            return web.json_response({"source": source, "items": cat.items,
                                      "groups": len(cat.groups), "count": len(cat.items),
                                      "angles": list(ANGLE_ORDER)}, headers={"Cache-Control": "no-cache"})
        except GalleryError as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.get("/pose_gallery/image")
    async def get_image(request):
        try:
            def resolve():
                cat = catalogue(request.query.get("source", "builtin"))
                item = cat.item(request.query.get("id", ""))
                return cat.path(item, thumbnail=request.query.get("kind") == "thumb")
            path = await asyncio.to_thread(resolve)
            # Revalidation allows changed custom files to appear without renaming IDs.
            return web.FileResponse(path, headers={"Cache-Control": "no-cache",
                                                   "X-Content-Type-Options": "nosniff"})
        except GalleryError as exc:
            return web.json_response({"error": str(exc)}, status=404)

    @routes.get("/pose_gallery/settings")
    async def get_settings(request):
        try:
            return web.json_response(await asyncio.to_thread(read_settings),
                                     headers={"Cache-Control": "no-store"})
        except GalleryError as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post("/pose_gallery/settings")
    async def put_settings(request):
        # A local directory change must originate from this UI, not another website.
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc != request.host:
            return web.json_response({"error": "素材设置仅接受同站请求。"}, status=403)
        if request.content_type != "application/json":
            return web.json_response({"error": "请使用 JSON 提交素材设置。"}, status=415)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise GalleryError("素材设置须为对象。")
            settings = await asyncio.to_thread(save_settings, body.get("custom_directory", ""))
            return web.json_response(settings)
        except (GalleryError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            logger.exception("Pose Gallery could not save settings")
            return web.json_response({"error": "无法保存设置，请检查 ComfyUI 用户目录的写入权限。"}, status=500)
