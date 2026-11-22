"""Python parity bridge to the single authoritative Node dispatcher. No credentials in argv."""
import subprocess
import sys
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[2]
    node = root / "inherited-v53" / "node.exe"
    entry = root / "src" / "cli" / "main.cjs"
    try:
        return subprocess.call([str(node), str(entry), *sys.argv[1:]])
    except (OSError, KeyboardInterrupt):
        print("CLI_BRIDGE_INTERRUPTED_OR_UNAVAILABLE: no service termination requested", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
