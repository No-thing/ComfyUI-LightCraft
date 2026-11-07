"""
Preset tables. These are slider recipes (not .cube files): picking one in the node fills the
sliders with these values, so every look stays editable.
Keys not listed in a preset fall back to the slider default.
"""
import json
import os

NONE = "- none (neutral) -"


def _g(**k):
    return k


# hue guide: 0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 210 teal-blue, 240 blue, 280 purple, 320 pink
GRADE = {
    "Teal & Orange": _g(contrast=18, saturation=8, vibrance=15, shadows_hue=195, shadows_sat=45, highlights_hue=30, highlights_sat=40, grade_blending=55),
    "Blockbuster": _g(contrast=28, saturation=-6, temperature=4, fade=4, shadows_hue=200, shadows_sat=55, highlights_hue=35, highlights_sat=45, grade_blending=40),
    "Cinematic Teal": _g(contrast=15, saturation=-8, shadows_hue=185, shadows_sat=50, midtones_hue=190, midtones_sat=12, highlights_hue=55, highlights_sat=18, grade_balance=-10),
    "Golden Hour": _g(exposure=0.15, temperature=28, contrast=8, vibrance=18, shadows_hue=25, shadows_sat=25, midtones_hue=35, midtones_sat=18, highlights_hue=42, highlights_sat=45, grade_balance=20),
    "Warm Sunset": _g(temperature=35, tint=6, contrast=12, saturation=8, shadows_hue=350, shadows_sat=30, midtones_hue=20, midtones_sat=15, highlights_hue=28, highlights_sat=50),
    "Moody Blue": _g(exposure=-0.2, contrast=20, saturation=-12, temperature=-22, fade=6, shadows_hue=225, shadows_sat=50, midtones_hue=215, midtones_sat=15, highlights_hue=200, highlights_sat=20),
    "Faded Matte": _g(contrast=-10, saturation=-12, fade=45, shadows_hue=210, shadows_sat=18, highlights_hue=40, highlights_sat=18),
    "Portra-style 400": _g(exposure=0.1, contrast=6, saturation=-6, vibrance=10, temperature=10, tint=3, fade=10, shadows_hue=190, shadows_sat=12, midtones_hue=25, midtones_sat=10, highlights_hue=40, highlights_sat=25),
    "Velvia-style Vivid": _g(contrast=22, saturation=28, vibrance=12, temperature=3, shadows_hue=250, shadows_sat=10, highlights_hue=50, highlights_sat=12),
    "Gold 200 Warm Film": _g(temperature=22, contrast=8, saturation=6, fade=14, shadows_hue=30, shadows_sat=20, highlights_hue=50, highlights_sat=38),
    "Tungsten 800 Film": _g(temperature=-12, tint=-4, contrast=14, saturation=4, fade=8, shadows_hue=205, shadows_sat=45, highlights_hue=12, highlights_sat=45),
    "Green Film Cast": _g(temperature=-4, tint=-10, contrast=10, saturation=8, fade=12, shadows_hue=140, shadows_sat=22, midtones_hue=130, midtones_sat=10, highlights_hue=80, highlights_sat=20),
    "Classic B&W": _g(bw=100, contrast=22, fade=4),
    "Noir High Contrast": _g(bw=100, contrast=55, exposure=-0.15),
    "Silver Soft B&W": _g(bw=100, contrast=-8, fade=18, exposure=0.1),
    "Sepia": _g(bw=100, contrast=8, fade=12, shadows_hue=30, shadows_sat=55, midtones_hue=35, midtones_sat=45, highlights_hue=42, highlights_sat=38, grade_blending=70),
    "Selenium Tone": _g(bw=100, contrast=15, shadows_hue=260, shadows_sat=30, highlights_hue=40, highlights_sat=12),
    "Vintage 70s": _g(temperature=18, tint=5, contrast=-6, saturation=-10, fade=30, shadows_hue=30, shadows_sat=30, midtones_hue=40, midtones_sat=12, highlights_hue=55, highlights_sat=38),
    "Polaroid": _g(exposure=0.1, contrast=-6, saturation=-8, temperature=8, fade=28, shadows_hue=175, shadows_sat=25, highlights_hue=45, highlights_sat=30),
    "Cross Process": _g(contrast=25, saturation=15, temperature=-6, tint=8, shadows_hue=170, shadows_sat=40, midtones_hue=120, midtones_sat=12, highlights_hue=55, highlights_sat=50),
    "Bleach Bypass": _g(contrast=40, saturation=-45, vibrance=-5),
    "Cyberpunk Neon": _g(contrast=25, saturation=20, vibrance=20, shadows_hue=280, shadows_sat=60, midtones_hue=320, midtones_sat=18, highlights_hue=185, highlights_sat=50),
    "Vaporwave": _g(contrast=6, saturation=10, fade=14, shadows_hue=270, shadows_sat=50, midtones_hue=310, midtones_sat=20, highlights_hue=175, highlights_sat=45),
    "Synthwave": _g(exposure=-0.15, contrast=22, saturation=14, shadows_hue=265, shadows_sat=60, highlights_hue=330, highlights_sat=55),
    "Matrix Green": _g(contrast=20, saturation=-10, tint=-25, shadows_hue=135, shadows_sat=50, midtones_hue=120, midtones_sat=25, highlights_hue=110, highlights_sat=30),
    "Hazy Replicant": _g(exposure=-0.2, contrast=18, temperature=8, fade=12, shadows_hue=190, shadows_sat=45, midtones_hue=25, midtones_sat=20, highlights_hue=28, highlights_sat=55),
    "Pastel Dream": _g(exposure=0.25, contrast=-18, saturation=-8, vibrance=12, fade=30, shadows_hue=320, shadows_sat=20, midtones_hue=300, midtones_sat=10, highlights_hue=50, highlights_sat=25),
    "Storybook Pastel": _g(temperature=12, contrast=4, saturation=12, vibrance=15, fade=10, shadows_hue=350, shadows_sat=22, midtones_hue=40, midtones_sat=12, highlights_hue=45, highlights_sat=28),
    "Autumn Warm": _g(temperature=20, contrast=10, saturation=10, vibrance=14, shadows_hue=20, shadows_sat=30, highlights_hue=38, highlights_sat=35),
    "Winter Cold": _g(exposure=0.1, temperature=-26, contrast=10, saturation=-10, shadows_hue=220, shadows_sat=35, highlights_hue=200, highlights_sat=22),
    "Summer Pop": _g(exposure=0.15, temperature=10, contrast=12, saturation=18, vibrance=18, shadows_hue=190, shadows_sat=15, highlights_hue=50, highlights_sat=25),
    "Tropical": _g(contrast=10, saturation=20, vibrance=12, tint=-6, shadows_hue=175, shadows_sat=35, highlights_hue=60, highlights_sat=25),
    "Desert Dust": _g(temperature=24, contrast=6, saturation=-10, fade=16, shadows_hue=25, shadows_sat=28, highlights_hue=45, highlights_sat=32),
    "Forest Green": _g(exposure=-0.1, contrast=10, saturation=4, tint=-12, shadows_hue=150, shadows_sat=35, midtones_hue=130, midtones_sat=12, highlights_hue=85, highlights_sat=22),
    "Deep Ocean": _g(temperature=-18, contrast=16, saturation=8, shadows_hue=215, shadows_sat=55, midtones_hue=200, midtones_sat=15, highlights_hue=180, highlights_sat=20),
    "Rose Gold": _g(temperature=12, tint=8, saturation=-6, fade=14, shadows_hue=350, shadows_sat=30, midtones_hue=10, midtones_sat=15, highlights_hue=25, highlights_sat=40),
    "Moonlight": _g(exposure=-0.35, temperature=-24, contrast=10, saturation=-14, shadows_hue=235, shadows_sat=55, midtones_hue=225, midtones_sat=18, highlights_hue=210, highlights_sat=28),
    "Night City": _g(exposure=-0.25, contrast=24, saturation=6, vibrance=12, shadows_hue=230, shadows_sat=55, highlights_hue=25, highlights_sat=45),
    "Film Noir Blue": _g(bw=70, contrast=40, exposure=-0.15, shadows_hue=220, shadows_sat=40, highlights_hue=200, highlights_sat=10),
    "Muted Earth": _g(contrast=4, saturation=-22, vibrance=8, temperature=10, fade=14, shadows_hue=30, shadows_sat=22, highlights_hue=55, highlights_sat=18),
    "Clean Commercial": _g(exposure=0.2, contrast=12, saturation=6, vibrance=14, temperature=-2),
    "Fashion Editorial": _g(exposure=0.05, contrast=30, saturation=-28, shadows_hue=210, shadows_sat=10, highlights_hue=40, highlights_sat=12),
    "Warm Skin Glow": _g(exposure=0.15, contrast=-4, vibrance=12, temperature=14, tint=4, shadows_hue=10, shadows_sat=20, highlights_hue=38, highlights_sat=30),
    "Cool Skin Fresh": _g(contrast=6, vibrance=10, temperature=-10, tint=-2, shadows_hue=200, shadows_sat=20, highlights_hue=45, highlights_sat=10),
    "HDR Punch": _g(contrast=32, saturation=18, vibrance=25),
    "Lo-Fi Washed": _g(contrast=-14, saturation=-20, temperature=6, fade=40, shadows_hue=200, shadows_sat=20, highlights_hue=40, highlights_sat=20),
    "Retro VHS": _g(contrast=8, saturation=12, temperature=-6, tint=8, fade=20, shadows_hue=185, shadows_sat=40, highlights_hue=330, highlights_sat=35),
    "Day for Night": _g(exposure=-0.8, contrast=22, saturation=-18, temperature=-30, shadows_hue=230, shadows_sat=55, midtones_hue=220, midtones_sat=20, highlights_hue=210, highlights_sat=25),
    "Emerald City": _g(contrast=14, saturation=8, tint=-14, shadows_hue=160, shadows_sat=45, midtones_hue=150, midtones_sat=15, highlights_hue=100, highlights_sat=25),
    "Amber Whiskey": _g(exposure=-0.1, contrast=16, saturation=-4, temperature=30, fade=6, shadows_hue=20, shadows_sat=45, midtones_hue=30, midtones_sat=18, highlights_hue=40, highlights_sat=50),
}

