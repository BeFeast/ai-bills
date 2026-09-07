#!/usr/bin/env bash
# Build in an isolated checkout of the exact audited upstream commit.
set -euo pipefail
source_dir=${1:?Usage: build.sh SOURCE_CHECKOUT OUTPUT_BINARY}
output_binary=${2:?Usage: build.sh SOURCE_CHECKOUT OUTPUT_BINARY}
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
expected=934fb7928c42a8dd0aeaf39a321bef6601b55eb6
[[ $(git -C "$source_dir" rev-parse HEAD) == "$expected" ]] || { echo 'Wrong upstream commit' >&2; exit 2; }
git -C "$source_dir" diff --quiet
git -C "$source_dir" diff --cached --quiet
git -C "$source_dir" apply --check "$package_dir/managed-v1.patch"
git -C "$source_dir" apply "$package_dir/managed-v1.patch"
(cd "$source_dir" && go test ./sdk/cliproxy/managed ./sdk/cliproxy/auth ./internal/api ./internal/redisqueue ./internal/runtime/executor/helps ./sdk/api/handlers ./internal/runtime/executor -run 'TestManaged|TestUsageQueuePlugin|Test.*Unauthorized|Test.*Bootstrap|Test.*NewUtlsHTTPClient' -count=1)
(cd "$source_dir" && go build -trimpath -ldflags "-X main.Version=7.2.153-ai-bills-managed.3 -X main.Commit=$expected -X main.BuildDate=2026-09-07" -o "$output_binary" ./cmd/server)
sha256sum "$output_binary"
