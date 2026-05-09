"""Baseline app entry."""

from utils import build_greeting, load_config


def main() -> str:
    config = load_config()
    greeting = build_greeting(config.get("app_name", "app"))
    return greeting


if __name__ == "__main__":
    print(main())
