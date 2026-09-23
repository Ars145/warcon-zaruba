#!/usr/bin/env bash
# Pulls the image GitHub published for main and restarts the stack if it moved.
#
# The server pulls; nothing reaches in. A run that finds no new image costs one
# registry round trip and touches nothing. A run that does find one keeps the
# image id it replaced, so a build that comes up unhealthy is rolled back here
# rather than waiting for someone to notice.
set -uo pipefail

DIR=${WARCON_DIR:-/opt/warcon}
IMAGE=${WARCON_IMAGE:-ghcr.io/ars145/warcon-zaruba:main}
HEALTH=${WARCON_HEALTH:-http://127.0.0.1:3000/api/health}
BACKUPS=${WARCON_BACKUPS:-/opt/warcon-backups}
KEEP=${WARCON_KEEP_BACKUPS:-7}
WAIT=${WARCON_HEALTH_WAIT:-90}

log() { echo "[$(date -u +%FT%TZ)] $*"; }
compose() { docker compose --project-directory "$DIR" "$@"; }

cd "$DIR" || { log "no $DIR"; exit 1; }

before=$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)

if ! compose pull --quiet 2>&1 | tail -3; then
  log "pull failed; leaving the running stack alone"
  exit 1
fi

after=$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)
if [ -z "$after" ]; then
  log "image $IMAGE is not present after pull"
  exit 1
fi
if [ "$before" = "$after" ]; then
  exit 0
fi

log "new image: ${before:-none} -> $after"

# The schema is migrated by the migrate container on every start, so the dump
# has to be taken before the new image gets a chance to run.
mkdir -p "$BACKUPS"
dump="$BACKUPS/warcon-$(date +%F-%H%M)-pre-update.dump"
if docker exec warcon-db-1 pg_dump -U warcon -d warcon -Fc > "$dump" 2>/dev/null; then
  log "dumped to $dump"
  ls -1t "$BACKUPS"/warcon-*-pre-update.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
else
  rm -f "$dump"
  log "pg_dump failed; not updating"
  exit 1
fi

compose up -d 2>&1 | tail -5

deadline=$((SECONDS + WAIT))
until curl -fsS --max-time 5 "$HEALTH" 2>/dev/null | grep -q '"ok":true'; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "unhealthy after ${WAIT}s"
    if [ -n "$before" ]; then
      log "rolling back to $before"
      docker tag "$before" "$IMAGE"
      compose up -d 2>&1 | tail -3
    fi
    exit 1
  fi
  sleep 3
done

log "updated and healthy"
