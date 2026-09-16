"""Media prep helpers: tail frame/audio extraction for E5 handoff arms."""

import os
import subprocess


def nframes(video):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-count_packets", "-show_entries", "stream=nb_read_packets",
                        "-of", "csv=p=0", video], capture_output=True, text=True)
    return int(r.stdout.strip())


def extract_tail_frames(video, count, out_folder, pattern="f_%04d.png"):
    """Extract the LAST `count` frames of `video` as numbered PNGs starting at 0.
    Returns (folder, pattern, start=0, count)."""
    os.makedirs(out_folder, exist_ok=True)
    n = nframes(video)
    start = n - count
    for i in range(count):
        p = os.path.join(out_folder, pattern % i)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                        "-vf", f"select=eq(n\\,{start + i})", "-fps_mode", "passthrough",
                        "-frames:v", "1", p], check=True)
    assert os.path.exists(os.path.join(out_folder, pattern % (count - 1)))
    return out_folder, pattern, 0, count


def extract_tail_audio(video, count_frames, out_wav):
    """Extract the audio covering the LAST count_frames (24fps) of `video`."""
    dur = count_frames / 24.0
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{-dur:.5f}",
                    "-i", video, "-vn", "-ac", "2", "-ar", "44100", out_wav],
                   check=True)
    return out_wav


def concat_videos(parts, out_path):
    """Hard-cut concat (stream copy; re-encode fallback)."""
    lst = out_path + ".txt"
    with open(lst, "w") as f:
        for p in parts:
            f.write(f"file '{os.path.abspath(p)}'\n")
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat",
                        "-safe", "0", "-i", lst, "-c", "copy", out_path],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out_path):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat",
                        "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                        "-c:a", "aac", out_path], check=True)
    return out_path
