"""
Backend helpers for the Edit Page's Upscale tab (no node, only two small routes):

  POST /lightcraft/finish/clean    the TEMP "decimate" button: deletes the Edit Page's and ComfyUI's old temp pictures, but never the ones of the edit in progress
  POST /lightcraft/finish/tempinfo how much that would free (shown on the button)
  POST /lightcraft/finish/fixmeta  after an upscale: makes sure the new "_up" webp carries the ORIGINAL's full metadata
                                   (prompt + workflow + parameters) and adds one line saying it was upscaled

Everything here is best effort: a failure leaves the Image Saver's own file untouched.
"""
import io
import os
import re
import struct
import tempfile

try:
    import folder_paths
except ImportError:  # outside ComfyUI
    folder_paths = None

TEMP_PREFIXES = ("lc_src_", "lc_hist_", "lc_before_", "lc_after_", "ComfyUI_temp_")   # the Edit Page's pictures + the preview pictures ComfyUI itself leaves
MIN_AGE = 90                                            # seconds: anything newer may belong to a render that is running right now
UP_RE = re.compile(r"_up(_\d+)?$")


# ---------------------------------------------------------------- temp clean-up
def _temp_files(temp_dir, keep=()):
    """(path, size) of every temp picture that may be deleted: not in keep, and not brand new."""
    import time
    out, now, keep = [], time.time(), set(keep or ())
    try:
        names = os.listdir(temp_dir)
    except OSError:
        return out
    for f in names:
        if not f.startswith(TEMP_PREFIXES) or f in keep:
            continue
        p = os.path.join(temp_dir, f)
        try:
            if os.path.isfile(p) and now - os.path.getmtime(p) >= MIN_AGE:
                out.append((p, os.path.getsize(p)))
        except OSError:
            pass
    return out


def temp_info(temp_dir, keep=()):
    fs = _temp_files(temp_dir, keep)
    return len(fs), sum(s for _p, s in fs)


def clean_temp(temp_dir, keep=()):
    """Delete the temp pictures except the ones in keep (the edit you are working on). Returns (files, bytes)."""
    n = size = 0
    for p, s in _temp_files(temp_dir, keep):
        try:
            os.remove(p)
            n += 1
            size += s
        except OSError:
            pass
    return n, size


# ---------------------------------------------------------------- webp EXIF swap (no re-encode)
def _chunks(data):
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not a webp")
    out, i = [], 12
    while i + 8 <= len(data):
        tag = data[i:i + 4]
        ln = struct.unpack("<I", data[i + 4:i + 8])[0]
        out.append((tag, data[i + 8:i + 8 + ln]))
        i += 8 + ln + (ln & 1)
    return out


def _build(chunks):
    body = b"WEBP"
    for tag, payload in chunks:
        body += tag + struct.pack("<I", len(payload)) + payload + (b"\0" if len(payload) & 1 else b"")
    return b"RIFF" + struct.pack("<I", len(body)) + body


def get_exif(data):
    for tag, payload in _chunks(data):
        if tag == b"EXIF":
            return payload
    return None


def set_exif(data, exif):
    """Return the webp bytes with the EXIF chunk replaced (or added, which needs the extended VP8X header)."""
    chunks = _chunks(data)
    if not any(t == b"VP8X" for t, _ in chunks):
        raise ValueError("simple webp without an extended header")
    out, done = [], False
    for tag, payload in chunks:
        if tag == b"EXIF":
            if not done:
                out.append((b"EXIF", exif))
                done = True
            continue
        if tag == b"VP8X":
            payload = bytes([payload[0] | 0x08]) + payload[1:]            # EXIF flag
        out.append((tag, payload))
    if not done:
        at = len(out)
        for i, (t, _) in enumerate(out):                                   # EXIF goes after the picture data, before XMP
            if t == b"XMP ":
                at = i
                break
        out.insert(at, (b"EXIF", exif))
    return _build(out)


