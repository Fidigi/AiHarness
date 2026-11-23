#!/usr/bin/env bash
# Standalone validation/export; never runs tests or builds on the host.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ ! -L demo && -d demo && ! -L demo/scripts ]] || { echo 'Refusing linked demo directories.' >&2; exit 1; }
demo_root="$(pwd -P)/demo"
source demo/scripts/export.sh
run_id="$(date +%s%N)-$$"
image="ai-harness:demo-${run_id}"
container="aih-demo-${run_id}"
base="${DEMO_BASE:-/AiHarness/}"
export_stage="$(mktemp -d "$demo_root/.export-XXXXXXXX")"
update=false
for arg in "$@"; do
  case "$arg" in --update-snapshots|--update-snapshots=all|--update-snapshots=changed|--update-snapshots=missing) update=true ;; esac
done
cleanup() {
  local status=$? export_status=0 copy_status name
  trap - EXIT
  set +e
  # Dist is required only after successful validation. Failure must not publish an unvalidated build.
  if [[ "$status" == 0 ]]; then
    mkdir "$export_stage/dist"
    docker cp "${container}:/app/demo/dist/." "$export_stage/dist/"
    copy_status=$?
    if [[ "$copy_status" == 0 ]]; then
      publish_generated "$export_stage/dist" dist
      copy_status=$?
    fi
    if [[ "$copy_status" != 0 ]]; then
      echo 'Required validated demo/dist export failed.' >&2
      export_status=$copy_status
    fi
  fi
  for name in playwright-report test-results; do
    mkdir "$export_stage/$name"
    if ! docker cp "${container}:/app/demo/$name/." "$export_stage/$name/" 2>/dev/null ||
       ! publish_generated "$export_stage/$name" "$name"; then
      echo "Optional demo/$name export unavailable." >&2
    fi
  done
  if "$update"; then
    mkdir "$export_stage/baselines"
    docker cp "${container}:/app/demo/.baseline-delta/." "$export_stage/baselines/"
    copy_status=$?
    if [[ "$copy_status" == 0 ]]; then
      publish_baselines "$export_stage/baselines"
      copy_status=$?
    fi
    if [[ "$copy_status" != 0 ]]; then
      echo 'Requested baseline delta export failed.' >&2
      if [[ "$export_status" == 0 ]]; then export_status=$copy_status; fi
    fi
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf -- "$export_stage"
  # Optional exports/cleanup can never hide an original build/create/start/test failure.
  if [[ "$status" != 0 ]]; then exit "$status"; fi
  exit "$export_status"
}
trap cleanup EXIT
docker build -f .docker/Dockerfile.test --target test-runner -t "$image" .
docker create --name "$container" --shm-size=2g -e CI=true -e DEMO_BASE="$base" "$image" \
  bash demo/scripts/validate.sh "$@" >/dev/null
docker start --attach "$container"
