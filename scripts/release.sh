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

# 从本地 dist/*.artifact.json 读哈希，不从 Release 回读：
# publish job 里新包还没上传，读 Release 只会拿到上一次的旧哈希，导致候选清单
# 与实际资产不一致（审核时 sha256 校验失败）。本地产物是本 job 刚下载的权威来源。
shopt -s nullglob
ARTIFACT_FILES=("$ROOT"/dist/*.artifact.json)
if [ "${#ARTIFACT_FILES[@]}" -eq 0 ]; then
  echo "No .artifact.json files found in dist/ — run dbx-plugin package first" >&2
  exit 1
fi

python3 - "$OUT" "$MANIFEST" "$REPOSITORY" "$VERSION" "${ARTIFACT_FILES[@]}" <<'PY'
import json
import sys

out_path, manifest_path, repository, version, *artifact_files = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as stream:
    manifest = json.load(stream)

artifacts = []
for artifact_path in artifact_files:
    with open(artifact_path, encoding="utf-8") as stream:
        metadata = json.load(stream)
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
