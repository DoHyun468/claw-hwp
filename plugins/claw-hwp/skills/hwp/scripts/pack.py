#!/usr/bin/env python3
"""pack.py — Repack an unpacked HWPX directory into a .hwpx file.

Inverse of unpack.py. The mimetype file is written first and stored
uncompressed (per the OCF / OPF spec) so the resulting archive is
valid for HWPX viewers.

On repack this script auto-repairs two things that, left stale, make
Hancom Docs reject the file:

1. It prunes OPF manifest entries in ``Contents/content.hpf`` (the
   ``<opf:item>`` plus its ``<opf:spine><opf:itemref>``) for any file that
   is no longer present in the unpacked directory — so removing a section or
   image no longer leaves a dangling reference. It does NOT *add* manifest
   entries for newly added files; register those with their own
   ``<opf:item>`` (or run validate.py to detect the mismatch).

2. It auto-syncs the root ``<hh:head ... secCnt="N">`` in
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
CONTENT_HPF_REL = "Contents/content.hpf"
# A self-closing <opf:item .../> manifest entry. `item\b` won't match
# <opf:itemref> (there's no word boundary between "item" and "ref").
OPF_ITEM_RE = re.compile(rb"<opf:item\b[^>]*/>")


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


def collect_rel_files(unpacked_dir: Path) -> set:
    """Set of every packaged file's posix path relative to the unpacked dir."""
    rels = set()
    for root, _dirs, fnames in os.walk(unpacked_dir):
        for fn in fnames:
            rels.add((Path(root) / fn).relative_to(unpacked_dir).as_posix())
    return rels


def prune_manifest(hpf_bytes: bytes, present: set):
    """Drop <opf:item> manifest entries whose href file is gone, plus the
    matching <opf:spine><opf:itemref idref=...>. Returns (patched, removed_ids).

    Covers the common removal case (deleting a section or image without
    hand-editing content.hpf) so the manual unpack->edit->pack path doesn't
    leave a dangling manifest reference that Hancom rejects. It does NOT add
    entries for newly added files — register those with their own <opf:item>.
    """
    removed_ids = []

    def drop_dangling(m):
        tag = m.group(0)
        href_m = re.search(rb'href="([^"]*)"', tag)
        if href_m and href_m.group(1).decode("utf-8") not in present:
            id_m = re.search(rb'id="([^"]*)"', tag)
            if id_m:
                removed_ids.append(id_m.group(1))
            return b""
        return tag

    patched = OPF_ITEM_RE.sub(drop_dangling, hpf_bytes)
    for rid in removed_ids:
        ref_re = re.compile(rb'<opf:itemref\b[^>]*idref="' + re.escape(rid) + rb'"[^>]*/>')
        patched = ref_re.sub(b"", patched)
    return patched, [r.decode("utf-8") for r in removed_ids]


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

    present = collect_rel_files(unpacked_dir)
    section_count = count_sections(unpacked_dir)
    seccnt_change = None
    pruned_ids = []

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
                # Prune content.hpf manifest/spine entries for files now gone.
                if rel == CONTENT_HPF_REL:
                    patched, removed = prune_manifest(full.read_bytes(), present)
                    if removed:
                        zf.writestr(rel, patched, compress_type=zipfile.ZIP_DEFLATED)
                        pruned_ids.extend(removed)
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
    if pruned_ids:
        print(
            f"pruned {len(pruned_ids)} dangling manifest entr"
            f"{'y' if len(pruned_ids) == 1 else 'ies'}: {', '.join(pruned_ids)}",
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
