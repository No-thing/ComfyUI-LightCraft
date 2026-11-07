"""Sizing maths for 'upscale to the long side'. Pure python so it can be tested without ComfyUI."""


def target_size(w, h, long_side):
    """the picture ends up with its LONG side exactly `long_side`; the short side keeps the aspect ratio"""
    k = float(long_side) / max(w, h)
    return (int(long_side), max(1, int(round(h * k)))) if w >= h else (max(1, int(round(w * k))), int(long_side))


def passes_needed(w, h, long_side, model_scale, max_passes=3):
    """how many times the upscale model has to run before the picture is at least as big as the target (0 if it already is)"""
    n, cur = 0, float(max(w, h))
    while cur < long_side and n < max_passes:
        cur *= max(1, model_scale)
        n += 1
    return n


def long_side_for_megapixels(w, h, megapixels):
    """the long side that gives `megapixels` million pixels for a picture with this aspect ratio"""
    import math
    a = float(max(w, h)) / float(min(w, h))
    return int(round(math.sqrt(float(megapixels) * 1e6 * a)))
