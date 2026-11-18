"""Probe package: print argv as JSON. Does not create side-effect files."""
from __future__ import annotations

import json
import os
import sys

print(json.dumps({
    "ok": True,
    "argv": sys.argv,
    "cwd": os.getcwd(),
}, ensure_ascii=False))
