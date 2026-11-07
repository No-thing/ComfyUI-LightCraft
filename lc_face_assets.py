"""
The Face tab finds landmarks in the browser with Google's MediaPipe Face Landmarker (Apache 2.0 code).
Nothing is bundled in this pack: the first time you press "Find face" the files below are downloaded once into
./face_assets/ (about 12 MB) and served from there, so later runs work offline.

If the download is blocked, put the files into the face_assets folder by hand (same names).
"""
import asyncio
import os
import urllib.request

HERE = os.path.join(os.path.dirname(__file__), "face_assets")
VERSIONS = ("0.10.21", "0.10.18", "0.10.14")
_NPM = ["https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@{v}/", "https://unpkg.com/@mediapipe/tasks-vision@{v}/"]
# name -> (path inside the npm package or full url, smallest believable size in bytes)
FILES = {
    "vision_bundle.mjs": ("vision_bundle.mjs", 100_000),
    "vision_wasm_internal.js": ("wasm/vision_wasm_internal.js", 10_000),
    "vision_wasm_internal.wasm": ("wasm/vision_wasm_internal.wasm", 1_000_000),
    "vision_wasm_nosimd_internal.js": ("wasm/vision_wasm_nosimd_internal.js", 10_000),
    "vision_wasm_nosimd_internal.wasm": ("wasm/vision_wasm_nosimd_internal.wasm", 1_000_000),
    "face_landmarker.task": ("https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", 1_000_000),
}
TYPES = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream"}


def missing():
    return [n for n, (_, lo) in FILES.items() if not os.path.exists(os.path.join(HERE, n)) or os.path.getsize(os.path.join(HERE, n)) < lo]


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "LightCraft-Face/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def download():
    """Fetch what is missing. Returns (ok, message)."""
    os.makedirs(HERE, exist_ok=True)
    errors = []
    for name in missing():
        src, lo = FILES[name]
        urls = [src] if src.startswith("http") else [b.format(v=v) + src for v in VERSIONS for b in _NPM]
        data = None
        for u in urls:
            try:
                blob = _get(u)
                if len(blob) >= lo and (not name.endswith(".wasm") or blob[:4] == b"\0asm"):
                    data = blob
                    break
                errors.append(f"{u}: unexpected file")
            except Exception as e:
                errors.append(f"{u}: {e}")
        if data is None:
            return False, f"Could not download {name}. Put it into {HERE} by hand. ({errors[-1] if errors else ''})"
        tmp = os.path.join(HERE, name + ".part")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(HERE, name))
    return True, "ready"


def register_routes():
    from aiohttp import web
    from server import PromptServer
    routes = PromptServer.instance.routes

    @routes.get("/lightcraft/face_setup")
    async def face_status(request):
        m = missing()
        return web.json_response({"ready": not m, "missing": m})

    @routes.post("/lightcraft/face_setup")
    async def face_setup(request):
        ok, msg = await asyncio.get_running_loop().run_in_executor(None, download)
        m = missing()
        return web.json_response({"ready": not m, "missing": m, "error": None if ok else msg}, status=200 if ok else 502)

    @routes.get("/lightcraft/face_file/{name}")
    async def face_file(request):
        name = request.match_info["name"]
        if name not in FILES:
            return web.Response(status=404)
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            return web.Response(status=404)
        return web.FileResponse(path, headers={"Content-Type": TYPES.get(os.path.splitext(name)[1], "application/octet-stream"),
                                               "Cache-Control": "max-age=86400"})
