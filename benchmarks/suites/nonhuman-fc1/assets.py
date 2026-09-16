"""E-FC1 offline assets (CPU, testbed python — PIL+numpy+cv2).

Subcommands:
  extract <mp4> <folder>            - 39 frames as f%06d.png (ffmpeg)
  humanoid <ap10k_json> <outdir>    - arm C: proc-authored humanoid skeleton
                                      riding the dog's torso trajectory;
                                      palette-exact DWPose render (port of the
                                      repo's src/poserig/drawPose.ts + poseSpec.ts)
                                      + authored keypoint JSON for metrics
  sprite <dog_frames> <outdir>      - arm D: background-median-subtraction dog
                                      silhouette pasted on black along the trot
                                      path + mask-centroid JSON; keypoint-box
                                      fallback if the silhouette fails QA
  contact <folder...> <out.png>     - contact sheet (rows of frames) for manual
                                      tagging

Renderer port notes (drawPose.ts verbatim mapping): limb ellipses use cv2
SEMI-axes (trunc(len/2), 4), colors = palette x 0.6 int-truncated; joints r4
full palette color; feet dots palette[i%18] with the eps guard; hands = 20
edges thickness 2 HSV rainbow hue=i/20 + 21 blue r4 dots; face = 68 white r3
dots; draw order body-limbs -> joints -> left hand -> right hand -> face; eps
guard (skip x<1 or y<1) applies to hands/face/feet only. The TS adds a +0.5
pixel-center nudge for canvas; cv2 needs no nudge (documented deviation,
sub-pixel).
"""

import json
import math
import os
import subprocess
import sys

import numpy as np

VENV = os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI") + "/.venv/bin/python"
if sys.executable != VENV:
    os.execv(VENV, [VENV, __file__] + sys.argv[1:])

import cv2
from PIL import Image

W, H, L = 480, 832, 39

TB = os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI")
R = os.environ.get(
    "BENCH_REPO",
    os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "..", "..", "..")))
IND = os.path.join(TB, "input", "efc1")
MEDIA = os.path.join(
    os.environ.get("BENCH_OUT", os.path.join(R, "test-results", "benchmarks")),
    "nonhuman-fc1", os.environ.get("BENCH_RUN_ID", "run"), "media")

# ---------------------------------------------------------------- render port
POSE_PALETTE = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0),
    (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
    (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255),
    (255, 0, 170), (255, 0, 85),
]
# 0-indexed OpenPose body limb seq (poseSpec.ts BODY_LIMB_SEQ)
BODY_LIMB_SEQ = [
    (1, 2), (1, 5), (2, 3), (3, 4),
    (5, 6), (6, 7), (1, 8), (8, 9),
    (9, 10), (1, 11), (11, 12), (12, 13),
    (1, 0), (0, 14), (14, 16), (0, 15),
    (15, 17),
]
HAND_EDGES = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
]
STICK_SEMI = 4      # cv2 semi-axis (spec: ~8px stroke)
JOINT_R = 4
HAND_LINE_W = 2
HAND_DOT_R = 4
HAND_DOT_COL = (0, 0, 255)
FACE_DOT_R = 3
FACE_DOT_COL = (255, 255, 255)
EPS = 1


def limb_color(i):
    c = POSE_PALETTE[i % 18]
    return (int(c[0] * 0.6), int(c[1] * 0.6), int(c[2] * 0.6))


def hsv_ints(h):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, 1.0, 1.0)
    return (int(r * 255), int(g * 255), int(b * 255))


