#!/usr/bin/env python3
"""pack.py — Repack an unpacked HWPX directory into a .hwpx file.

Inverse of unpack.py. The mimetype file is written first and stored
uncompressed (per the OCF / OPF spec) so the resulting archive is
valid for HWPX viewers.

This script does NOT regenerate the OPF manifest in
``Contents/content.hpf``. If you added or removed files in the
unpacked directory, edit that manifest by hand or invoke validate.py
to detect mismatches.
"""

import argparse
import os
import sys
import zipfile
from pathlib import Path


MIMETYPE = "mimetype"
EXPECTED_MIMETYPE_VALUE = b"application/hwp+zip"


def pack(unpacked_dir: Path, output_path: Path) -> int:
    mimetype_path = unpacked_dir / MIMETYPE
    if not mimetype_path.exists():
        raise SystemExit(f"missing mimetype file in {unpacked_dir}")

    actual = mimetype_path.read_bytes().strip()
    if actual != EXPECTED_MIMETYPE_VALUE:
        # Write a warning but continue — some authoring tools include trailing newline.
        print(
            f"warning: mimetype contents are {actual!r}, expected {EXPECTED_MIMETYPE_VALUE!r}",
            file=sys.stderr,
        )

    written = 0
    with zipfile.ZipFile(output_path, "w") as zf:
        # mimetype must be the first entry, stored uncompressed.
        zf.write(mimetype_path, MIMETYPE, compress_type=zipfile.ZIP_STORED)
        written += 1

        for root, dirs, files in os.walk(unpacked_dir):
            dirs.sort()
            files.sort()
            for fname in files:
                full = Path(root) / fname
                rel = full.relative_to(unpacked_dir).as_posix()
                if rel == MIMETYPE:
                    continue
                zf.write(full, rel, compress_type=zipfile.ZIP_DEFLATED)
                written += 1
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description="Repack an unpacked HWPX directory into a .hwpx file.")
    ap.add_argument("input_dir", type=Path, help="unpacked directory")
    ap.add_argument("output", type=Path, help="target .hwpx file")
    ap.add_argument(
        "--original",
        type=Path,
        help="(reserved) path to original .hwpx — currently unused; kept for API parity with docx skill",
    )
    args = ap.parse_args()

    if not args.input_dir.exists() or not args.input_dir.is_dir():
        ap.error(f"directory not found: {args.input_dir}")

    n = pack(args.input_dir, args.output)
    print(f"packed {n} entries: {args.input_dir} -> {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