# Instagram-style filters, glow / lens / grain looks
FX = {
    "Vivid Pop": _g(filter_contrast=20, filter_saturation=30, sharpen=20, vignette=-15),
    "Warm Fade": _g(filter_warmth=25, filter_fade=25, filter_contrast=-5, filter_saturation=-5, vignette=-20),
    "Cool Fade": _g(filter_warmth=-25, filter_fade=28, filter_saturation=-8, tint_hue=210, tint_amount=15, vignette=-20),
    "Mono Punch": _g(filter_saturation=-100, filter_contrast=18, vignette=-25),
    "Retro Leak": _g(filter_warmth=15, filter_fade=20, filter_saturation=5, light_leak=55, vignette=-25),
    "Dreamy Glow": _g(glow_amount=55, glow_radius=55, glow_threshold=45, filter_fade=10, filter_saturation=8, filter_contrast=-8),
    "VHS Tape": _g(chromatic_aberration=40, lens_distortion=8, filter_saturation=10, tint_hue=320, tint_amount=12, filter_fade=18, glow_amount=15),
    "Disposable Camera": _g(filter_contrast=18, filter_warmth=12, filter_saturation=12, vignette=-35, glow_amount=18, light_leak=25, lens_distortion=5),
    "90s Camcorder": _g(chromatic_aberration=25, filter_fade=22, filter_saturation=-8, vignette=-22, glow_amount=20, lens_distortion=10),
    "Hazy Summer": _g(glow_amount=40, glow_radius=60, glow_threshold=40, filter_fade=18, filter_warmth=15, filter_saturation=10, filter_contrast=-10),
    "Golden Glow": _g(filter_warmth=30, tint_hue=40, tint_amount=20, glow_amount=45, glow_radius=50, glow_threshold=50, vignette=-15),
    "Rosy": _g(tint_hue=345, tint_amount=28, filter_fade=15, glow_amount=25, filter_saturation=8, filter_warmth=8),
    "Moody Vignette": _g(filter_contrast=22, filter_saturation=-12, vignette=-55, vignette_midpoint=35, vignette_feather=70),
    "Chrome": _g(filter_contrast=30, filter_saturation=-15, sharpen=30, vignette=-10),
    "Lomo": _g(filter_contrast=28, filter_saturation=30, filter_warmth=8, vignette=-60, vignette_midpoint=30, vignette_feather=55, chromatic_aberration=12),
    "Cross Glow": _g(tint_hue=160, tint_amount=18, filter_contrast=20, glow_amount=35, filter_saturation=15, halation=30),
    "Hot Leak": _g(light_leak=80, halation=40, filter_warmth=20, filter_fade=15, filter_contrast=10),
    "Anime Halftone": _g(comic_dots=70, comic_dot_size=30, comic_dot_below=55, filter_contrast=8, comic_poster=15),
    "Manga Screentone": _g(comic_dots=85, comic_dot_size=28, comic_dot_below=65, filter_saturation=-100, filter_contrast=24, sharpen=25),
    "Spider-Verse": _g(comic_hatch=65, comic_hatch_density=55, comic_light_dots=55, comic_light_above=70, comic_dots=30, comic_dot_below=45, comic_offset=40, comic_poster=30, filter_saturation=18, filter_contrast=12),
    "Pop Art Dots": _g(comic_dots=60, comic_dot_size=55, comic_dot_angle=15, comic_light_dots=70, comic_poster=45, filter_saturation=35, filter_contrast=18),
    "Anamorphic Night": _g(ana_streak=70, ana_length=60, ana_threshold=72, ana_blue=85, glow_amount=18, filter_contrast=8, vignette=-20),
    "Anamorphic Gold": _g(ana_streak=55, ana_length=45, ana_threshold=75, ana_blue=0, filter_warmth=14, halation=20, filter_fade=8),
    "Bokeh Dream": _g(bokeh_amount=60, bokeh_size=45, bokeh_threshold=72, glow_amount=15, filter_fade=8),
    "Hex Bokeh": _g(bokeh_amount=55, bokeh_size=40, bokeh_threshold=75, bokeh_blades=6, filter_contrast=6),
    "Lens Dirt City": _g(dirt_amount=70, dirt_texture=1, dirt_threshold=58, dirt_spread=40, glow_amount=12, halation=15),
    "Lens Dirt Neon": _g(dirt_amount=65, dirt_texture=2, dirt_threshold=55, dirt_spread=45, dirt_displace=15, glow_amount=15, filter_contrast=8),
    "Hex Dirt Gold": _g(dirt_amount=60, dirt_texture=3, dirt_threshold=62, dirt_spread=30, filter_warmth=10, halation=20),
    "Silver Sparkle": _g(dirt_amount=55, dirt_texture=6, dirt_threshold=60, dirt_spread=30, dirt_tint=40, dirt_tint_hue=210),
    "Dusty Print": _g(film_dust=45, film_scratches=30, filter_fade=14, filter_warmth=8, vignette=-20),
    "Pixel Sort Glitch": _g(sort_amount=60, sort_low=20, sort_high=75),
    "Pixel Sort Vertical Rain": _g(sort_amount=45, sort_low=30, sort_high=80, sort_vertical=1),
    "Leaky Camera": _g(light_leak=70, filter_warmth=10, filter_fade=14, filter_saturation=6, vignette=-20),
    "Expired Roll": _g(light_leak=55, filter_warmth=16, filter_fade=24, filter_contrast=-6, vignette=-30, halation=18),
    "Soft Portrait": _g(glow_amount=30, glow_radius=45, glow_threshold=55, filter_fade=8, filter_contrast=-8, filter_warmth=6),
    "Sharp HDR": _g(sharpen=70, filter_contrast=28, filter_saturation=22),
    "Glitch Fringe": _g(chromatic_aberration=85, lens_distortion=-8, sharpen=20),
    "Halation Film": _g(halation=65, glow_amount=15, filter_warmth=8, filter_contrast=10, filter_fade=8),
    "Fisheye Fun": _g(lens_distortion=70, vignette=-25, chromatic_aberration=20, filter_saturation=10),
    "Blue Hour Glow": _g(filter_warmth=-20, tint_hue=220, tint_amount=20, glow_amount=35, vignette=-25),
    "Instant Photo": _g(filter_fade=30, filter_contrast=-8, filter_warmth=14, filter_saturation=-6, vignette=-30, light_leak=15),
    "Neon Bloom": _g(filter_saturation=35, filter_contrast=20, glow_amount=70, glow_radius=40, glow_threshold=35, chromatic_aberration=15),
    "Clean Soft": _g(glow_amount=20, sharpen=15, filter_fade=5, vignette=-8),
    # ---- old TV / CRT / analog damage (these also set the tv_* sliders)
    "60s TV (black & white)":   _g(filter_saturation=-100, filter_contrast=12, tv_curve=55, tv_scanlines=45, tv_scan_size=62, tv_bleed=45, tv_noise=22, tv_wobble=15, tv_ghost=25, glow_amount=25, vignette=-35),
    "70s TV (colour)":          _g(filter_saturation=10, filter_warmth=10, filter_fade=12, chromatic_aberration=12, tv_curve=48, tv_scanlines=40, tv_scan_size=58, tv_mask=30, tv_bleed=50, tv_noise=15, tv_wobble=12, tv_ghost=20, glow_amount=20, vignette=-30),
    "80s CRT TV":               _g(filter_saturation=10, filter_contrast=10, chromatic_aberration=15, glow_amount=30, halation=20, vignette=-25, tv_curve=40, tv_scanlines=50, tv_scan_size=50, tv_mask=40, tv_bleed=40, tv_noise=10, tv_wobble=6),
    "90s TV":                   _g(chromatic_aberration=8, glow_amount=15, vignette=-18, tv_curve=25, tv_scanlines=45, tv_scan_size=42, tv_mask=25, tv_bleed=28, tv_noise=6),
    "Late 90s Flat CRT":        _g(tv_curve=12, tv_scanlines=32, tv_scan_size=35, tv_mask=18, tv_bleed=15, tv_noise=3, glow_amount=10),
    "Analog TV":                _g(glow_amount=20, vignette=-25, tv_curve=35, tv_scanlines=40, tv_mask=25, tv_bleed=38, tv_noise=20, tv_wobble=14, tv_ghost=18),
    "Dying TV":                 _g(filter_saturation=-35, filter_fade=15, glow_amount=20, tv_curve=40, tv_scanlines=40, tv_bleed=55, tv_noise=55, tv_wobble=40, tv_ghost=35, tv_dropouts=35),
    "Analog Damage":            _g(filter_saturation=-15, filter_fade=20, chromatic_aberration=35, tv_bleed=45, tv_noise=35, tv_wobble=30, tv_ghost=25, tv_dropouts=55),
    "Bad Antenna":              _g(filter_saturation=-20, tv_curve=30, tv_scanlines=35, tv_bleed=35, tv_noise=70, tv_wobble=30, tv_ghost=55),
    "VHS Worn Tape":            _g(filter_saturation=8, filter_fade=20, chromatic_aberration=30, glow_amount=15, tv_scanlines=15, tv_bleed=60, tv_noise=25, tv_wobble=35, tv_ghost=20, tv_dropouts=60),
    "Green Phosphor Monitor":   _g(filter_saturation=-100, tint_hue=120, tint_amount=100, glow_amount=45, halation=25, tv_curve=45, tv_scanlines=55, tv_mask=20, tv_noise=8),
    "Amber Terminal":           _g(filter_saturation=-100, tint_hue=38, tint_amount=100, glow_amount=45, halation=25, tv_curve=45, tv_scanlines=55, tv_mask=20, tv_noise=8),
    "Arcade CRT":               _g(filter_saturation=25, filter_contrast=15, glow_amount=40, vignette=-20, tv_curve=45, tv_scanlines=55, tv_scan_size=55, tv_mask=60, tv_bleed=20),
    "Security Monitor":         _g(filter_saturation=-100, filter_contrast=15, filter_fade=10, vignette=-35, tv_curve=30, tv_scanlines=40, tv_bleed=30, tv_noise=25, tv_wobble=10, tv_dropouts=15),
}