def draw_frame(kp):
    """kp: dict body=[(x,y)|None]*18, feet=[(x,y)|None]*6, face=[(x,y)|None]*68,
    hand_l=[(x,y)|None]*21, hand_r=[(x,y)|None]*21. Returns BGR np.uint8."""
    canvas = np.zeros((H, W, 3), dtype=np.uint8)
    body = kp["body"]

    def pt(p):
        return int(p[0]), int(p[1])

    # 1. body limbs — filled rotated ellipses, palette x 0.6
    for i, (a, b) in enumerate(BODY_LIMB_SEQ):
        pa, pb = body[a], body[b]
        if pa is None or pb is None:
            continue
        x1, y1 = pt(pa); x2, y2 = pt(pb)
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        length = math.hypot(x1 - x2, y1 - y2)
        ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
        cv2.ellipse(canvas, (cx, cy), (int(length / 2), STICK_SEMI),
                    ang, 0, 360, limb_color(i), -1)
    # 2. joint dots — r4 full palette
    for i, p in enumerate(body):
        if p is None:
            continue
        cv2.circle(canvas, pt(p), JOINT_R, POSE_PALETTE[i % 18], -1)
    for i, p in enumerate(kp["feet"]):
        if p is None or p[0] < EPS or p[1] < EPS:
            continue
        cv2.circle(canvas, pt(p), JOINT_R, POSE_PALETTE[(18 + i) % 18], -1)
    # 3/4. hands — HSV edges + blue dots (left then right, trainer order)
    for key in ("hand_l", "hand_r"):
        pts = kp[key]
        for ie, (a, b) in enumerate(HAND_EDGES):
            pa, pb = pts[a], pts[b]
            if pa is None or pb is None:
                continue
            if min(pa[0], pa[1], pb[0], pb[1]) < EPS:
                continue
            cv2.line(canvas, pt(pa), pt(pb), hsv_ints(ie / 20.0), HAND_LINE_W)
        for p in pts:
            if p is None or p[0] < EPS or p[1] < EPS:
                continue
            cv2.circle(canvas, pt(p), HAND_DOT_R, HAND_DOT_COL, -1)
    # 5. face — white dots only (dots-only correction, commit 3cb0de7 era)
    for p in kp["face"]:
        if p is None or p[0] < EPS or p[1] < EPS:
            continue
        cv2.circle(canvas, pt(p), FACE_DOT_R, FACE_DOT_COL, -1)
    return cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)


# ------------------------------------------------------------ AP-10K helpers
# AP-10K 17 (0-based): 0,1 eyes, 2 nose, 3 neck, 4 tail-base; forelegs
# 5,6,7 (L sh/elbow/paw) and 8,9,10 (R); hind legs 11,12,13 and 14,15,16.
def load_ap10k(path):
    """-> list per frame of (np17x2 kps, np17 scores) for the LARGEST animal,
    or (None, None) when no detection."""
    with open(path) as f:
        frames = json.load(f)
    out = []
    for fr in frames:
        animals = fr.get("animals") or []
        best, best_area = None, -1.0
        for kps in animals:
            arr = np.array(kps, dtype=np.float32)
            xy = arr[:, :2]
            valid = (xy[:, 0] > 0) | (xy[:, 1] > 0)
            if valid.sum() < 6:
                continue
            v = xy[valid]
            area = float((v[:, 0].max() - v[:, 0].min()) * (v[:, 1].max() - v[:, 1].min()))
            if area > best_area:
                best, best_area = (xy, arr[:, 2]), area
        out.append(best if best is not None else (None, None))
    return out


