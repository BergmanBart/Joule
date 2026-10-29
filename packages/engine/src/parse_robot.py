"""Parse .robot/.resource files with Robot Framework's own parser and print a JSON summary.

Usage: python parse_robot.py <folder>
       python parse_robot.py --custom <folder>   (only the keywords in <folder>/custom_keywords)
Used by Joule to open projects it did not create (or that were edited by hand).
"""
import ast
import json
import sys
from pathlib import Path

from robot.api import get_model
from robot.api.parsing import Comment, EmptyLine, If, KeywordCall

# Keep in sync with CUSTOM_KEYWORDS_DIR in core/src/custom.ts.
CUSTOM_DIR = "custom_keywords"


def source_lines(node, lines):
    return [l.rstrip("\n") for l in lines[node.lineno - 1 : node.end_lineno]]


def convert_body(body, lines):
    out = []
    for node in body:
        if isinstance(node, (EmptyLine, Comment)):
            continue
        if isinstance(node, KeywordCall):
            out.append({"kind": "call", "keyword": node.keyword, "args": list(node.args), "assign": list(node.assign), "lines": source_lines(node, lines)})
        elif isinstance(node, If) and node.type == "IF":
            branches = []
            branch = node
            while branch is not None:
                branches.append({"condition": branch.condition, "body": convert_body(branch.body, lines)})
                branch = branch.orelse
            out.append({"kind": "if", "branches": branches, "lines": source_lines(node, lines)})
        else:
            stype = getattr(node, "type", None)
            if stype == "DOCUMENTATION":
                out.append({"kind": "doc", "value": node.value})
            elif stype == "TAGS":
                out.append({"kind": "tags", "values": list(node.values)})
            elif hasattr(node, "lineno"):
                out.append({"kind": "raw", "lines": source_lines(node, lines)})
    return out


def parse_file(path, root):
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    model = get_model(str(path))
    result = {"file": path.relative_to(root).as_posix(), "tests": [], "keywords": [], "variables": [], "settings": []}
    for section in model.sections:
        kind = type(section).__name__
        if kind == "TestCaseSection":
            for test in section.body:
                if hasattr(test, "name"):
                    result["tests"].append({"name": test.name, "body": convert_body(test.body, lines)})
        elif kind == "KeywordSection":
            for kw in section.body:
                if hasattr(kw, "name"):
                    result["keywords"].append({"name": kw.name, "body": convert_body(kw.body, lines)})
        elif kind == "VariableSection":
            for var in section.body:
                if getattr(var, "type", None) == "VARIABLE":
                    result["variables"].append({"name": var.name, "value": list(var.value)})
        elif kind == "SettingSection":
            for s in section.body:
                if hasattr(s, "lineno") and getattr(s, "type", None) not in ("EOL", None):
                    result["settings"].append(source_lines(s, lines))
    return result


def parse_env(path):
    """Read simple NAME = "literal" assignments without executing the file."""
    values = {}
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except Exception:
        return values
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                value = ast.literal_eval(node.value)
            except Exception:
                continue
            if isinstance(value, (str, int, float, bool)) and not node.targets[0].id.startswith("_"):
                values[node.targets[0].id] = str(value)
    return values


def robot_files(folder):
    return sorted(list(folder.rglob("*.robot")) + list(folder.rglob("*.resource")))


def parse_custom(root):
    """Name, documentation and [Arguments] of every keyword in custom_keywords/."""
    out = []
    folder = root / CUSTOM_DIR
    if not folder.is_dir():
        return out
    for path in robot_files(folder):
        entry = {"file": path.relative_to(root).as_posix(), "keywords": []}
        try:
            for section in get_model(str(path)).sections:
                if type(section).__name__ != "KeywordSection":
                    continue
                for kw in section.body:
                    if not hasattr(kw, "name"):
                        continue
                    doc, args = "", []
                    for node in kw.body:
                        stype = getattr(node, "type", None)
                        if stype == "DOCUMENTATION":
                            doc = node.value
                        elif stype == "ARGUMENTS":
                            args = list(node.values)
                    entry["keywords"].append({"name": kw.name, "doc": doc, "args": args})
        except Exception as e:  # keep going; report per file
            entry["error"] = str(e)
        out.append(entry)
    return out


def main():
    if sys.argv[1] == "--custom":
        sys.stdout.write(json.dumps({"custom": parse_custom(Path(sys.argv[2]).resolve())}))
        return
    root = Path(sys.argv[1]).resolve()
    files = []
    for path in robot_files(root):
        rel = path.relative_to(root).parts
        if any(part in (".venv", "node_modules", "logs") for part in path.parts) or rel[0] == CUSTOM_DIR:
            continue
        try:
            files.append(parse_file(path, root))
        except Exception as e:  # keep going; report per file
            files.append({"file": path.relative_to(root).as_posix(), "error": str(e)})
    env = {}
    env_dir = root / "env"
    if env_dir.is_dir():
        for path in env_dir.glob("*.py"):
            env[path.stem] = parse_env(path)
    sys.stdout.write(json.dumps({"files": files, "env": env, "custom": parse_custom(root)}))


if __name__ == "__main__":
    main()
