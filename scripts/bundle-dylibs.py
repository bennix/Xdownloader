#!/usr/bin/env python3
import os
import shutil
import subprocess
import sys

SYSTEM = ("/usr/lib/", "/System/", "/Library/Apple/")


def deps(path: str) -> list[str]:
    out = subprocess.check_output(["otool", "-L", path], text=True)
    items = []
    for line in out.splitlines()[1:]:
        token = line.strip().split(" ", 1)[0]
        if token:
            items.append(token)
    return items


def system(path: str) -> bool:
    return path.startswith(SYSTEM) or path.startswith("@")


def collect(binary: str, seen: dict[str, str]) -> None:
    for dep in deps(binary):
        if system(dep):
            continue
        real = os.path.realpath(dep)
        if not os.path.exists(real) or real in seen:
            continue
        seen[real] = os.path.basename(real)
        collect(real, seen)


def change(path: str, old: str, new: str) -> None:
    subprocess.check_call(["install_name_tool", "-change", old, new, path])


def rewrite(path: str, names: set[str]) -> None:
    for dep in deps(path):
        if system(dep) or dep.startswith("@executable_path"):
            continue
        base = os.path.basename(os.path.realpath(dep) if os.path.exists(dep) else dep)
        if base in names:
            change(path, dep, f"@executable_path/lib/{base}")


def main() -> None:
    binary, libdir = sys.argv[1], sys.argv[2]
    os.makedirs(libdir, exist_ok=True)
    seen: dict[str, str] = {}
    collect(binary, seen)
    names = set(seen.values())
    for real, name in seen.items():
        dest = os.path.join(libdir, name)
        if not os.path.exists(dest):
            shutil.copy2(real, dest)
        subprocess.call(["install_name_tool", "-id", f"@executable_path/lib/{name}", dest], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rewrite(binary, names)
    for real, name in seen.items():
        rewrite(os.path.join(libdir, name), names)


if __name__ == "__main__":
    main()
