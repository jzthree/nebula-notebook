"""Utility helpers."""

from typing import Dict


# TODO: replace greeting prefix with config value

def build_greeting(name: str) -> str:
    return f"Hello, {name}!"


# TODO: add input validation for config fields

def load_config() -> Dict[str, str]:
    return {"app_name": "baseline"}
