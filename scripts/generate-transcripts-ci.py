#!/usr/bin/env python3
"""Manual CI fallback; uses the local failure and negative-cache rules."""
import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("generate-transcripts.py")), run_name="__main__")
