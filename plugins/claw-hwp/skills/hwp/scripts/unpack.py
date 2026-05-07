#!/usr/bin/env python3
"""unpack.py — Unzip a .hwpx file into a directory of pretty-printed XML.

Inverse of pack.py. After unpacking, edit XML files directly using your
file-editing tools, then run pack.py to repackage.
"""

import argparse
import sys
import zipfile
from pathlib import Path
from xml.dom import minidom


XML_SUFFIXES = (".xml", ".hpf", ".rdf")


def pretty_print_xml(xml_bytes: bytes) -> bytes:
    """Pretty-print XML with 2-space indent. Falls back to original on parse error."""
    try:
        dom = minidom.parseString(xml_bytes)
    except Exception:
        return xml_bytes
    pretty = dom.toprettyxml(indent="  ", encoding="utf-8")
    # minidom over-emits blank lines; collapse them.
    lines = [line for line in pretty.split(b"\n") if line.strip()]
    return b"\n".join(lines) + b"\n"


def looks_like_xml(name: str, data: bytes) -> bool:
    return name.endswith(XML_SUFFIXES) and data.startswith(b"<?xml")


def unpack(hwpx_path: Path, out_dir: Path, pretty: bool = True) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(hwpx_path, "r") as zf:
        for name in zf.namelist():
            target = out_dir / name
            if name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            data = zf.read(name)
            if pretty and looks_like_xml(name, data):
                data = pretty_print_xml(data)
            target.write_bytes(data)
            count += 1
    return count


def main() -> None:
    ap = argparse.ArgumentParser(description="Unzip .hwpx into a directory of XML files.")
    ap.add_argument("input", type=Path, help="path to .hwpx file")
    ap.add_argument("output", type=Path, help="target directory")
    ap.add_argument("--no-pretty", action="store_true", help="skip XML pretty-printing")
    args = ap.parse_args()

    if not args.input.exists():
        ap.error(f"input not found: {args.input}")
    if not zipfile.is_zipfile(args.input):
        ap.error(
            f"not a valid HWPX (zip): {args.input}\n"
            "  Hint: HWP 5.0 binary files are not zips. "
            "Run `node convert.js <input.hwp> <output.hwpx>` first."
        )

    n = unpack(args.input, args.output, pretty=not args.no_pretty)
    print(f"unpacked {n} file(s): {args.input} -> {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
