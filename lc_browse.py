"""
LightCraft Browse back end: lists the pictures in ComfyUI's output folder and makes small cached thumbnails, so the
Browse tab works on its own (no other pack needed).

Only ComfyUI's output folder can be read. Star ratings are kept in ONE json file in ComfyUI's user folder
(user/lightcraft/library.json), never next to your pictures; the Upscaler Station uses the same file, so ratings are shared.
Thumbnails are small cached webp files in user/lightcraft/thumbs (trimmed oldest first above 500 MB).
"""
import hashlib
import json
import os
import tempfile
import threading

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
CACHE_MAX = 500 * 1024 * 1024
LIST_LIMIT = 3000                      # a folder with more pictures than this is cut off instead of freezing the page
_lock = threading.RLock()


class BrowseError(Exception):
    pass


class Browse:
    def __init__(self, data_dir, output_dir):
        self.dir = data_dir
        self.thumb_dir = os.path.join(data_dir, "thumbs")
        os.makedirs(self.thumb_dir, exist_ok=True)
        self.db_path = os.path.join(data_dir, "library.json")
        self.root = os.path.realpath(output_dir)
        self._made = 0
        self.trim()

    # ------------------------------------------------------------ storage (re-read before every change, so another pack's edits are kept)
    def _read(self):
        try:
            with open(self.db_path, "r", encoding="utf-8") as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

    def _write(self, d):
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f)
        os.replace(tmp, self.db_path)

    def mark_of(self, marks, p):
        m = marks.get(p) or {}
        return m.get("r", 0), m.get("f", ""), m.get("l", "")

    # ------------------------------------------------------------ safety
    def safe(self, path):
        p = os.path.realpath(path or "")
        if p == self.root or p.startswith(self.root.rstrip("/\\") + os.sep):
            return p
        raise BrowseError("That path is outside the ComfyUI output folder.")

    def roots(self):
        return [{"path": self.root, "name": os.path.basename(self.root.rstrip("/\\")) or self.root, "removable": False}]

    # ------------------------------------------------------------ listing
    def list_dir(self, path):
        """One folder, never deeper: the pictures directly in it and its sub-folders as names only."""
        base = self.safe(path)
        marks = self._read().get("marks", {})
        dirs, files, truncated = [], [], False
        with os.scandir(base) as it:
            for e in sorted(it, key=lambda e: e.name.lower()):
                if e.name.startswith("."):
                    continue
                if e.is_dir(follow_symlinks=False):
                    dirs.append(e.path)
                elif os.path.splitext(e.name)[1].lower() in IMG_EXT:
                    if len(files) >= LIST_LIMIT:
                        truncated = True
                        break
                    try:
                        st = os.stat(e.path)
                        r, f, l = self.mark_of(marks, e.path)
                        files.append({"name": e.name, "path": e.path, "size": st.st_size, "mtime": int(st.st_mtime), "r": r, "f": f, "l": l})
                    except OSError:
                        pass
        return {"path": base, "dirs": [{"name": os.path.basename(d), "path": d, "n": ""} for d in dirs], "files": files, "truncated": truncated}

    # ------------------------------------------------------------ stars
    def set_rating(self, paths, rating):
        with _lock:
            d = self._read()
            marks = d.setdefault("marks", {})
            for raw in paths:
                p = self.safe(raw)
                m = dict(marks.get(p) or {})
                m["r"] = max(0, min(5, int(rating)))
                m = {k: v for k, v in m.items() if v}
                if m:
                    marks[p] = m
                else:
                    marks.pop(p, None)
            self._write(d)

    # ------------------------------------------------------------ images
    def _cached(self, path, tag, size, quality):
        p = self.safe(path)
        st = os.stat(p)
        key = hashlib.sha1(f"{p}|{st.st_mtime_ns}|{st.st_size}|{tag}{size}".encode()).hexdigest()
        out = os.path.join(self.thumb_dir, key + ".webp")
        if not os.path.exists(out):
            with Image.open(p) as im:
                im.draft("RGB", (size * 2, size * 2))
                im = ImageOps.exif_transpose(im)
                im.thumbnail((size, size), Image.LANCZOS)
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGB")
                tmp = out + ".part"
                im.save(tmp, "WEBP", quality=quality, method=4)
            os.replace(tmp, out)
            self._made += 1
            if self._made % 100 == 0:
                self.trim()
        else:
            try:
                os.utime(out)
            except OSError:
                pass
        return out

    def thumb(self, path, size=320):
        return self._cached(path, "t", max(64, min(640, int(size))), 78)

    def preview(self, path, size=2048):
        return self._cached(path, "p", max(512, min(4096, int(size))), 90)

    def meta(self, path):
        p = self.safe(path)
        with Image.open(p) as im:
            w, h = im.size
            fmt = im.format
        st = os.stat(p)
        r, f, l = self.mark_of(self._read().get("marks", {}), p)
        return {"path": p, "name": os.path.basename(p), "w": w, "h": h, "format": fmt, "size": st.st_size,
                "mtime": int(st.st_mtime), "r": r, "f": f, "l": l}

    def trim(self):
        try:
            fs = []
            for n in os.listdir(self.thumb_dir):
                if n.endswith(".webp"):
                    p = os.path.join(self.thumb_dir, n)
                    s = os.stat(p)
                    fs.append((s.st_mtime, s.st_size, p))
            total = sum(s for _m, s, _p in fs)
            for _m, s, p in sorted(fs):
                if total <= CACHE_MAX * 0.8:
                    break
                os.remove(p)
                total -= s
        except OSError:
            pass


# ---------------------------------------------------------------- routes
_b = None


def _browse():
    global _b
    import folder_paths
    if _b is None:
        data = os.path.join(folder_paths.get_user_directory(), "lightcraft")
        os.makedirs(data, exist_ok=True)
        _b = Browse(data, folder_paths.get_output_directory())
    return _b


def register_routes():
    from aiohttp import web
    from server import PromptServer
    routes = PromptServer.instance.routes

    def guard(fn):
        async def run(request):
            try:
                return await fn(request)
            except BrowseError as e:
                return web.json_response({"error": str(e)}, status=400)
            except FileNotFoundError:
                return web.json_response({"error": "File not found."}, status=404)
            except Exception as e:
                return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)
        return run

    @routes.get("/lightcraft/lib/roots")
    @guard
    async def _roots(request):
        return web.json_response({"roots": _browse().roots()})

    @routes.get("/lightcraft/lib/list")
    @guard
    async def _list(request):
        return web.json_response(_browse().list_dir(request.query.get("path", "")))

    @routes.get("/lightcraft/lib/thumb")
    @guard
    async def _thumb(request):
        p = _browse().thumb(request.query.get("path", ""), request.query.get("s", 320))
        return web.FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @routes.get("/lightcraft/lib/preview")
    @guard
    async def _preview(request):
        p = _browse().preview(request.query.get("path", ""), request.query.get("s", 2048))
        return web.FileResponse(p, headers={"Cache-Control": "public, max-age=3600"})

    @routes.get("/lightcraft/lib/meta")
    @guard
    async def _meta(request):
        return web.json_response(_browse().meta(request.query.get("path", "")))

    @routes.post("/lightcraft/lib/mark")
    @guard
    async def _mark(request):
        b = await request.json()
        _browse().set_rating(b.get("paths", []), b.get("rating") or 0)
        return web.json_response({"ok": True})
