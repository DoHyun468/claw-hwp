#!/usr/bin/env python3
"""pack.py — Repack an unpacked HWPX directory into a .hwpx file.

Inverse of unpack.py. The mimetype file is written first and stored
uncompressed (per the OCF / OPF spec) so the resulting archive is
valid for HWPX viewers.

This script does NOT regenerate the OPF manifest in
``Contents/content.hpf``. If you added or removed files in the
unpacked directory, edit that manifest by hand or invoke validate.py
to detect mismatches.

It DOES auto-sync the root ``<hh:head ... secCnt="N">`` in
``Contents/header.xml`` to the number of ``Contents/sectionN.xml`` body
sections on repack. Hancom Docs trusts secCnt over the actual file set,
so a stale secCnt after adding/removing a section makes Hancom Docs (web)
refuse to open the file ("문서를 열 수 없습니다") even though more lenient
viewers accept it. This is the HWPX analog of ``.hwp``'s DocInfo
``HWPTAG_DOCUMENT_PROPERTIES`` section count.
"""

import argparse
import os
import re
import sys
import zipfile
from pathlib import Path


MIMETYPE = "mimetype"
EXPECTED_MIMETYPE_VALUE = b"application/hwp+zip"
HEADER_REL = "Contents/header.xml"
# A body section file: Contents/section0.xml, section1.xml, ...
SECTION_NAME_RE = re.compile(r"section\d+\.xml")
# The root <hh:head ... secCnt="N"> attribute (any namespace prefix). secCnt
# only appears on <head>, but we anchor on the tag to be safe. Bytes regex —
# header.xml is UTF-8 and secCnt's value is ASCII digits.
SECCNT_RE = re.compile(rb'<(?:\w+:)?head\b[^>]*?secCnt="(\d+)"')


def count_sections(unpacked_dir: Path) -> int:
    """Count Contents/sectionN.xml body sections in the unpacked dir."""
    contents = unpacked_dir / "Contents"
    if not contents.is_dir():
        return 0
    return sum(1 for p in contents.iterdir() if SECTION_NAME_RE.fullmatch(p.name))


def sync_seccnt(header_bytes: bytes, n: int):
    """Patch the root <hh:head ... secCnt="N"> to match the real section count.

    Returns ``(patched_bytes, old, new)``. It is a no-op (``old == new``, or
    both ``None``) when secCnt is already correct, the attribute can't be found,
    or ``n < 1`` (a count of 0 means something is wrong — never write secCnt="0").
    """
    if n < 1:
        return header_bytes, None, None
    m = SECCNT_RE.search(header_bytes)
    if not m:
        return header_bytes, None, None
    old = m.group(1).decode("ascii")
    new = str(n)
    if old == new:
        return header_bytes, old, new
    patched = header_bytes[: m.start(1)] + new.encode("ascii") + header_bytes[m.end(1) :]
    return patched, old, new


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

    section_count = count_sections(unpacked_dir)
    seccnt_change = None

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
                # Auto-sync header.xml secCnt to the real section count so a
                # section add/remove doesn't leave Hancom Docs rejecting the file.
                if rel == HEADER_REL and section_count >= 1:
                    patched, old, new = sync_seccnt(full.read_bytes(), section_count)
                    if old is not None and old != new:
                        zf.writestr(rel, patched, compress_type=zipfile.ZIP_DEFLATED)
                        seccnt_change = (old, new)
                        written += 1
                        continue
                zf.write(full, rel, compress_type=zipfile.ZIP_DEFLATED)
                written += 1

    if seccnt_change is not None:
        print(
            f"synced header.xml secCnt: {seccnt_change[0]} -> {seccnt_change[1]} "
            f"({section_count} section file(s))",
            file=sys.stderr,
        )
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
