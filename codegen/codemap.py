#!/usr/bin/env python3
"""Keep the codemap in sync with the source code.

Reads inspect.json for paths, extracts function/constant declarations from
the target source, and merges them into the existing codemap. Existing cluster
assignments and importance scores are preserved. New functions are added to
an "Unclustered" section for Claude to assign later.

Usage:
    python codegen/codemap.py              # print diff summary to stdout
    python codegen/codemap.py --update     # update the codemap in-place
    python codegen/codemap.py --json       # machine-readable output
"""

import re
import sys
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSPECT = json.loads((ROOT / "inspect.json").read_text())
SRC = (ROOT / INSPECT["src"]).resolve()
CODEMAP = (ROOT / INSPECT["codemap"]).resolve()

DEFAULT_IMPORTANCE = 3


# ── Extraction ──────────────────────────────────────────

def extract_functions(src_text: str):
    """Extract all function declarations with line numbers."""
    entries = []
    for i, line in enumerate(src_text.splitlines(), 1):
        # JS: function name(, async function name(
        m = re.search(r'\b(?:async\s+)?function\s+(\w+)\s*\(', line)
        if m:
            entries.append((i, m.group(1)))
            continue
        # Python: def name(
        m = re.search(r'^def\s+(\w+)\s*\(', line)
        if m:
            entries.append((i, m.group(1)))
    return entries


def extract_constants(src_text: str):
    """Extract top-level const/let ALL_CAPS names (JS) or UPPER_CASE = (Python)."""
    consts = []
    for i, line in enumerate(src_text.splitlines(), 1):
        # JS constants
        m = re.search(r'(?:const|let)\s+([A-Z][A-Z_0-9]{2,})\s*=', line)
        if m:
            consts.append((i, m.group(1)))
            continue
        # Python constants
        m = re.match(r'^([A-Z][A-Z_0-9]{2,})\s*=', line)
        if m:
            consts.append((i, m.group(1)))
    return consts


def total_lines(src_text: str) -> int:
    return len(src_text.splitlines())


# ── Existing codemap parsing ───────────────────────────

def parse_existing_codemap(codemap_path):
    """Parse the existing codemap into sections with their functions, importance scores, and order."""
    sections = {}       # section_name -> [(line_no, func_name)]
    importance = {}     # func_name -> int
    section_order = []  # preserve original ordering
    all_funcs = set()   # all function names already in the codemap

    try:
        text = codemap_path.read_text()
    except FileNotFoundError:
        return sections, importance, section_order, all_funcs

    current_section = None
    is_user_cluster = False

    for i, line in enumerate(text.splitlines()):
        sec_match = re.match(r'^## (.+)', line)
        if sec_match:
            current_section = sec_match.group(1).strip()
            # Skip user-cluster sections (managed by the server)
            next_lines = text.splitlines()
            is_user_cluster = (i + 1 < len(next_lines) and
                               next_lines[i + 1].strip() == '<!-- user-cluster -->')
            if not is_user_cluster and current_section not in sections:
                sections[current_section] = []
                section_order.append(current_section)
            continue

        if not current_section or is_user_cluster:
            continue

        func_match = re.match(r'^- `(\w+)`:.*~(\d+)', line)
        if func_match:
            name = func_match.group(1)
            line_no = int(func_match.group(2))
            sections[current_section].append((line_no, name))
            all_funcs.add(name)

            imp_match = re.search(r'importance:(\d+)', line)
            if imp_match:
                importance[name] = int(imp_match.group(1))

    return sections, importance, section_order, all_funcs


# ── Merge ──────────────────────────────────────────────

