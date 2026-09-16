"""E-FC1 metrics (CPU). Run with the testbed python (numpy only).

Per-frame keypoint error: estimator round-trip on each OUTPUT vs the keypoints
that defined its CONTROL video (DWPose body-18 for A/C, AP-10K 17 for B/D).
Normalized three ways: px, % of frame diagonal (960 px), % of the control
subject's bbox diagonal (scale-invariant). Frames with no estimation detection
count as misses (themselves a signal). Also: translation-free error (pose shape
modulo position) and, for D, centroid-path tracking of the dog vs the sprite.
"""

import json
import math
import os
import sys

import numpy as np

IND = os.path.join(TB, "input", "efc1")  # testbed input dir name stays exp-namespace
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
import suiteconfig as SC
R = SC.REPO
TB = SC.TESTBED
OUT = SC.run_dir("nonhuman-fc1", os.environ.get("BENCH_RUN_ID", "run"))
W, H, L = 480, 832, 39
DIAG = math.hypot(W, H)
SEEDS = (421337, 421338)
SCORE_THR = 0.3


def best_person(fr):
    """DWPose dict -> (18,3) array of the largest person, or None."""
    people = fr.get("people") or []
    best, best_area = None, -1.0
    for p in people:
        flat = p.get("pose_keypoints_2d") or []
        if len(flat) < 18 * 3:
            continue
        arr = np.array(flat, dtype=np.float32).reshape(-1, 3)
        valid = arr[:, 2] > 0
        if valid.sum() < 5:
            continue
        v = arr[valid]
        area = float((np.ptp(v[:, 0])) * (np.ptp(v[:, 1])))
        if area > best_area:
            best, best_area = arr, area
    return best


def best_animal(fr):
    """AP-10K dict -> (17,3) array of the largest animal, or None."""
    animals = fr.get("animals") or []
    best, best_area = None, -1.0
    for kps in animals:
        arr = np.array(kps, dtype=np.float32)
        if arr.shape[0] < 17:
            continue
        valid = arr[:, 2] > SCORE_THR
        if valid.sum() < 6:
            continue
        v = arr[valid]
        area = float((np.ptp(v[:, 0])) * (np.ptp(v[:, 1])))
        if area > best_area:
            best, best_area = arr, area
    return best


def load_frames(path, kind):
    with open(path) as f:
        frames = json.load(f)
    parse = best_person if kind == "dwpose" else best_animal
    return [parse(fr) for fr in frames]


def authored_body(path):
    with open(path) as f:
        frames = json.load(f)
    out = []
    for fr in frames:
        arr = np.zeros((18, 3), dtype=np.float32)
        for i, p in enumerate(fr["body"]):
            arr[i] = (p[0], p[1], 1.0)
        out.append(arr)
    return out


def bbox_diag(arr, thr):
    v = arr[arr[:, 2] > thr]
    if len(v) < 2:
        return None
    return float(math.hypot(np.ptp(v[:, 0]), np.ptp(v[:, 1])))


def compare(ref_frames, est_frames, thr):
    """-> dict of per-frame + aggregate stats."""
    rows = []
    for f in range(min(len(ref_frames), len(est_frames))):
        ref, est = ref_frames[f], est_frames[f]
        if est is None:
            rows.append({"f": f, "miss": True})
            continue
        rv = ref[:, 2] > thr
        ev = est[:, 2] > thr
        both = rv & ev
        if both.sum() < 4:
            rows.append({"f": f, "miss": True})
            continue
        d = np.linalg.norm(ref[both, :2] - est[both, :2], axis=1)
        # translation-free (pose shape modulo mean position)
        rm = ref[both, :2].mean(0)
        em = est[both, :2].mean(0)
        d0 = np.linalg.norm((ref[both, :2] - rm) - (est[both, :2] - em), axis=1)
        bd = bbox_diag(ref, thr) or DIAG
        rows.append({
            "f": f, "miss": False, "n": int(both.sum()),
            "err_px": float(d.mean()), "err_max_px": float(d.max()),
            "err0_px": float(d0.mean()),
            "err_frac": float(d.mean() / DIAG),
            "err_scale": float(d.mean() / bd),
            "scale_px": bd,
        })
    det = [r for r in rows if not r["miss"]]
    agg = {
        "n_frames": len(rows), "n_detected": len(det),
        "miss_rate": 1.0 - len(det) / max(1, len(rows)),
        "err_px_mean": float(np.mean([r["err_px"] for r in det])) if det else None,
        "err_px_median": float(np.median([r["err_px"] for r in det])) if det else None,
        "err0_px_mean": float(np.mean([r["err0_px"] for r in det])) if det else None,
        "err_frac_mean": float(np.mean([r["err_frac"] for r in det])) if det else None,
        "err_scale_mean": float(np.mean([r["err_scale"] for r in det])) if det else None,
    }
    return {"aggregate": agg, "frames": rows}


