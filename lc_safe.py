"""One place that decides which picture files LightCraft may open: only inside ComfyUI's input, output and temp folders."""
import os

import folder_paths


def safe_annotated_path(name):
    """ComfyUI's own name -> path lookup, then a check that the real file (symlinks resolved) is inside input, output or temp."""
    path = folder_paths.get_annotated_filepath(name)
    real = os.path.realpath(path)
    roots = [os.path.realpath(d) for d in (folder_paths.get_input_directory(), folder_paths.get_output_directory(), folder_paths.get_temp_directory())]
    if not any(real == r or real.startswith(r + os.sep) for r in roots):
        raise ValueError("picture is outside the ComfyUI folders")
    return path
