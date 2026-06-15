#!/usr/bin/env python3
"""validate.py — Sanity-check the structure of a .hwpx file.

Checks performed:
- Is a valid zip
- ``mimetype`` is the first entry and contains ``application/hwp+zip``
- Required files exist (container.xml, content.hpf, header.xml, section0.xml)
- All XML / HPF / RDF files are well-formed
- ``header.xml`` ``secCnt`` matches the number of ``Contents/sectionN.xml``
  files (Hancom Docs trusts secCnt and rejects the file on mismatch)
- ``content.hpf`` manifest has no ``<opf:item>`` href pointing at a missing file

Exits 0 if all checks pass, 1 otherwise. Issues are printed to stderr.
"""

import argparse
import re
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
SECTION_FILE_RE = re.compile(r"Contents/section\d+\.xml")
SECCNT_RE = re.compile(rb'<(?:\w+:)?head\b[^>]*?secCnt="(\d+)"')
OPF_HREF_RE = re.compile(rb'<opf:item\b[^>]*?href="([^"]*)"')


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

        # secCnt must match the number of body sections — Hancom Docs trusts
        # secCnt over the actual file set and refuses to open on mismatch.
        if "Contents/header.xml" in names:
            m = SECCNT_RE.search(zf.read("Contents/header.xml"))
            if m:
                declared = int(m.group(1))
                actual = sum(1 for n in names if SECTION_FILE_RE.fullmatch(n))
                if declared != actual:
                    issues.append(
                        f"header.xml secCnt={declared} but {actual} "
                        f"Contents/sectionN.xml file(s) present"
                    )

        # Manifest must not reference files missing from the package.
        if "Contents/content.hpf" in names:
            nameset = set(names)
            for href in OPF_HREF_RE.findall(zf.read("Contents/content.hpf")):
                h = href.decode("utf-8")
                if h not in nameset:
                    issues.append(f"content.hpf manifest references missing file: {h}")

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
