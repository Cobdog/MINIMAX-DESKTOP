"""Offline build smoke: a MOCK candidate exercises every suite's build path
without GPU (AC: candidate-parameterization). Exits non-zero on any failure.

Usage: python3 benchmarks/tools/smoke_builds.py   (repo root as cwd or default)
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(BENCH, "shared"))
import suiteconfig as SC  # noqa: E402

MODULES = {
    "ref2va-bakeoff": "build_bakeoff.py",
    "tier-ladder": "build_tiers.py",
    "hybrid-ab": "build_ed1.py",
    "movement-md1": "build_md1.py",
    "nonhuman-fc1": "build.py",
    "preservation-k1": "build_k1.py",
    "transitions-e1e4": "build_battery.py",
}

MOCKS = {
    "ref2va-bakeoff": {"id": "mock", "label": "mock", "slot": {
        "kind": "turbo-lora", "file": "mock_lora.safetensors", "steps": 8}},
    "tier-ladder": {"id": "mock", "label": "mock", "slot": {
        "kind": "tier-config", "steps": 6, "sampler": "turbo",
        "loraFile": "mock.safetensors"}},
    "hybrid-ab": {"id": "mock", "label": "mock", "slot": {
        "kind": "checkpoint", "file": "mock_ckpt.safetensors"}},
    "movement-md1": {"id": "mock", "label": "mock", "slot": {
        "kind": "guide-plan", "guideFrames": [0, 20, 34]}},
    "nonhuman-fc1": {"id": "mock", "label": "mock", "slot": {
        "kind": "control-video", "controlDir": "exp_mock/ctl"}},
    "preservation-k1": {"id": "mock", "label": "mock", "slot": {
        "kind": "edit-path", "lora": "mock_edit.safetensors"}},
    "transitions-e1e4": {"id": "mock", "label": "mock", "slot": {
        "kind": "bridge-config", "headAt": -30}},
}

INCUMBENT_SPOT = {
    "ref2va-bakeoff": "main8",
    "tier-ladder": "t8",
    "hybrid-ab": "hybrid",
    "movement-md1": "B",
    "nonhuman-fc1": "A",
    "preservation-k1": "ie_instruct",
    "transitions-e1e4": "e1b",
}


def main():
    suites = SC.list_suites()
    assert set(suites) == set(MODULES), f"suite set mismatch: {suites}"
    ok = 0
    for s in suites:
        cfg = SC.load_suite(s)
        assert cfg["candidateSlot"]["kinds"], s
        assert any(a.get("incumbent") for a in cfg["arms"].values()), \
            f"{s}: no incumbent pinned"
        spec = importlib.util.spec_from_file_location(
            f"suite_{s.replace('-', '_')}",
            os.path.join(BENCH, "suites", s, MODULES[s]))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        wf0 = mod.build_arm(INCUMBENT_SPOT[s])
        assert isinstance(wf0, dict) and "save" in wf0 and (
            "i2v" in wf0 or "r2v" in wf0 or "ks" in wf0), f"{s}: incumbent graph"
        wf = mod.build_arm("cand", MOCKS[s])
        assert isinstance(wf, dict) and "save" in wf, f"{s}: candidate graph"
        blob = json.dumps(wf)
        if s == "movement-md1":
            assert "guide20" in wf and "guide17" not in wf, \
                f"{s}: candidate guide frames not wired"
        elif s == "transitions-e1e4":
            assert '"frame_idx": -30' in blob, f"{s}: candidate head not wired"
        else:
            assert "mock" in blob, f"{s}: candidate file not wired into the graph"
        ok += 1
    print(f"build smoke: {ok}/{len(suites)} suites build incumbent+candidate graphs")
    assert ok == len(suites)


if __name__ == "__main__":
    main()
