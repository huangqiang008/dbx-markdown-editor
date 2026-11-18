#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/store-submission/release-candidates.json"
MANIFEST="$ROOT/manifest.json"
REPOSITORY="${GITHUB_REPOSITORY:-huangqiang008/dbx-markdown-editor}"

VERSION="$(python3 - "$MANIFEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    print(json.load(stream)["version"])
PY
)"

mkdir -p "$(dirname "$OUT")"

mapfile -t ARTIFACT_NAMES < <(
  gh api "repos/$REPOSITORY/releases/tags/v$VERSION" --jq '.assets[].name' \
    | grep '\.artifact\.json$'
)
if [ "${#ARTIFACT_NAMES[@]}" -eq 0 ]; then
  echo "No .artifact.json assets found for v$VERSION" >&2
  exit 1
fi

python3 - "$OUT" "$MANIFEST" "$REPOSITORY" "$VERSION" "${ARTIFACT_NAMES[@]}" <<'PY'
import json
import subprocess
import sys

out_path, manifest_path, repository, version, *artifact_names = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as stream:
    manifest = json.load(stream)

artifacts = []
for name in artifact_names:
    url = f"https://github.com/{repository}/releases/download/v{version}/{name}"
    raw = subprocess.run(["curl", "-fsSL", url], check=True, capture_output=True, text=True).stdout
    metadata = json.loads(raw)
    target = metadata["target"]
    package_name = f"{manifest['id']}-{version}-{target}.dbxp"
    artifacts.append({
        "target": target,
        "url": f"https://github.com/{repository}/releases/download/v{version}/{package_name}",
        "sha256": metadata["sha256"],
        "size": metadata["size"],
    })

candidate = {
    "schemaVersion": 1,
    "plugin": {
        "id": manifest["id"],
        "publisher": manifest["publisher"],
        "version": version,
        "permissions": manifest.get("permissions", []),
    },
    "artifacts": sorted(artifacts, key=lambda artifact: artifact["target"]),
}
with open(out_path, "w", encoding="utf-8") as stream:
    json.dump(candidate, stream, indent=2)
    stream.write("\n")
PY

cat "$OUT"
