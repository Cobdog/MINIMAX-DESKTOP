"""Python fixture for scripts/test-engine-process.cjs.

Asserts the unbuffered contract from inside the child: EngineProcess merges
PYTHONUNBUFFERED=1 into the environment and prepends -u to python commands.
Prints NDJSON events (the test observes them BEFORE sending the quit line —
impossible if stdout were block-buffered), then honors the stdin quit
protocol.
"""
import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


line_buffering = bool(getattr(sys.stdout, "line_buffering", False))
unbuffered_env = os.environ.get("PYTHONUNBUFFERED") == "1"
emit({
    "level": "info",
    "msg": "boot",
    "lineBuffering": line_buffering,
    "unbufferedEnv": unbuffered_env,
})
if not (line_buffering or unbuffered_env):
    emit({"level": "error", "msg": "stdout is buffered despite the unbuffered contract"})
    sys.exit(1)
emit({"level": "info", "msg": "ready"})
for line in sys.stdin:
    if line.strip() == "quit":
        break
emit({"level": "info", "msg": "bye"})
sys.exit(0)