def centroid_path_d():
    """D: est dog centroid vs sprite centroid (absolute screen space)."""
    with open(os.path.join(IND, "sprite_centroids.json")) as f:
        sc = json.load(f)["centroids"]
    out = {}
    for seed in SEEDS:
        est = load_frames(os.path.join(IND, f"kp_out_D_s{seed}.json"), "ap10k")
        errs, frames = [], []
        for fidx in range(L):
            c = sc[fidx]
            e = est[fidx]
            if e is None or c[0] is None:
                frames.append({"f": fidx, "miss": True})
                continue
            v = e[e[:, 2] > SCORE_THR]
            if len(v) < 6:
                frames.append({"f": fidx, "miss": True})
                continue
            ec = (float(v[:, 0].mean()), float(v[:, 1].mean()))
            errs.append(math.hypot(ec[0] - c[0], ec[1] - c[1]))
            frames.append({"f": fidx, "miss": False, "err_px": errs[-1],
                           "est": ec, "sprite": c})
        out[f"s{seed}"] = {
            "n_detected": len(errs),
            "centroid_err_px_mean": float(np.mean(errs)) if errs else None,
            "centroid_err_px_median": float(np.median(errs)) if errs else None,
            "frames": frames,
        }
    return out


def main():
    refs = {
        "A": load_frames(os.path.join(IND, "kp_dance.json"), "dwpose"),
        "B": load_frames(os.path.join(IND, "kp_dog.json"), "ap10k"),
        "C": authored_body(os.path.join(IND, "authored_humanoid.json")),
        "D": load_frames(os.path.join(IND, "kp_dog.json"), "ap10k"),
    }
    kinds = {"A": "dwpose", "B": "ap10k", "C": "dwpose", "D": "ap10k"}
    thr = {"dwpose": 0.0, "ap10k": SCORE_THR}   # dwpose json scores are 0/1 flags

    metrics = {"config": {"W": W, "H": H, "L": L, "frame_diag_px": DIAG,
                          "score_thresholds": {"dwpose": "flag>0", "ap10k": 0.3},
                          "primary": "err_px_mean (estimator round-trip vs control)"}}
    # control-side sanity: how many frames does the CONTROL itself detect?
    metrics["control_side"] = {
        arm: {"detected": int(sum(1 for x in refs[arm] if x is not None)), "total": L}
        for arm in refs}

    for arm in ("A", "B", "C", "D"):
        metrics[arm] = {}
        for seed in SEEDS:
            est = load_frames(os.path.join(IND, f"kp_out_{arm}_s{seed}.json"), kinds[arm])
            metrics[arm][f"s{seed}"] = compare(refs[arm], est, thr[kinds[arm]])

    metrics["centroid_D"] = centroid_path_d()

    with open(os.path.join(OUT, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=1)

    hdr = (f"{'arm/seed':16} {'det':>5} {'miss%':>6} {'err_px':>8} {'med':>8} "
           f"{'%diag':>7} {'%scale':>8} {'err0_px':>8}")
    print(hdr)
    print("-" * len(hdr))
    for arm in ("A", "B", "C", "D"):
        for seed in SEEDS:
            a = metrics[arm][f"s{seed}"]["aggregate"]
            fm = lambda v, fmt="{:8.1f}": fmt.format(v) if v is not None else "     n/a"
            pct = lambda v, fmt: fm(v * 100, fmt) if v is not None else "     n/a"
            print(f"{arm}_s{seed:<10} {a['n_detected']:>5} {100 * a['miss_rate']:>5.1f}% "
                  f"{fm(a['err_px_mean'])} {fm(a['err_px_median'])} "
                  f"{pct(a['err_frac_mean'], '{:7.2f}')} "
                  f"{pct(a['err_scale_mean'], '{:8.2f}')} "
                  f"{fm(a['err0_px_mean'])}")
    for seed in SEEDS:
        c = metrics["centroid_D"][f"s{seed}"]
        v = c["centroid_err_px_mean"]
        print(f"D_s{seed} centroid   {c['n_detected']:>5} "
              f"{'':>6} {v if v is not None else 'n/a':>8} (px abs screen-space)")
    print("\nwrote", os.path.join(OUT, "metrics.json"))


if __name__ == "__main__":
    main()