# Basic film grain looks (amount / size / roughness / colour share / tonal response)
GRAIN = {
    # fine grain first
    "Ultra Fine Clean":      _g(grain_amount=12, grain_size=0, grain_roughness=20),
    "Ultra Fine Silk":       _g(grain_amount=18, grain_size=0, grain_roughness=0, grain_tonal=-10),
    "Fine Portrait":         _g(grain_amount=16, grain_size=5, grain_roughness=15, grain_color=3, grain_tonal=-20),
    "Fine 35mm":             _g(grain_amount=22, grain_size=8, grain_roughness=40, grain_color=8),
    "Fine Cinema":           _g(grain_amount=26, grain_size=12, grain_roughness=55, grain_color=12),
    "Fine Mono Crisp":       _g(grain_amount=30, grain_size=4, grain_roughness=100, grain_color=0),
    "Fine Colour Noise":     _g(grain_amount=24, grain_size=6, grain_roughness=80, grain_color=55),
    "Fine Shadow Grain":     _g(grain_amount=28, grain_size=10, grain_roughness=50, grain_color=5, grain_tonal=-45),
    "Fine Highlight Grain":  _g(grain_amount=28, grain_size=10, grain_roughness=50, grain_color=5, grain_tonal=45),
    "Soft Silver":           _g(grain_amount=28, grain_size=15, grain_roughness=20),
    "Digital Noise":         _g(grain_amount=30, grain_size=3, grain_roughness=100, grain_color=70, grain_tonal=-30),
    # medium
    "Classic Film 400":      _g(grain_amount=35, grain_size=25, grain_roughness=50, grain_color=10),
    "Disposable Camera":     _g(grain_amount=38, grain_size=30, grain_roughness=55, grain_color=25),
    "Tri-X B&W":             _g(grain_amount=50, grain_size=30, grain_roughness=70, grain_color=0, grain_tonal=-15),
    "16mm Cine":             _g(grain_amount=42, grain_size=38, grain_roughness=60, grain_color=12),
    "Heavy 800 Push":        _g(grain_amount=52, grain_size=40, grain_roughness=65, grain_color=15, grain_tonal=-10),
    # coarse (kept to two)
    "Gritty Street":         _g(grain_amount=62, grain_size=48, grain_roughness=85, grain_color=5, grain_tonal=-20),
    "Super 8":               _g(grain_amount=55, grain_size=58, grain_roughness=75, grain_color=20, grain_tonal=10),
}


