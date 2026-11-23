#!/usr/bin/env bash
# Independent opt-in suite; never mounts credentials, profiles or the checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
run_id=$(date +%s%N)
base="ai-harness:accessibility-base-$run_id"
image="ai-harness:accessibility-$run_id"
container="aiharness-desktop-accessibility-$run_id"
output="test-results/desktop-accessibility-$run_id"
mkdir -p "$output"
cleanup() {
    status=$?
    trap - EXIT
    docker cp "$container:/tmp/desktop-accessibility/." "$output/" 2>/dev/null || true
    docker inspect --format '{{json .State}}' "$container" > "$output/container-state.json" 2>/dev/null || true
    docker rm -f "$container" >/dev/null 2>&1 || true
    docker image rm "$image" "$base" >/dev/null 2>&1 || true
    printf '\nDesktop accessibility exit=%s; artifacts: %s\n' "$status" "$output"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build -f .docker/Dockerfile.test --target test-runner -t "$base" . 2>&1 | tee "$output/build-base.log"
docker build -f .docker/Dockerfile.accessibility --build-arg "TEST_IMAGE=$base" -t "$image" . 2>&1 | tee "$output/build-desktop.log"
docker image inspect --format '{{.Id}}' "$base" "$image" > "$output/image-ids.txt"
docker create --name "$container" --network none --shm-size=1g "$image" > "$output/container-id.txt"
docker start --attach "$container" 2>&1 | tee "$output/run.log"
