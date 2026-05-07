#!/usr/bin/env python3
"""validate.py — Sanity-check the structure of a .hwpx file.

Checks performed:
- Is a valid zip
- ``mimetype`` is the first entry and contains ``application/hwp+zip``
- Required files exist (container.xml, content.hpf, header.xml, section0.xml)
- All XML / HPF / RDF files are well-formed

Exits 0 if all checks pass, 1 otherwise. Issues are printed to stderr.
"""

import argparse
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


REQUIRED_FILES = [
    "mimetype",
    "META-INF/container.xml",
    "Contents/content.hpf",
    "Contents/header.xml",
    "Contents/section0.xml",
]
EXPECTED_MIMETYPE = b"application/hwp+zip"
XML_SUFFIXES = (".xml", ".hpf", ".rdf")


def validate(hwpx_path: Path) -> list[str]:
    if not zipfile.is_zipfile(hwpx_path):
        return [f"not a valid zip: {hwpx_path}"]

    issues: list[str] = []
    with zipfile.ZipFile(hwpx_path, "r") as zf:
        names = zf.namelist()
        if not names:
            return ["zip is empty"]

        if names[0] != "mimetype":
            issues.append(f"first zip entry is {names[0]!r}, expected 'mimetype'")

        if "mimetype" in names:
            mt = zf.read("mimetype").strip()
            if mt != EXPECTED_MIMETYPE:
                issues.append(f"mimetype is {mt!r}, expected {EXPECTED_MIMETYPE!r}")

        for req in REQUIRED_FILES:
            if req not in names:
                issues.append(f"missing required file: {req}")

        for name in names:
            if not name.endswith(XML_SUFFIXES):
                continue
            try:
                ET.fromstring(zf.read(name))
            except ET.ParseError as e:
                issues.append(f"malformed XML in {name}: {e}")

    return issues


def main() -> None:
    ap = argparse.ArgumentParser(description="Validate the structure of a .hwpx file.")
    ap.add_argument("input", type=Path, help="path to .hwpx file")
    args = ap.parse_args()

    if not args.input.exists():
        ap.error(f"input not found: {args.input}")

    issues = validate(args.input)
    if issues:
        print(f"INVALID: {args.input}", file=sys.stderr)
        for i in issues:
            print(f"  - {i}", file=sys.stderr)
        sys.exit(1)
    print(f"OK: {args.input}", file=sys.stderr)


if __name__ == "__main__":
    main()