# Lens looks. fisheye = how far the picture bends round (0 none, 100 extreme), bend = extra barrel (+) / pincushion (-),
# zoom = crop in (>100) or pull the picture back (<100), circle = size of the black image circle (0 off, 100 = height of the frame),
# fringe = colour fringing (also the blue edge of the circle), edge_blur = soft corners, falloff = dark corners.
def _l(**k):
    return k


LENS = {
    "55mm Standard":            _l(lens_falloff=12, lens_edge_blur=6, lens_fringe=5),
    "35mm Street":              _l(lens_bend=6, lens_falloff=14, lens_edge_blur=8, lens_fringe=8),
    "50mm Fast Prime f1.4":     _l(lens_falloff=28, lens_edge_blur=14, lens_fringe=10),
    "85mm Portrait":            _l(lens_bend=-6, lens_zoom=108, lens_falloff=18, lens_edge_blur=8, lens_fringe=3),
    "135mm Telephoto":          _l(lens_bend=-12, lens_zoom=118, lens_falloff=22, lens_edge_blur=5),
    "28mm Wide":                _l(lens_fisheye=8, lens_falloff=18, lens_edge_blur=10, lens_fringe=10),
    "24mm Wide":                _l(lens_fisheye=14, lens_falloff=22, lens_edge_blur=12, lens_fringe=14),
    "16mm Ultra Wide":          _l(lens_fisheye=26, lens_zoom=104, lens_falloff=30, lens_edge_blur=16, lens_fringe=22),
    "12mm Extreme Wide":        _l(lens_fisheye=38, lens_zoom=108, lens_falloff=38, lens_edge_blur=20, lens_fringe=30),
    "Vintage Soft Lens":        _l(lens_bend=4, lens_falloff=35, lens_edge_blur=40, lens_fringe=30),
    "Cheap Kit Lens":           _l(lens_bend=10, lens_falloff=45, lens_edge_blur=35, lens_fringe=45),
    "Disposable Camera Lens":   _l(lens_fisheye=6, lens_bend=14, lens_falloff=40, lens_edge_blur=30, lens_fringe=25),
    "Phone Ultra-wide":         _l(lens_fisheye=30, lens_zoom=106, lens_falloff=25, lens_edge_blur=30, lens_fringe=18),
    "Webcam / Security Cam":    _l(lens_fisheye=34, lens_bend=8, lens_zoom=104, lens_falloff=35, lens_edge_blur=40, lens_fringe=20),
    "Action Cam Linear":        _l(lens_fisheye=40, lens_zoom=112, lens_falloff=28, lens_edge_blur=15, lens_fringe=15),
    "GoPro Wide":               _l(lens_fisheye=55, lens_zoom=108, lens_falloff=32, lens_edge_blur=18, lens_fringe=22),
    "GoPro SuperView":          _l(lens_fisheye=68, lens_zoom=112, lens_falloff=36, lens_edge_blur=20, lens_fringe=26),
    "GoPro Max Fisheye":        _l(lens_fisheye=82, lens_zoom=110, lens_falloff=40, lens_edge_blur=22, lens_fringe=30),
    "Full-frame Fisheye 15mm":  _l(lens_fisheye=88, lens_falloff=35, lens_edge_blur=20, lens_fringe=30),
    "Diagonal Fisheye 8mm":     _l(lens_fisheye=100, lens_zoom=96, lens_falloff=42, lens_edge_blur=26, lens_fringe=38),
    "Circular Fisheye":         _l(lens_fisheye=100, lens_zoom=52, lens_circle=100, lens_circle_soft=12, lens_falloff=30, lens_edge_blur=22, lens_fringe=45),
    "Circular Fisheye (wide circle)": _l(lens_fisheye=100, lens_zoom=44, lens_circle=128, lens_circle_soft=10, lens_falloff=25, lens_edge_blur=18, lens_fringe=40),
    "Peephole":                 _l(lens_fisheye=100, lens_bend=30, lens_zoom=40, lens_circle=88, lens_circle_soft=18, lens_falloff=55, lens_edge_blur=45, lens_fringe=55),
    "Mirror Ball Look":         _l(lens_fisheye=100, lens_bend=60, lens_zoom=36, lens_circle=92, lens_circle_soft=8, lens_falloff=60, lens_edge_blur=35, lens_fringe=60),
    "Pincushion Telezoom":      _l(lens_bend=-45, lens_zoom=112, lens_falloff=20, lens_edge_blur=15, lens_fringe=18),
}

