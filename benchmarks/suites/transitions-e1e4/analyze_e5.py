"""E5 analysis: per-hop anchor fidelity, drift trajectories, ArcFace/hop, seams.

Chains: A22 (ref_video), B22 (AddGuide pixel replay), C22/C39 (raw latent handoff).
seg1 = tranche-1 srcA (shared origin). Windows: 22f (7 video steps) / 39f (12).
"""

import importlib.util
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
from t1_metrics import anchor_fidelity, audio_join_metrics, extract_frames, psnr, seam_metrics  # noqa: E402

TESTBED_OUT = os.path.join(os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"), "output")
SRC1 = f"{TESTBED_OUT}/tranche1/srcA_00001_.mp4"
FPS = 24


def chain_videos(chain):
    res = json.load(open(os.environ.get(
    "BENCH_E5_RESULTS",
    os.path.join(os.environ.get("BENCH_OUT", os.path.join(
        os.environ.get("BENCH_REPO", os.path.abspath(os.path.join(HERE, "..", "..", ".."))),
        "test-results", "benchmarks")), "transitions-e1e4",
        os.environ.get("BENCH_RUN_ID", "run"), "e5_results.json"))))["chains"][chain]
    return [SRC1] + [f"{TESTBED_OUT}/{res[str(h)]['subfolder']}/{res[str(h)]['filename']}"
                     for h in (2, 3, 4, 5)]


def mid_frame(video, idx, tmp):
    fr = extract_frames(video, [idx], tmp)
    return fr[idx]


def analyze_chain(chain, window):
    vids = chain_videos(chain)
    n1 = 243  # srcA frames
    seg_n = 124
    hops = []
    # reference embeddings/colors from seg1 mid-frame
    import tempfile
    app = None
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    with tempfile.TemporaryDirectory() as td:
        base = mid_frame(vids[0], n1 // 2, td)
        r = app.get(base.astype(np.float32))
        base_emb = r[0].normed_embedding if r else None
        base_luma = float(base.mean())
        for k, vid in enumerate(vids[1:], start=2):
            prior = vids[k - 2]
            n_prior = n1 if prior.endswith("srcA_00001_.mp4") else seg_n
            # anchor fidelity: hop's first `window` frames vs prior's last `window`
            anchor_prior = anchor_fidelity(vid, prior, (0, window), (n_prior - window, n_prior))
            # frozen-reference drift: same window vs seg1's tail (always)
            anchor_origin = anchor_fidelity(vid, SRC1, (0, window), (n1 - window, n1))
            # seam + audio at the guided/free boundary
            seam = seam_metrics(vid, window)
            aud = audio_join_metrics(vid, int(window / FPS * 16000))
            # identity + color at mid-frame
            mid = mid_frame(vid, seg_n // 2, td)
            rr = app.get(mid.astype(np.float32))
            emb = rr[0].normed_embedding if rr else None
            hops.append({
                "hop": k,
                "anchor_vs_prior_db": anchor_prior["mean_db"],
                "anchor_vs_prior_min": anchor_prior["min_db"],
                "anchor_vs_origin_db": anchor_origin["mean_db"],
                "seam_at_boundary": seam,
                "audio_step_at_boundary": aud["level_step"],
                "arcface_mid_vs_seg1": round(float(np.dot(emb, base_emb)), 4) if (emb is not None and base_emb is not None) else None,
                "mid_luma_delta": round(float(mid.mean() - base.mean()), 2),
            })
    return hops


def contact_chain(chain, window, out):
    import subprocess
    vids = chain_videos(chain)
    with __import__("tempfile").TemporaryDirectory() as td:
        rows = []
        for vid in vids:
            os.makedirs(td + "/x", exist_ok=True)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", vid,
                            "-vf", "scale=288:160", "-pix_fmt", "rgb24", td + "/x/f%04d.png"], check=True)
            files = sorted(os.listdir(td + "/x"))
            idxs = np.linspace(0, len(files) - 1, 6).astype(int)
            rows.append(np.concatenate([np.asarray(Image.open(f"{td}/x/{files[i]}"), dtype=np.float32) for i in idxs], axis=1))
            os.system(f"rm -rf {td}/x")
        sheet = np.concatenate(rows, axis=0).astype(np.uint8)
        Image.fromarray(sheet).save(os.path.join(HERE, "..", "media", out))


if __name__ == "__main__":
    results = {}
    for chain, window in [("A22", 22), ("B22", 22), ("C22", 22), ("C39", 39)]:
        try:
            results[chain] = analyze_chain(chain, window)
            contact_chain(chain, window, f"e5_{chain}_contact.png")
        except Exception as e:
            results[chain] = {"error": str(e)}
        print(f"== {chain} ==")
        print(json.dumps(results[chain], indent=1))
    json.dump(results, open(os.path.join(HERE, "..", "e5_metrics.json"), "w"), indent=1)
