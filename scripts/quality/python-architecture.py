"""Project-specific import boundaries using Python's own parser; no code execution."""

import ast
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
modules = {p.stem: p for p in (root / "src/python").glob("*.py")}
edges = []
failures = []
for name, path in sorted(modules.items()):
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        imports = (
            [a.name for a in node.names]
            if isinstance(node, ast.Import)
            else ([node.module or ""] if isinstance(node, ast.ImportFrom) else [])
        )
        for imported in imports:
            target = imported.split(".")[0]
            if target in modules:
                edges.append(
                    {
                        "from": str(path.relative_to(root)),
                        "to": str(modules[target].relative_to(root)),
                        "kind": "python-import",
                        "line": node.lineno,
                    }
                )
            if target in {"socket", "subprocess", "urllib", "http", "requests", "importlib"}:
                failures.append(
                    f"{path.relative_to(root)}:{node.lineno}: forbidden domain import {imported}"
                )
graph = {str(p.relative_to(root)): [] for p in modules.values()}
for edge in edges:
    graph[edge["from"]].append(edge["to"])


def visit(node, active, done):
    if node in active:
        failures.append("Python dependency cycle: " + " -> ".join([*active, node]))
        return
    if node in done:
        return
    active.append(node)
    for target in graph[node]:
        visit(target, active, done)
    active.pop()
    done.add(node)


done = set()
for node in graph:
    visit(node, [], done)
if failures:
    sys.stderr.write("\n".join(failures) + "\n")
    sys.exit(1)
print(json.dumps({"modules": sorted(graph), "edges": edges}))