# ==================================================================================================
# Classic Film + Classic Hollywood pack (LUT looks, FX and grain). Slider recipes like everything above,
# so every look stays editable. "-style" = in the spirit of a stock or process, not a copy of it.
# ==================================================================================================
GRADE.update({
    # ---- classic film stocks
    "Kodachrome-style 64":    _g(contrast=24, saturation=14, vibrance=6, temperature=10, tint=-2, fade=4, shadows_hue=15, shadows_sat=20, midtones_hue=35, midtones_sat=10, highlights_hue=50, highlights_sat=28, grade_blending=50),
    "Vision3 250D-style":     _g(exposure=0.05, contrast=10, saturation=-4, vibrance=8, temperature=6, fade=6, shadows_hue=195, shadows_sat=14, midtones_hue=30, midtones_sat=8, highlights_hue=45, highlights_sat=22),
    "Vision3 500T-style":     _g(temperature=-10, contrast=14, fade=8, shadows_hue=200, shadows_sat=38, midtones_hue=210, midtones_sat=8, highlights_hue=28, highlights_sat=40),
    "Eterna-style Muted":     _g(contrast=-2, saturation=-16, vibrance=6, tint=-4, fade=14, shadows_hue=170, shadows_sat=22, midtones_hue=140, midtones_sat=6, highlights_hue=60, highlights_sat=16),
    "Ektachrome-style":       _g(exposure=0.1, contrast=14, saturation=12, vibrance=10, temperature=-8, shadows_hue=225, shadows_sat=18, highlights_hue=50, highlights_sat=10),
    "Print 2383-style":       _g(contrast=18, saturation=-6, vibrance=6, temperature=4, fade=5, shadows_hue=200, shadows_sat=28, midtones_hue=30, midtones_sat=8, highlights_hue=38, highlights_sat=30, grade_blending=60),
    "Cinestill 800T-style":   _g(temperature=-14, contrast=12, saturation=4, vibrance=8, fade=10, shadows_hue=190, shadows_sat=45, midtones_hue=200, midtones_sat=10, highlights_hue=10, highlights_sat=48),
    "Agfa Vista-style":       _g(temperature=8, tint=-6, contrast=8, saturation=10, fade=8, shadows_hue=150, shadows_sat=20, midtones_hue=40, midtones_sat=8, highlights_hue=50, highlights_sat=30),
    # ---- classic Hollywood
    "Technicolor 3-Strip":    _g(contrast=22, saturation=32, vibrance=10, temperature=6, shadows_hue=240, shadows_sat=14, midtones_hue=20, midtones_sat=8, highlights_hue=48, highlights_sat=22),
    "Two-Strip Technicolor":  _g(contrast=14, saturation=-12, tint=-6, shadows_hue=185, shadows_sat=50, midtones_hue=10, midtones_sat=25, highlights_hue=20, highlights_sat=40, grade_blending=65),
    "Silver Screen B&W":      _g(bw=100, contrast=14, exposure=0.12, fade=10, shadows_hue=220, shadows_sat=8, highlights_hue=45, highlights_sat=6),
    "Casablanca Soft Mono":   _g(bw=100, contrast=8, exposure=0.15, fade=22),
    "Golden Age Glamour":     _g(exposure=0.2, contrast=-4, saturation=-4, vibrance=10, temperature=12, fade=10, shadows_hue=15, shadows_sat=22, midtones_hue=25, midtones_sat=14, highlights_hue=40, highlights_sat=34),
    "Western Sunset":         _g(exposure=-0.05, contrast=18, saturation=4, vibrance=14, temperature=30, fade=6, shadows_hue=15, shadows_sat=40, midtones_hue=28, midtones_sat=18, highlights_hue=38, highlights_sat=50),
    "Epic 70mm":              _g(exposure=0.05, contrast=16, saturation=6, vibrance=12, temperature=14, shadows_hue=210, shadows_sat=20, highlights_hue=42, highlights_sat=36),
    "Hitchcock Pastel":       _g(contrast=6, saturation=-4, temperature=-2, tint=-8, fade=10, shadows_hue=165, shadows_sat=24, midtones_hue=140, midtones_sat=8, highlights_hue=30, highlights_sat=24),
})

