#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ ! -x .venv/bin/python ]]; then python3 -m venv .venv; fi
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python setup_assets.py
printf 'Open http://127.0.0.1:8765 in your browser.\n'
exec .venv/bin/python server.py
