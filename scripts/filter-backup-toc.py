#!/usr/bin/env python3
"""Exclude only the controlled, temporary backup policy from a pg_restore TOC.

Usage: pg_restore --list backup.dump | python3 scripts/filter-backup-toc.py > restore.list
The archive itself stays encrypted/private; this filter never reads table data.
Unknown spellings of the controlled policy fail closed instead of guessing.
"""
from __future__ import annotations

import re
import sys

POLICY_NAME = "cusco_backup_snapshot_read"
MAX_TOC_BYTES = 16 * 1024 * 1024
_CONTROLLED_POLICY = re.compile(
    r"^\d+;\s+\d+\s+\d+\s+POLICY\s+app_private\s+"
    r"[A-Za-z_][A-Za-z0-9_]*\s+cusco_backup_snapshot_read\s+"
    r"[A-Za-z_][A-Za-z0-9_]*\s*$"
)


def filter_toc(text: str) -> str:
    """Preserve every entry except our exact app_private backup-only POLICY."""
    if "\x00" in text or len(text.encode("utf-8")) > MAX_TOC_BYTES:
        raise ValueError("Invalid or oversized backup table of contents.")
    output: list[str] = []
    for line in text.splitlines(keepends=True):
        if line.lstrip().startswith(";"):
            output.append(line)
            continue
        if _CONTROLLED_POLICY.fullmatch(line.rstrip("\r\n")):
            continue
        # An unexpected table/owner quoting format must never silently leave a
        # controlled policy in an archive that will outlive its temporary role.
        if (
            re.search(r"\bPOLICY\s+app_private\b", line)
            and re.search(r"\bcusco_backup_snapshot_read\b", line)
        ):
            raise ValueError("Unrecognized temporary backup policy entry.")
        output.append(line)
    return "".join(output)


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_TOC_BYTES + 1)
        if len(raw) > MAX_TOC_BYTES:
            raise ValueError("Oversized table of contents.")
        result = filter_toc(raw.decode("utf-8", errors="strict"))
    except (UnicodeError, ValueError):
        print("Backup TOC filtering failed; details withheld.", file=sys.stderr)
        return 1
    sys.stdout.write(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