FX.update({
    # ---- film glow, halation and screen looks
    "Print Halation 2383":    _g(halation=55, glow_amount=12, glow_threshold=70, filter_warmth=6, filter_contrast=8, vignette=-12),
    "Cinestill Halation":     _g(halation=80, glow_amount=20, glow_radius=45, glow_threshold=60, filter_warmth=-6, tint_hue=10, tint_amount=8, vignette=-15),
    "Silver Screen Glow":     _g(filter_saturation=-100, glow_amount=40, glow_radius=55, glow_threshold=55, filter_contrast=10, filter_fade=6, vignette=-30, vignette_midpoint=35, vignette_feather=70),
    "Golden Age Diffusion":   _g(glow_amount=45, glow_radius=60, glow_threshold=50, filter_warmth=14, filter_fade=8, filter_contrast=-6, halation=15, vignette=-18),
    "Technicolor Punch":      _g(filter_saturation=26, filter_contrast=16, glow_amount=15, glow_threshold=65, vignette=-14, sharpen=10),
    "Epic Widescreen":        _g(vignette=-30, vignette_midpoint=40, vignette_feather=65, filter_contrast=12, filter_warmth=6, chromatic_aberration=6, halation=15),
    "Old Hollywood Fade":     _g(filter_fade=22, filter_contrast=-4, filter_warmth=10, filter_saturation=-6, vignette=-28, glow_amount=15),
    "Projector Warmth":       _g(filter_warmth=18, filter_fade=12, light_leak=18, vignette=-35, vignette_midpoint=30, vignette_feather=60, glow_amount=10),
    "Magic Hour Bloom":       _g(filter_warmth=26, tint_hue=35, tint_amount=14, glow_amount=38, glow_radius=50, glow_threshold=55, halation=25, vignette=-14),
})

