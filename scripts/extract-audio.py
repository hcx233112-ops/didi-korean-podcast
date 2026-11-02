#!/usr/bin/env python3
"""Compatibility entry point: use the validated, locked audio sync pipeline."""
import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("sync-audio.py")), run_name="__main__")