def merge(existing_sections, existing_importance, section_order,
          found_funcs):
    """Merge freshly extracted functions into existing codemap structure.

    - Existing assignments are preserved (with updated line numbers)
    - Removed functions are dropped
    - New functions go to 'Unclustered'
    """
    # Build lookup: func_name -> new_line_no
    found_map = {name: line_no for line_no, name in found_funcs}

    # Update line numbers for existing entries, drop removed functions
    updated_sections = {}
    for sec in section_order:
        entries = existing_sections.get(sec, [])
        updated = []
        for _, name in entries:
            if name in found_map:
                updated.append((found_map[name], name))
        if updated:
            updated_sections[sec] = updated

    # Find new functions not in any section
    assigned = set()
    for entries in updated_sections.values():
        for _, name in entries:
            assigned.add(name)

    new_funcs = [(ln, name) for ln, name in found_funcs if name not in assigned]

    if new_funcs:
        new_funcs.sort(key=lambda x: x[0])
        if "Unclustered" in updated_sections:
            updated_sections["Unclustered"].extend(new_funcs)
        else:
            updated_sections["Unclustered"] = new_funcs

    # Rebuild section order (preserve existing, append Unclustered at end if new)
    final_order = [s for s in section_order if s in updated_sections]
    if "Unclustered" in updated_sections and "Unclustered" not in final_order:
        final_order.append("Unclustered")

    return updated_sections, final_order, existing_importance


# ── Output ─────────────────────────────────────────────

def render_markdown(sections, section_order, n_lines, n_funcs, importance):
    name = INSPECT.get("name", "project")
    lines = [
        "---",
        "name: Code Map",
        f"description: Auto-generated map of all functions in {SRC.name} with line numbers and importance scores",
        "type: reference",
        "---",
        "",
        f"All code in `{SRC}` ({n_lines} lines, {n_funcs} functions).",
        "Auto-generated by `codegen/codemap.py`. Importance scores (1-10) are manually curated.",
        "",
    ]

    for sec in section_order:
        entries = sections.get(sec, [])
        if not entries:
            continue
        lines.append(f"## {sec}")
        for line_no, name in entries:
            imp = importance.get(name, DEFAULT_IMPORTANCE)
            lines.append(f"- `{name}`: ~{line_no} importance:{imp}")
        lines.append("")

    return "\n".join(lines)


def render_json(sections, section_order, n_lines, n_funcs):
    data = {
        "file": str(SRC),
        "total_lines": n_lines,
        "total_functions": n_funcs,
        "sections": {
            sec: [{"line": ln, "name": nm} for ln, nm in entries]
            for sec, entries in sections.items()
        },
    }
    return json.dumps(data, indent=2)


# ── Main ───────────────────────────────────────────────

def main():
    src_text = SRC.read_text()
    funcs = extract_functions(src_text)
    n_lines = total_lines(src_text)
    n_funcs = len(funcs)

    existing_sections, existing_importance, section_order, existing_funcs = \
        parse_existing_codemap(CODEMAP)

    sections, final_order, importance = merge(
        existing_sections, existing_importance, section_order, funcs,
    )

    # Diff summary
    found_names = {name for _, name in funcs}
    new_funcs = found_names - existing_funcs
    removed_funcs = existing_funcs - found_names

    if "--json" in sys.argv:
        print(render_json(sections, final_order, n_lines, n_funcs))
    elif "--update" in sys.argv:
        md = render_markdown(sections, final_order, n_lines, n_funcs, importance)
        CODEMAP.parent.mkdir(parents=True, exist_ok=True)
        CODEMAP.write_text(md)
        print(f"Updated {CODEMAP.relative_to(ROOT)} ({n_funcs} functions, {n_lines} lines)")
        if new_funcs:
            print(f"  + {len(new_funcs)} new: {', '.join(sorted(new_funcs))}")
        if removed_funcs:
            print(f"  - {len(removed_funcs)} removed: {', '.join(sorted(removed_funcs))}")
    else:
        if new_funcs:
            print(f"New ({len(new_funcs)}): {', '.join(sorted(new_funcs))}")
        if removed_funcs:
            print(f"Removed ({len(removed_funcs)}): {', '.join(sorted(removed_funcs))}")
        if not new_funcs and not removed_funcs:
            print(f"Codemap is up to date ({n_funcs} functions, {n_lines} lines)")
        else:
            print(f"\nRun with --update to apply changes")


if __name__ == "__main__":
    main()