GRAIN.update({
    "Kodak 5219 500T":        _g(grain_amount=38, grain_size=26, grain_roughness=50, grain_color=14, grain_tonal=-15),
    "Vision3 250D Fine":      _g(grain_amount=28, grain_size=14, grain_roughness=40, grain_color=10),
    "Double-X Cine B&W":      _g(grain_amount=45, grain_size=28, grain_roughness=65, grain_color=0, grain_tonal=-10),
    "Kodachrome Fine":        _g(grain_amount=24, grain_size=10, grain_roughness=35, grain_color=8, grain_tonal=-10),
    "35mm Print Grain":       _g(grain_amount=32, grain_size=20, grain_roughness=45, grain_color=10, grain_tonal=5),
    "Golden Age Mono":        _g(grain_amount=34, grain_size=22, grain_roughness=50, grain_color=0, grain_tonal=-25),
})

PRESETS = {"LightCraftGrade": GRADE, "LightCraftFX": FX, "LightCraftGrain": GRAIN, "LightCraftLens": LENS}


def names(table):
    return [NONE] + list(table.keys())


def slider_tables():
    from . import lc_sliders as S
    return {"LightCraftGrade": S.GRADE_SLIDERS, "LightCraftFX": S.FX_SLIDERS, "LightCraftGrain": S.GRAIN_SLIDERS, "LightCraftLens": S.LENS_SLIDERS}


def export_json():
    """Write web/presets.json so the browser extension shares this single source of truth."""
    try:
        path = os.path.join(os.path.dirname(__file__), "web", "presets.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"none": NONE, "presets": PRESETS, "sliders": slider_tables()}, f, indent=1)
    except Exception:
        pass
