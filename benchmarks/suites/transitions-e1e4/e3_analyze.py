"""E3 analysis: seam at the guided/free boundary (frame 22), motion-stall check,
audio correlation of the rendered join vs the conditioning audio, level steps.

Motion-Context targets for the audio-pinned trick: join corr 0.45 -> 0.95+,
seam level step 0.905 -> 0.16.
"""

import json
import sys

sys.path.insert(0, ".")
from metrics import seam_metrics, audio_join_metrics, audio_corr_two

T = os.path.join(os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"), "output",
    "transitions-e1e4")
REF_WAV = "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/input/exp_e1/a_tail.wav"
BOUND_F = 22  # first free frame after the guided tail


def analyze(name, fname):
    v = f"{T}/{fname}"
    out = {"arm": name}
    out["video_seam_f22"] = seam_metrics(v, BOUND_F)
    out["audio_step_f22"] = audio_join_metrics(v, int(BOUND_F / 24 * 16000))
    out["audio_corr_vs_conditioning"] = audio_corr_two(
        v, REF_WAV, 0.0, 0.0, 22 / 24)
    return out


if __name__ == "__main__":
    arms = {
        "plain_noaud": "e3_plain_noaud_00001_.mp4",
        "plain_aud": "e3_plain_aud_00001_.mp4",
        "airlock_noaud": "e3_airlock_noaud_00001_.mp4",
        "airlock_aud": "e3_airlock_aud_00001_.mp4",
    }
    results = {}
    for name, f in arms.items():
        try:
            results[name] = analyze(name, f)
            r = results[name]
            print(f"{name}: seam f22 PSNR {r['video_seam_f22']['seam_psnr_db']} dB "
                  f"ratio {r['video_seam_f22']['seam_ratio']} | "
                  f"audio step {r['audio_step_f22']['level_step']} | "
                  f"corr {r['audio_corr_vs_conditioning'].get('best_corr')}")
        except Exception as e:
            print(f"{name}: FAILED {e}")
    json.dump(results, open("../e3_metrics.json", "w"), indent=1)
    print("saved ../e3_metrics.json")
