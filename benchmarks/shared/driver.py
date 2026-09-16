"""Shared benchmark driver: contention guard + ComfyUI /prompt client.

This is the curated merge of the tranche drivers (tranche1 -> tranche3b ->
efc1), now the permanent harness piece for every benchmarks/ suite. Engine:
Kreatine testbed at 127.0.0.1:8189 per the repo CLAUDE.md runbook. The
maintainer's own instance at 8188 is NEVER touched.

Encoded rules (each one measured, see benchmarks/README.md "Runbook"):
- TMPDIR discipline: the shared /tmp is a exhausted-prone tmpfs; every spawned
  process gets TMPDIR redirected (BENCH_TMPDIR, default /home/agent/tmp-gpu).
- Ambient-aware free_verified(): capture the ambient VRAM baseline at bring-up;
  /free must return within slack of it (desktop apps hold 1.1-1.7 GB idle).
- Estimator-restart rule: controlnet_aux annotators (DWPose/AP-10K
  torchscript) load to CUDA OUTSIDE ComfyUI's model management — /free cannot
  unload them. After an estimator phase, pass free_slack_mib=900 or restart
  the server before the sampling phase.
- Any OOM poisons the server's memory accounting: only a process restart
  recovers -> run_with_restart().
- Patient SIGINT teardown (a mid-load TE stream is uninterruptible for tens of
  seconds), then SIGTERM; teardown always ends with an nvidia-smi check.
- Per-step wall-clock via the /ws websocket progress events (steps=True).

Paths are env-driven (BENCH_TESTBED / BENCH_REPO / BENCH_TMPDIR /
BENCH_LOGDIR) with the canonical defaults, so nothing here is one-off.
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = os.environ.get("BENCH_COMFY_URL", "http://127.0.0.1:8189")
TIMEOUT_HTTP = 30
TMPDIR = os.environ.get("BENCH_TMPDIR", "/home/agent/tmp-gpu")
SERVER_DIR = os.environ.get(
    "BENCH_TESTBED", "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI")
LOGDIR = os.environ.get("BENCH_LOGDIR", "/home/agent/logs-gpu")
PID_FILE = os.path.join(LOGDIR, "comfyui_8189.pid")
LOG = os.path.join(LOGDIR, "comfyui_8189.log")

os.makedirs(TMPDIR, exist_ok=True)
os.makedirs(LOGDIR, exist_ok=True)
os.environ["TMPDIR"] = TMPDIR  # children inherit (subprocesses via env below)


def _get(path):
    with urllib.request.urlopen(BASE + path, timeout=TIMEOUT_HTTP) as r:
        return json.loads(r.read().decode())


def _post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_HTTP) as r:
        body = r.read().decode()
        return json.loads(body) if body.strip() else {"ok": True}


def gpu_state():
    """(used_mib, util_pct, maintainer_process_running)"""
    q = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu",
         "--format=csv,noheader,nounits"], capture_output=True, text=True)
    mem, util = [int(x.strip()) for x in q.stdout.strip().split("\n")[0].split(",")]
    # any 8188-side ComfyUI process owned by the maintainer?
    p = subprocess.run(["pgrep", "-af", "/home/lorn/sd/ComfyUI"],
                       capture_output=True, text=True)
    return mem, util, bool(p.stdout.strip())


AMBIENT_MIB = gpu_state()[0]  # measured at driver import, before any gen


def contention_check(tag):
    """The maintainer's workload takes priority; refuse to share the GPU."""
    mem, util, maint = gpu_state()
    busy = maint and (mem > AMBIENT_MIB + 1500 or util > 30)
    line = (f"[guard:{tag}] VRAM {mem} MiB (ambient {AMBIENT_MIB}), util {util}%, "
            f"maintainer-8188 process={'YES' if maint else 'no'}"
            f"{' -> PAUSE (contention)' if busy else ' -> clear'}")
    print(line, flush=True)
    if busy:
        raise SystemExit(f"CONTENTION: refusing to submit while maintainer's workload "
                         f"is on the GPU ({mem} MiB, {util}%): {line}")
    return mem, util


def health():
    return _get("/system_stats")


def free():
    try:
        return _post("/free", {"unload_models": True, "free_memory": True})
    except urllib.error.HTTPError as e:
        return {"error": str(e)}


def submit(workflow, client_id="bench-driver"):
    resp = _post("/prompt", {"prompt": workflow, "client_id": client_id})
    if resp.get("node_errors") and any(resp["node_errors"].values()):
        print(json.dumps(resp["node_errors"], indent=1)[:4000], file=sys.stderr)
        raise SystemExit("node errors at validation (above)")
    pid = resp["prompt_id"]
    print(f"[driver] submitted prompt_id={pid}", flush=True)
    return pid


