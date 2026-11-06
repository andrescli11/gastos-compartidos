#!/usr/bin/env python3
"""Synthetic regression checks for the exact temporary-policy TOC filter."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True

path = Path(__file__).with_name("filter-backup-toc.py")
spec = importlib.util.spec_from_file_location("backup_toc_filter", path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

header = "; Archive TOC\n; cusco_backup_snapshot_read is removed only as a POLICY\n"
keep = (
    "1; 2615 16384 SCHEMA - app_private postgres\n"
    "2; 1259 16385 TABLE app_private expenses postgres\n"
    "3; 3256 16386 POLICY app_private expenses participant_read postgres\n"
    "4; 3256 16387 POLICY public expenses cusco_backup_snapshot_read postgres\n"
    "5; 1259 16388 TABLE app_private cusco_backup_snapshot_read postgres\n"
    "6; 3256 16389 POLICY app_private expenses cusco_backup_snapshot_read_extra postgres\n"
    "7; 3256 16390 POLICY other_private expenses cusco_backup_snapshot_read postgres\n"
    "8; 0 16385 TABLE DATA app_private expenses postgres\n"
)
remove = (
    "9; 3256 16391 POLICY app_private expenses cusco_backup_snapshot_read postgres\n"
    "10; 3256 16392 POLICY app_private import_saved_rows cusco_backup_snapshot_read postgres\n"
)
assert module.filter_toc(header + keep + remove) == header + keep
assert module.filter_toc(header + keep) == header + keep
assert module.filter_toc(remove.replace("\n", "\r\n")) == ""
assert module.filter_toc(remove.rstrip("\n")) == ""
for invalid in (
    '11; 3256 16393 POLICY app_private "table with spaces" cusco_backup_snapshot_read postgres\n',
    "\x00",
):
    try:
        module.filter_toc(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("Malformed controlled policy was accepted.")
result = subprocess.run(
    [sys.executable, str(path)],
    input=(header + keep + remove).encode(),
    capture_output=True,
    check=True,
)
assert result.stdout == (header + keep).encode()
assert not result.stderr
failed = subprocess.run(
    [sys.executable, str(path)], input=b"\xff", capture_output=True, check=False
)
assert failed.returncode != 0 and not failed.stdout
assert b"details withheld" in failed.stderr
print("Backup TOC filter preserves all entries except the exact temporary private policy.")