def smooth(x, k=5):
    x = np.asarray(x, dtype=np.float32)
    if k <= 1:
        return x
    pad = np.pad(x, (k // 2, k // 2), mode="edge")
    return np.convolve(pad, np.ones(k, dtype=np.float32) / k, mode="valid")


# ------------------------------------------------------------------ humanoid
# Unit template (x in [-1,1] right+, y 0 = ankle, 1 = top of head), profile
# walker facing +x. Joint order = OpenPose 18.
def _walk_pose(phase, s, lean_deg=4.0):
    """phase in radians. Returns dict joint->(x,y) in unit coords (x scaled by
    0.5 within [-1,1] figure box)."""
    hip_y, neck_y, nose_y = 0.475, 0.715, 0.795
    sh_hw, hip_hw = 0.11, 0.065
    c, sn = math.cos(math.radians(lean_deg)), math.sin(math.radians(lean_deg))

    def lean(x, y):
        # lean the figure forward (toward +x) about the ankles
        return (x * c + (1 - y) * sn * 0.55, y)

    hip = lean(0.0, hip_y + 0.010 * math.sin(2 * phase))
    neck = lean(0.0, neck_y + 0.008 * math.sin(2 * phase))
    nose = lean(0.016, nose_y + 0.008 * math.sin(2 * phase))
    J = {}
    # legs: near leg (+x offset) leads phase, far leg opposite
    for side, ph, dx in (("near", phase, +0.022), ("far", phase + math.pi, -0.022)):
        hipx, hipy = hip[0] + dx * 0.35, hip[1]
        thigh_a = 0.30 * math.sin(ph)
        knee = (hipx + 0.10 * math.sin(thigh_a), hipy - 0.24 * math.cos(thigh_a * 0.7))
        sh_a = thigh_a + 0.22 * max(0.0, math.sin(ph + 0.7))
        ankle = (knee[0] + 0.11 * math.sin(sh_a), 0.012 + 0.045 * max(0.0, math.sin(ph)))
        J[f"hip_{side}"] = (hipx, hipy)
        J[f"knee_{side}"] = knee
        J[f"ankle_{side}"] = ankle
        toe = (ankle[0] + 0.045, ankle[1] + 0.004)
        J[f"toe_{side}"] = toe
    # arms: opposite to same-side legs, relaxed
    for side, ph, dx in (("near", phase + math.pi, +0.012), ("far", phase, -0.012)):
        shx, shy = neck[0] + dx, neck[1] - 0.012
        aa = 0.55 * math.sin(ph)
        elbow = (shx + 0.085 * math.sin(aa), shy - 0.145)
        wrist = (elbow[0] + 0.075 * math.sin(aa * 1.15), elbow[1] - 0.125)
        J[f"sh_{side}"] = (shx, shy)
        J[f"el_{side}"] = elbow
        J[f"wr_{side}"] = wrist
    J["nose"] = nose
    J["neck"] = neck
    J["hip"] = hip
    return J


def _place(J, cx, ground_y, s):
    """unit coords -> pixels: figure height s, ankles at ground_y, centered cx."""
    out = {}
    for k, (x, y) in J.items():
        out[k] = (cx + x * 0.5 * s, ground_y - y * s)
    return out


def _body18(P):
    """pixel joints -> OpenPose-18 array (nose neck rSh rEl rWr lSh lEl lWr
    rHip rKnee rAnkle lHip lKnee lAnkle rEye lEye rEar lEar). near = right
    screen side for a +x walker."""
    m = lambda a, b: ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
    nose = P["nose"]
    return [
        nose, P["neck"],
        P["sh_near"], P["el_near"], P["wr_near"],
        P["sh_far"], P["el_far"], P["wr_far"],
        P["hip_near"], P["knee_near"], P["ankle_near"],
        P["hip_far"], P["knee_far"], P["ankle_far"],
        (nose[0] + 6.0, nose[1] - 4.0), (nose[0] - 5.0, nose[1] - 4.5),
        (nose[0] + 13.0, nose[1] - 1.0), (nose[0] - 12.0, nose[1] - 1.5),
    ]


def _feet6(P, heading):
    """COCO-WholeBody foot order: L big toe, L small toe, L heel, R big, R small,
    R heel. 'left' = far leg here; toe points along heading."""
    out = []
    for side in ("far", "near"):
        ank = P[f"ankle_{side}"] if f"ankle_{side}" in P else P[f"ankle_{side}"]
        toe = P[f"toe_{side}"]
        dx, dy = toe[0] - ank[0], toe[1] - ank[1]
        n = math.hypot(dx, dy) or 1.0
        ux, uy = dx / n, dy / n
        out += [toe, (toe[0] - ux * 9 - uy * 4, toe[1] - uy * 9 + ux * 4),
                (ank[0] - ux * 7, ank[1] - uy * 7)]
    return out


def _hand21(wrist, elbow):
    """relaxed hand: 5 finger fans off the wrist along the forearm direction."""
    dx, dy = wrist[0] - elbow[0], wrist[1] - elbow[1]
    n = math.hypot(dx, dy) or 1.0
    ux, uy = dx / n, dy / n
    px, py = -uy, ux
    pts = [wrist]
    base_a = [-0.9, -0.45, 0.0, 0.45, 0.9]
    lens = [0.62, 1.0, 1.08, 1.0, 0.78]
    for fi in range(5):
        a = base_a[fi] * 0.5
        fdx = ux * math.cos(a) + px * math.sin(a)
        fdy = uy * math.cos(a) + py * math.sin(a)
        bx = wrist[0] + fdx * 5.0
        by = wrist[1] + fdy * 5.0
        for seg in (0.30, 0.55, 0.80, 1.0):    # 4 joints x 5 fingers = 20 + wrist
            L = 13.0 * lens[fi] * seg
            pts.append((bx + fdx * L, by + fdy * L))
    return pts


def _face68(nose):
    """plausible iBUG-68 around the nose (relaxed, facing profile +x)."""
    cx, cy = nose[0] + 2, nose[1] + 2
    pts = []
    for i in range(17):                                   # jaw ring
        t = i / 16.0
        pts.append((cx - 14 + 26 * t, cy - 6 + 13 * math.sin(math.pi * t) - 6))
    for i in range(5):                                    # right brow
        pts.append((cx - 10 + 5 * i, cy - 13 + (1 if i in (1, 3) else 0)))
    for i in range(5):                                    # left brow
        pts.append((cx + 1 + 5 * i, cy - 13 + (1 if i in (1, 3) else 0)))
    for ex, ey in ((cx - 8, cy - 8), (cx + 6, cy - 8)):   # eyes (6 each)
        for i in range(6):
            t = i / 6.0 * 2 * math.pi
            pts.append((ex + 3.4 * math.cos(t), ey + 1.9 * math.sin(t)))
    for i in range(9):                                    # nose bridge+base
        pts.append((cx - 1 + 0.25 * i, cy - 7 + i * 0.9))
    for i in range(12):                                   # outer mouth
        t = i / 12.0
        pts.append((cx - 6 + 12 * t, cy + 6 + 4.5 * math.sin(math.pi * t)))
    for i in range(8):                                    # inner mouth
        t = i / 8.0
        pts.append((cx - 4 + 8 * t, cy + 6.5 + 2.4 * math.sin(math.pi * t)))
    return pts


def cmd_humanoid(ap10k_json, outdir):
    """Arm C control video + authored keypoint JSON."""
    kps = load_ap10k(ap10k_json)
    miss = [i for i, (k, s) in enumerate(kps) if k is None]
    if miss:
        raise SystemExit(f"[humanoid] AP-10K missing dog in source frames {miss} — "
                         f"cannot author trajectory (dog source clip unusable)")
    torso_x, torso_y, ground, phase_src = [], [], [], []
    for k, s in kps:
        neck, tail = k[3], k[4]
        torso_x.append((neck[0] + tail[0]) / 2.0)
        torso_y.append((neck[1] + tail[1]) / 2.0)
        ground.append((k[13][1] + k[16][1]) / 2.0)   # back-paw y mean
        phase_src.append((k[7][0] + k[10][0]) / 2.0)  # forepaw x mean
    torso_x = smooth(torso_x, 5)
    torso_y = smooth(torso_y, 5)
    ground = smooth(ground, 7)
    # trot phase: zero crossings of the detrended forepaw-x swing, linearly
    # interpolated (k*pi per crossing), flat-extrapolated at the ends
    px = np.array(phase_src, dtype=np.float32)
    px = px - smooth(px, 11)
    crossings = []
    for i in range(1, L):
        if px[i - 1] <= 0 < px[i]:
            crossings.append((i, +0.5))    # rising crossing -> phase k+0.5 cycles
        elif px[i - 1] > 0 >= px[i]:
            crossings.append((i, +1.0))    # falling crossing -> full cycle done
    phase = np.zeros(L, dtype=np.float32)
    if crossings:
        c0 = crossings[0]
        cyc0 = c0[1] - 0.5            # cycles at the previous (unseen) crossing
        for i in range(c0[0]):
            phase[i] = 2 * math.pi * (cyc0 + 0.5 * i / c0[0])
        for j in range(1, len(crossings)):
            (ia, ca), (ib, cb) = crossings[j - 1], crossings[j]
            for i in range(ia, ib):
                frac = (i - ia) / (ib - ia)
                phase[i] = 2 * math.pi * (ca + frac * (cb - ca))
        (il, cl) = crossings[-1]
        for i in range(il, L):
            phase[i] = phase[il - 1] + 2 * math.pi * 0.5 * (i - il + 1) / 10.0
    print(f"[humanoid] trot crossings at frames {[c[0] for c in crossings]}")

    os.makedirs(outdir, exist_ok=True)
    authored = []
    for f in range(L):
        # figure scale: tall creature occupying ~68% of frame height
        s = 0.68 * H
        # humanoid torso-center X locked to the dog's torso X (screen-space path)
        # ground locked to the dog's paw ground line; figure height fixed
        P = _place(_walk_pose(float(phase[f]), s), float(torso_x[f]), float(ground[f]), s)
        body = _body18(P)
        feet = _feet6(P, +1.0)
        hl = _hand21(P["wr_far"], P["el_far"])
        hr = _hand21(P["wr_near"], P["el_near"])
        face = _face68(P["nose"])
        kp = {"body": [(x, y) for x, y in body],
              "feet": [(x, y) for x, y in feet],
              "face": face, "hand_l": hl, "hand_r": hr}
        img = Image.fromarray(draw_frame(kp))
        img.save(os.path.join(outdir, f"f{f:06d}.png"))
        authored.append(kp)
    with open(os.path.join(IND, "authored_humanoid.json"), "w") as f:
        json.dump(authored, f)
    print(f"[humanoid] {L} frames -> {outdir}; torso x {torso_x[0]:.0f}->{torso_x[-1]:.0f}px, "
          f"ground y {ground.mean():.0f}, phase span {phase[-1]:.1f} rad")


# -------------------------------------------------------------------- sprite
def cmd_sprite(frames_dir, outdir):
    """Arm D: dog region composite on black (median-bg subtraction)."""
    files = [os.path.join(frames_dir, f"f{i:06d}.png") for i in range(L)]
    frames = np.stack([np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
                       for p in files])            # L,H,W,3
    bg = np.median(frames, axis=0)                 # H,W,3
    os.makedirs(outdir, exist_ok=True)
    centroids, areas = [], []
    for f in range(L):
        d = np.sqrt(((frames[f] - bg) ** 2).sum(-1))
        m = (d > 34).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
        n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        if n > 1:
            best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            m = (lab == best).astype(np.uint8)
        area = float(m.sum())
        areas.append(area)
        m = cv2.dilate(m, np.ones((5, 5), np.uint8))
        m = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 2.0)
        comp = (frames[f] * m[..., None]).astype(np.uint8)   # dog pixels on black
        Image.fromarray(comp).save(os.path.join(outdir, f"f{f:06d}.png"))
        ys, xs = np.nonzero(m > 0.5)
        centroids.append((float(xs.mean()), float(ys.mean())) if len(xs) else (None, None))
    with open(os.path.join(IND, "sprite_centroids.json"), "w") as f:
        json.dump({"centroids": centroids, "areas": areas,
                   "method": "median-bg-subtraction"}, f)
    a = np.array(areas, dtype=np.float32)
    print(f"[sprite] {L} frames -> {outdir}; mask area px "
          f"min/med/max {a.min():.0f}/{np.median(a):.0f}/{a.max():.0f} "
          f"({(a < 1500).sum()} degenerate frames)")


def sprite_from_keypoints(frames_dir, ap10k_json, outdir):
    """Fallback: soft region = keypoint bbox (+margin) pasted on black."""
    kps = load_ap10k(ap10k_json)
    files = [os.path.join(frames_dir, f"f{i:06d}.png") for i in range(L)]
    os.makedirs(outdir, exist_ok=True)
    centroids = []
    for f in range(L):
        k, _ = kps[f]
        img = np.asarray(Image.open(files[f]).convert("RGB"), dtype=np.float32)
        if k is None:
            Image.fromarray(np.zeros((H, W, 3), np.uint8)).save(
                os.path.join(outdir, f"f{f:06d}.png"))
            centroids.append((None, None))
            continue
        v = k[(k[:, 0] > 0) | (k[:, 1] > 0)]
        x0, x1 = v[:, 0].min(), v[:, 0].max()
        y0, y1 = v[:, 1].min(), v[:, 1].max()
        mx, my = 0.22 * (x1 - x0) + 12, 0.22 * (y1 - y0) + 12
        x0 = max(0, int(x0 - mx)); x1 = min(W - 1, int(x1 + mx))
        y0 = max(0, int(y0 - my)); y1 = min(H - 1, int(y1 + my))
        comp = np.zeros_like(img)
        comp[y0:y1 + 1, x0:x1 + 1] = img[y0:y1 + 1, x0:x1 + 1]
        Image.fromarray(comp.astype(np.uint8)).save(os.path.join(outdir, f"f{f:06d}.png"))
        centroids.append((float((x0 + x1) / 2), float((y0 + y1) / 2)))
    with open(os.path.join(IND, "sprite_centroids.json"), "w") as f:
        json.dump({"centroids": centroids, "areas": None,
                   "method": "keypoint-bbox-region"}, f)
    print(f"[sprite-fallback] {L} frames -> {outdir} (keypoint-box regions)")


# ------------------------------------------------------------------ contacts
def cmd_contact(folders, out_png, step=4, tile_w=240):
    rows = []
    for fd in folders:
        tiles = []
        for i in range(0, L, step):
            p = os.path.join(fd, f"f{i:06d}.png")
            im = Image.open(p).convert("RGB")
            tiles.append(im.resize((tile_w, int(tile_w * H / W))))
        row = Image.new("RGB", (tile_w * len(tiles), int(tile_w * H / W)), (24, 24, 24))
        for j, t in enumerate(tiles):
            row.paste(t, (j * tile_w, 0))
        rows.append((os.path.basename(fd), row))
    w = max(r[1].width for r in rows)
    h = sum(r[1].height + 18 for r in rows)
    sheet = Image.new("RGB", (w, h), (12, 12, 12))
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    y = 0
    for name, row in rows:
        d.text((4, y + 2), name, fill=(255, 255, 0))
        sheet.paste(row, (0, y + 18))
        y += row.height + 18
    sheet.save(out_png)
    print(f"[contact] {out_png} ({len(rows)} rows x {len(range(0, L, step))} tiles)")


def cmd_extract(mp4, folder):
    os.makedirs(folder, exist_ok=True)
    for f in range(L):
        p = os.path.join(folder, f"f{f:06d}.png")
        if os.path.exists(p):
            continue
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp4,
                        "-vf", f"select=eq(n\\,{f})", "-fps_mode", "passthrough",
                        "-frames:v", "1", p], check=True)
    print(f"[extract] {L} frames -> {folder}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "extract":
        cmd_extract(sys.argv[2], sys.argv[3])
    elif cmd == "humanoid":
        cmd_humanoid(sys.argv[2], sys.argv[3])
    elif cmd == "sprite":
        cmd_sprite(sys.argv[2], sys.argv[3])
    elif cmd == "sprite_kp":
        sprite_from_keypoints(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "contact":
        cmd_contact(sys.argv[2:-1], sys.argv[-1])
    else:
        raise SystemExit(f"unknown subcommand {cmd}")