class StepRecorder(threading.Thread):
    """Collect (t, value, max) progress tuples from /ws for one prompt_id."""

    def __init__(self):
        super().__init__(daemon=True)
        self.events = []
        self._stop = False

    def run(self):
        import websocket  # websocket-client, a ComfyUI hard dep
        try:
            ws = websocket.create_connection(
                f"ws://{BASE.split('//')[1]}/ws?clientId=bench-driver", timeout=5)
        except Exception:
            return
        ws.settimeout(2.0)
        while not self._stop:
            try:
                msg = json.loads(ws.recv())
            except Exception:
                continue
            if msg.get("type") == "progress":
                d = msg.get("data", {})
                self.events.append((time.time(), d.get("value"), d.get("max")))
        try:
            ws.close()
        except Exception:
            pass


def wait(pid, timeout_s=2400, poll_s=3.0, steps=False):
    """Block until the prompt leaves the queue; return history entry.
    steps=True also records per-step progress timestamps."""
    rec = StepRecorder() if steps else None
    if rec:
        rec.start()
    t0 = time.time()
    try:
        while True:
            elapsed = time.time() - t0
            if elapsed > timeout_s:
                raise TimeoutError(f"prompt {pid} not done after {timeout_s}s")
            try:
                h = _get(f"/history/{pid}")
            except urllib.error.URLError:
                time.sleep(poll_s); continue
            if pid in h:
                entry = h[pid]
                status = entry.get("status", {})
                if status.get("completed") or status.get("status_str") == "error":
                    return entry
            time.sleep(poll_s)
    finally:
        if rec:
            rec._stop = True
            rec.join(timeout=5)
            wait.last_steps = rec.events  # stash for the caller


def free_verified(timeout_s=120, slack_mib=150):
    """/free and VERIFY VRAM returns near the ambient baseline.

    slack_mib: tolerance above the import-time ambient baseline. After an
    ESTIMATOR phase (annotator torchscripts load outside comfy management and
    /free cannot unload them, ~0.5 GB residue until process exit) pass
    slack_mib=900 — or restart the server (restart_after_estimators)."""
    free()
    t0 = time.time()
    gate = max(900, AMBIENT_MIB + slack_mib)
    while time.time() - t0 < timeout_s:
        mem, _, _ = gpu_state()
        if mem <= gate:
            return mem
        time.sleep(2)
    mem, _, _ = gpu_state()
    raise RuntimeError(f"/free did not drop VRAM below the gate {gate} MiB "
                       f"(now {mem} MiB) - server memory state may be stuck; "
                       f"RESTART the testbed before the next run")


def _collect_files(entry):
    files = []
    for nid, out in (entry.get("outputs") or {}).items():
        for v in out.values():
            if isinstance(v, list):
                for item in v:
                    if isinstance(item, dict) and "filename" in item:
                        files.append((nid, item["filename"],
                                      item.get("subfolder", ""), item.get("type", "")))
    return files


def run(workflow, tag, timeout_s=2400, teardown_free=True, steps=False,
        free_slack_mib=150):
    """Full guarded run: /free first (this stack needs a clean GPU at run start:
    the 26.4GB int8 TE streams only when nothing else is resident), contention
    check, submit, wait, report timings + outputs, /free after."""
    free_verified(slack_mib=free_slack_mib)
    contention_check(tag)
    t_submit = time.time()
    pid = submit(workflow)
    entry = wait(pid, timeout_s=timeout_s, steps=steps)
    wall = time.time() - t_submit
    step_events = list(getattr(wait, "last_steps", []) or []) if steps else []
    status = entry.get("status", {})
    print(f"[driver:{tag}] wall {wall:.1f}s status={status.get('status_str')}")
    if status.get("status_str") == "error":
        for m in status.get("messages", []):
            if m[0] == "execution_error":
                print(json.dumps(m[1], indent=1)[:6000], file=sys.stderr)
        raise RuntimeError(f"{tag}: execution error (above)")
    files = _collect_files(entry)
    for f in files:
        print(f"[driver:{tag}] output: {f}")
    if teardown_free:
        free_verified(slack_mib=free_slack_mib)
    return {"wall_s": wall, "files": files, "prompt_id": pid,
            "outputs": entry.get("outputs", {}), "step_events": step_events}


def run_estimate(workflow, tag, timeout_s=600):
    """Light guarded run for estimator-only graphs (yolox+rtmpose/dwpose are
    ~0.5 GB — no free_verified cycle; one contention check here). Returns the
    history entry so the caller can pull the estimator's openpose_json UI
    output via history_ui_json(). IMPORTANT: after the estimator phase, either
    call free_verified(slack_mib=900) or restart_server() before sampling."""
    contention_check(tag)
    t_submit = time.time()
    pid = submit(workflow)
    entry = wait(pid, timeout_s=timeout_s)
    wall = time.time() - t_submit
    status = entry.get("status", {})
    print(f"[driver:{tag}] wall {wall:.1f}s status={status.get('status_str')}")
    if status.get("status_str") == "error":
        for m in status.get("messages", []):
            if m[0] == "execution_error":
                print(json.dumps(m[1], indent=1)[:6000], file=sys.stderr)
        raise RuntimeError(f"{tag}: execution error (above)")
    return {"wall_s": wall, "prompt_id": pid, "entry": entry}