def _map_comment(exif, fn):
    """Run fn(text) -> text over the A1111-style parameters text (ExifIFD UserComment); returns new exif bytes (or the same on any trouble)."""
    try:
        from PIL import Image
        ex = Image.Exif()
        ex.load(exif if exif[:6] == b"Exif\0\0" else b"Exif\0\0" + exif)
        ifd = ex.get_ifd(0x8769)
        raw = ifd.get(0x9286)
        if isinstance(raw, bytes):
            if raw[:8] == b"UNICODE\0":
                body = raw[8:]
                try:
                    text = body.decode("utf-16-be") if body[:2] != b"\xff\xfe" and body[:2] != b"\xfe\xff" else body.decode("utf-16")
                except UnicodeDecodeError:
                    text = body.decode("utf-16-le", "replace")
            else:
                text = raw.decode("utf-8", "replace")
        elif isinstance(raw, str):
            text = raw
        else:
            return exif
        new = fn(text)
        if new == text:
            return exif
        ifd[0x9286] = b"UNICODE\0" + new.encode("utf-16-be")
        out = ex.tobytes()
        return out[6:] if out[:6] == b"Exif\0\0" else out
    except Exception as e:
        print("[LightCraft] could not edit the metadata text:", e)
        return exif


def with_upscale_note(exif, note):
    """Append one line to the parameters text (once)."""
    return _map_comment(exif, lambda t: t if note in t else t.rstrip() + ", " + note)


SIZE_RE = re.compile(r"(Size:\s*)\d+\s*x\s*\d+")


def with_size(exif, w, h):
    """Make the 'Size: WxH' field say the size the saved file really has (an upscale / outpaint changes it)."""
    return _map_comment(exif, lambda t: SIZE_RE.sub(lambda m: f"{m.group(1)}{int(w)}x{int(h)}", t, count=1))


def fix_meta(orig_path, up_path, note=""):
    """Give up_path the full EXIF of orig_path (+ note). Writes to a temp file, checks it opens, then swaps atomically."""
    with open(orig_path, "rb") as f:
        exif = get_exif(f.read())
    if not exif:
        return False, "the original has no metadata block"
    from PIL import Image
    try:
        with Image.open(up_path) as im0:
            exif = with_size(exif, *im0.size)            # Size: now shows the saved picture's real size
    except Exception as e:
        print("[LightCraft] could not read the new picture's size:", e)
    if note:
        exif = with_upscale_note(exif, note)
    with open(up_path, "rb") as f:
        new = set_exif(f.read(), exif)
    fd, tmp = tempfile.mkstemp(suffix=".webp", dir=os.path.dirname(up_path))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(new)
        with Image.open(tmp) as im:
            im.load()
        os.replace(tmp, up_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return True, "ok"


def _safe_output(rel):
    base = os.path.realpath(folder_paths.get_output_directory())
    p = os.path.realpath(os.path.join(base, rel))
    if p != base and not p.startswith(base + os.sep):
        raise ValueError("outside the output folder")
    return p


def register_routes():
    from aiohttp import web
    from server import PromptServer
    routes = PromptServer.instance.routes

    @routes.post("/lightcraft/finish/clean")
    async def _clean(request):
        try:
            keep = (await request.json()).get("keep") or []
        except Exception:
            keep = []
        n, size = clean_temp(folder_paths.get_temp_directory(), [os.path.basename(str(k)) for k in keep])
        return web.json_response({"files": n, "mb": round(size / 1048576, 1)})

    @routes.post("/lightcraft/finish/tempinfo")
    async def _tempinfo(request):
        try:
            keep = (await request.json()).get("keep") or []
        except Exception:
            keep = []
        n, size = temp_info(folder_paths.get_temp_directory(), [os.path.basename(str(k)) for k in keep])
        return web.json_response({"files": n, "mb": round(size / 1048576, 1)})

    @routes.post("/lightcraft/finish/fixmeta")
    async def _fixmeta(request):
        try:
            b = await request.json()
            sub = (b.get("path") or "").strip("/\\")
            osub = (b.get("orig_path", b.get("path")) or "").strip("/\\")
            orig = _safe_output(os.path.join(osub, b["orig"]))
            up = _safe_output(os.path.join(sub, b["up"]))
            ok, msg = fix_meta(orig, up, b.get("note", ""))
            return web.json_response({"ok": ok, "message": msg})
        except Exception as e:
            print("[LightCraft] fixmeta skipped:", e)
            return web.json_response({"ok": False, "message": str(e)})
