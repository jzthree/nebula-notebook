# Baseline Fixtures

These fixtures support agent-cli parity checks.

- `baseline_project/` is a deterministic sample repo.
- `baseline_prompt.txt` drives a tool-heavy but read-only review.
- `baseline_runs/` holds normalized JSONL outputs for comparison.

Suggested record commands:
- Claude SDK baseline (opus 4.5, temp=0):
  `python tests/baseline_harness.py --backend claude-sdk --model claude-opus-4-5-20251101 --temperature 0 --record`
- OpenAI baseline (gpt-5.2, temp=0):
  `python tests/baseline_harness.py --backend openai --model gpt-5.2 --temperature 0 --record`

Compare against stored baselines:
  `python tests/baseline_harness.py --backend claude-sdk --temperature 0 --compare`
