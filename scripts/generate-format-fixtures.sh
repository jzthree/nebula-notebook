#!/usr/bin/env bash
# Regenerate the jupytext-oracle fixtures for the text notebook formats.
#
# Run this ONCE on a dev machine when fixtures change — the *.expected.ipynb
# outputs are committed, so CI and other machines never need jupytext.
#
# Requires: uv (uvx) on PATH. jupytext reads/writes both py:percent and qmd.
set -euo pipefail
cd "$(dirname "$0")/../node-server/src/fs/notebook-formats/__tests__/fixtures"

for f in *.py; do
  uvx jupytext --from py:percent --to ipynb --output "${f%.py}.py.expected.ipynb" "$f"
done
# jupytext's qmd reader shells out to the quarto binary — only generate the
# qmd oracle when quarto is installed (the qmd adapter is otherwise covered
# by unit + property tests).
if command -v quarto >/dev/null 2>&1; then
  for f in *.qmd; do
    uvx jupytext --from qmd --to ipynb --output "${f%.qmd}.qmd.expected.ipynb" "$f"
  done
else
  echo "quarto not found — skipping qmd oracle generation (py oracle still updated)"
fi

echo "Done. Commit the *.expected.ipynb files."
