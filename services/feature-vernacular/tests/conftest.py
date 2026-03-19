"""
Pytest configuration for feature-vernacular tests.

Adds the service root and the shared library to sys.path so that
``import main`` and ``from llm_client import ...`` work correctly
regardless of the working directory pytest is launched from.
"""

import sys
from pathlib import Path

# services/feature-vernacular/
_SERVICE_DIR = Path(__file__).resolve().parent.parent
# repo_root/shared/
_SHARED_DIR = _SERVICE_DIR.parent.parent / "shared"

for _p in (str(_SERVICE_DIR), str(_SHARED_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