def history_ui_json(entry, key="openpose_json"):
    """Pull an estimator node's UI JSON (e.g. openpose_json) from a history
    entry. Returns (node_id, parsed) or (None, None)."""
    for nid, out in (entry.get("outputs") or {}).items():
        if key in out:
            return nid, json.loads(out[key][0])
    return None, None


# ---- bring-up / teardown ----------------------------------------------------

def server_pid():
    try:
        return int(open(PID_FILE).read().strip().split("=")[-1])
    except Exception:
        return None


def stop_server(grace_s=90):
    """SIGINT (up to 90s — a mid-load TE stream is uninterruptible and needs
    the tens of seconds to finish/clean), then SIGTERM."""
    import signal
    pid = server_pid()
    if pid is None or not os.path.exists(f"/proc/{pid}"):
        return "not running"
    os.kill(pid, signal.SIGINT)
    for _ in range(grace_s):
        time.sleep(1)
        if not os.path.exists(f"/proc/{pid}"):
            return "stopped (SIGINT)"
    os.kill(pid, signal.SIGTERM)
    for _ in range(20):
        time.sleep(1)
        if not os.path.exists(f"/proc/{pid}"):
            return "stopped (SIGTERM)"
    raise RuntimeError(f"server {pid} refuses to die")


def start_server():
    # Runbook launch: NO --disable-dynamic-vram (dynamic VRAM is required for
    # the H3 int8 stack on 24 GB; maintainer-confirmed 2026-09-15, measured
    # tranche 1: 9/9 gens clean at ~2.4x faster per-step than static). TMPDIR
    # is exported into the child env (shared /tmp is exhaustion-prone).
    env = dict(os.environ)
    env["TMPDIR"] = TMPDIR
    with open(LOG, "ab") as lf:
        p = subprocess.Popen(["./.venv/bin/python", "main.py", "--port", "8189",
                              "--listen", "127.0.0.1"],
                             cwd=SERVER_DIR, stdout=lf, stderr=subprocess.STDOUT,
                             start_new_session=True, env=env)
    with open(PID_FILE, "w") as f:
        f.write(f"PID={p.pid}")
    for _ in range(90):
        time.sleep(2)
        try:
            health()
            return p.pid
        except Exception:
            continue
    raise RuntimeError("server did not come up in 180s")


def restart_server():
    print(f"[driver] RESTARTING testbed ({stop_server()} then start)")
    return start_server()


def restart_after_estimators(tag="post-estimator"):
    """The estimator-restart rule (E-FC1): annotator torchscripts live outside
    comfy's memory management; a restart is the only clean unload."""
    print(f"[driver] {tag}: restarting testbed (annotator residue rule)")
    return restart_server()


def run_with_restart(workflow, tag, timeout_s=2400, retries=2, steps=False,
                     free_slack_mib=150):
    """Run; on execution error or poisoned /free, restart the testbed and
    retry. (Empirical from tranches 1-3b: any OOM poisons the server's memory
    accounting; only a process restart recovers.)"""
    last = None
    for attempt in range(retries + 1):
        try:
            return run(workflow, tag + (f"_try{attempt+1}" if attempt else ""),
                       timeout_s=timeout_s, teardown_free=True, steps=steps,
                       free_slack_mib=free_slack_mib)
        except RuntimeError as e:
            last = e
            print(f"[driver] {tag} attempt {attempt+1} FAILED: {e!r}; restarting server",
                  flush=True)
            restart_server()
    raise last


def teardown():
    """Mandatory end-of-session teardown per the runbook: /free, SIGINT the
    recorded PID, wait for exit, verify VRAM returned to ambient."""
    free()
    result = stop_server()
    mem, util, _ = gpu_state()
    baseline_ok = mem <= AMBIENT_MIB + 300
    print(f"[driver] teardown: server {result}; VRAM {mem} MiB vs ambient "
          f"{AMBIENT_MIB} ({'OK' if baseline_ok else 'ABOVE BASELINE - investigate'}), "
          f"util {util}%")
    return {"server": result, "vram_mib": mem, "ambient_mib": AMBIENT_MIB,
            "baseline_ok": baseline_ok}


if __name__ == "__main__":
    print(json.dumps(health(), indent=1)[:1500])
    print("ambient MiB:", AMBIENT_MIB)
