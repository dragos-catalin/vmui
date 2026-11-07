#!/usr/bin/env python3
"""Run a shell command inside a QEMU guest through qemu-guest-agent (smoke diagnostics).
  python3 qga-exec.py <qga unix socket> '<command>' [timeout seconds, default 120]"""
import base64
import json
import socket
import sys
import time

s = socket.socket(socket.AF_UNIX)
s.settimeout(30)
s.connect(sys.argv[1])
f = s.makefile("rw")


def call(cmd, **a):
    f.write(json.dumps({"execute": cmd, "arguments": a} if a else {"execute": cmd}) + "\n")
    f.flush()
    while True:
        r = json.loads(f.readline())
        if "return" in r or "error" in r:
            return r


call("guest-sync", id=4242)
pid = call("guest-exec", path="/bin/sh", arg=["-c", sys.argv[2]], **{"capture-output": True})["return"]["pid"]
st = {}
for _ in range(int(sys.argv[3]) if len(sys.argv) > 3 else 120):
    st = call("guest-exec-status", pid=pid)["return"]
    if st.get("exited"):
        break
    time.sleep(1)
for k in ("out-data", "err-data"):
    if st.get(k):
        sys.stdout.write(base64.b64decode(st[k]).decode(errors="replace"))
