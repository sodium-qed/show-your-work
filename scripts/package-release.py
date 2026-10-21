"""Create a deterministic release ZIP and SHA-256 checksum with the standard library."""
import hashlib
import json
from pathlib import Path
import re
import stat
import zipfile


def main():
    root = Path(__file__).resolve().parent.parent
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    if package["name"] != "show-your-work" or not re.fullmatch(
        r"\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?", version, re.I
    ):
        raise ValueError("Expected the show-your-work package with a valid release version.")
    dist = root / "dist"
    folder = dist / f"show-your-work-{version}"
    if not folder.is_dir() or folder.is_symlink():
        raise ValueError("Run npm run build before packaging the release.")
    built = json.loads((folder / "version.json").read_text(encoding="utf-8"))
    if built["name"] != package["name"] or built["version"] != version:
        raise ValueError("The staged build version does not match package.json.")
    paths = sorted(folder.rglob("*"), key=lambda path: path.relative_to(dist).as_posix())
    if any(path.is_symlink() for path in paths):
        raise ValueError("Release packages must not contain symbolic links.")
    archive = dist / f"show-your-work-{version}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path in paths:
            if not path.is_file():
                continue
            entry = zipfile.ZipInfo(path.relative_to(dist).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            output.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (dist / "SHA256SUMS").write_text(f"{checksum}  {archive.name}\n", encoding="utf-8", newline="\n")
    print(f"Packaged {archive} ({archive.stat().st_size:,} bytes)")
    print(f"SHA256: {checksum}")


if __name__ == "__main__":
    main()
