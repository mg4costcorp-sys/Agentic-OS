#!/usr/bin/env python3
"""Compatibility entrypoint for the pinned, current SlopMonster checker."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parent.parent/'vendor/slopmonster/tools/deslop.py'),run_name='__main__')
