#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'Deployment refused: %s\n' "$1" >&2
  exit 1
}

is_full_sha() {
  [[ "$1" =~ ^[a-f0-9]{40}$ ]]
}

file_value_matches() {
  local file="$1" key="$2" expected="$3"
  awk -F= -v key="$key" -v expected="$expected" '
    /^[[:space:]]*#/ { next }
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == key) {
        count++
        value = substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      }
    }
    END { exit !(count == 1 && value == expected) }
  ' "$file"
}

file_value_is_nonempty() {
  local file="$1" key="$2"
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == key) {
        count++
        value = substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      }
    }
    END { exit !(count == 1 && length(value) > 0) }
  ' "$file"
}

file_value_is_empty() {
  local file="$1" key="$2"
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == key) {
        count++
        value = substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      }
    }
    END { exit !(count == 1 && length(value) == 0) }
  ' "$file"
}

file_value() {
  local file="$1" key="$2"
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == key) {
        count++
        value = substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      }
    }
    END { if (count == 1) print value }
  ' "$file"
}

ENVIRONMENT_KEYS=(
  BOT_NDI_IMAGE_TAG BOT_NDI_BUILD_CONTEXT BOT_NDI_COMMIT_SHA
  NODE_ENV PORT HOST_IP HOST_PORT BASE_URL APPROVED_CTA_HOSTS TIMEZONE TRUST_PROXY
  DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_ROOT_PASSWORD DB_POOL_SIZE
  SCHEDULER_ENABLED SCHEDULER_INTERVAL_SECONDS
  TEBAR_API_KEY TEBAR_PROFILE_ID TEBAR_ACCOUNT_ID TEBAR_WEBHOOK_SECRET
  OPENROUTER_API_KEY OPENROUTER_MODEL OPENROUTER_GENERATOR_TEMPERATURE OPENROUTER_GENERATOR_TOP_P
  TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
  LEARNING_CAPTURE_ENABLED LEARNING_ACTIVATION_ENABLED LEARNING_RETRIEVAL_ENABLED
  LEARNING_PROMPT_INTEGRATION_ENABLED LEARNING_SHADOW_ENABLED LEARNING_RETENTION_ENABLED
  LEARNING_RETENTION_DAYS
)

if [[ "${BOT_NDI_TEST_MODE:-}" == "1" ]]; then
  APP_DIR="${BOT_NDI_APP_DIR:?test mode requires BOT_NDI_APP_DIR}"
else
  APP_DIR="/opt/bot-ndi"
fi

WORKSPACE="${GITHUB_WORKSPACE:-}"
REPOSITORY="${GITHUB_REPOSITORY:-}"
COMMIT_SHA="${BOT_NDI_COMMIT_SHA:-${GITHUB_SHA:-}}"
ROLLBACK_SHA="${BOT_NDI_ROLLBACK_SHA:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}"

if [[ "${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" ||
      "${GITHUB_REF:-}" != "refs/heads/main" ||
      "$REPOSITORY" != "Nusa-Data-Indonesia/bot-ndi" ||
      -z "$WORKSPACE" ||
      "$COMMIT_SHA" != "${GITHUB_SHA:-}" ]]; then
  fail "manual main-branch deployment provenance is invalid; refusing deployment."
fi
if ! is_full_sha "$COMMIT_SHA"; then
  fail "deployment commit is not a full commit SHA."
fi
if [[ -n "$ROLLBACK_SHA" ]] && ! is_full_sha "$ROLLBACK_SHA"; then
  fail "rollback target must be a full commit SHA."
fi
if [[ ! "$RUN_ID" =~ ^[1-9][0-9]*$ || ! "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
  fail "GitHub deployment run identity is missing or invalid."
fi
RELEASE_ID="${COMMIT_SHA}-${RUN_ID}-${RUN_ATTEMPT}"

if [[ "$APP_DIR" != /* || "$APP_DIR" == *[[:space:]]* ]]; then
  fail "deployment directory must be an absolute path without whitespace."
fi

if [[ ! -d "$WORKSPACE" || ! -f "$WORKSPACE/Dockerfile" || ! -f "$WORKSPACE/compose.yaml" ]]; then
  fail "checked-out release workspace is incomplete."
fi

CHECKED_OUT_SHA="$(git -C "$WORKSPACE" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ "$CHECKED_OUT_SHA" != "$COMMIT_SHA" ]]; then
  fail "checked-out source does not match the dispatched commit."
fi
if [[ -n "$(git -C "$WORKSPACE" status --porcelain 2>/dev/null)" ]]; then
  fail "checked-out release workspace has unexpected modifications."
fi
if git -C "$WORKSPACE" ls-tree -r --name-only "$COMMIT_SHA" |
  awk -F/ '$NF ~ /^\.env/ && $NF != ".env.example" { found = 1 } END { exit !found }'; then
  fail "release source contains a tracked runtime environment file."
fi

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" || ! -r "$ENV_FILE" ]]; then
  fail "LXC-local runtime environment is missing or unreadable."
fi
ENV_MODE="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
if [[ "$ENV_MODE" != "600" ]]; then
  fail "LXC-local runtime environment must have mode 600."
fi

for key in DB_PASSWORD DB_ROOT_PASSWORD; do
  if ! file_value_is_nonempty "$ENV_FILE" "$key"; then
    fail "LXC-local database credential $key is missing."
  fi
done
for pair in \
  "NODE_ENV production" \
  "PORT 3000" \
  "HOST_PORT 3000" \
  "BASE_URL https://botndi.sequein.my.id" \
  "DB_HOST db" \
  "DB_PORT 3306" \
  "DB_NAME bot_ndi" \
  "DB_USER bot_ndi_app" \
  "DB_POOL_SIZE 5"; do
  read -r key expected <<< "$pair"
  if ! file_value_matches "$ENV_FILE" "$key" "$expected"; then
    fail "LXC-local runtime setting $key does not match the Bot NDI deployment."
  fi
done

if ! file_value_is_nonempty "$ENV_FILE" HOST_IP ||
   [[ "$(file_value "$ENV_FILE" HOST_IP)" == *[[:space:]]* ]]; then
  fail "HOST_IP must contain the verified Bot NDI LXC address."
fi
DEPLOY_HOST_IP="$(file_value "$ENV_FILE" HOST_IP)"
if ! ip -o -4 addr show 2>/dev/null | awk -v expected="$DEPLOY_HOST_IP" '
  {
    split($4, address, "/")
    if (address[1] == expected) found = 1
  }
  END { exit !found }
'; then
  fail "HOST_IP is not currently assigned to this LXC; refusing deployment."
fi

HOST_PORT_VALUE="$(file_value "$ENV_FILE" HOST_PORT)"
if [[ ! "$HOST_PORT_VALUE" =~ ^[1-9][0-9]{0,4}$ ]] || (( HOST_PORT_VALUE > 65535 )); then
  fail "HOST_PORT must be a TCP port between 1 and 65535."
fi

ACTIVE_LINK="$APP_DIR/active"
PREVIOUS_RELEASE_FILE="$APP_DIR/previous-release"
STATE_DIR="$APP_DIR/state"
VOLUME_MARKER="$STATE_DIR/database-volume"
VOLUME_NAME="bot-ndi_mysql_data"

if [[ -n "${DOCKER_HOST:-}" || -n "${DOCKER_CONTEXT:-}" ]]; then
  fail "remote Docker endpoint overrides are not allowed on the Bot NDI runner."
fi
for command_name in docker git tar curl awk grep stat readlink mktemp install mv head date ln rm cat sleep mkdir ip; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required deployment command $command_name is unavailable."
done
docker info >/dev/null 2>&1 || fail "local Docker Engine is unavailable."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is unavailable."
DOCKER_CONTEXT_NAME="$(docker context show 2>/dev/null || true)"
if [[ -z "$DOCKER_CONTEXT_NAME" ]]; then
  fail "Docker CLI has no active local context."
fi
DOCKER_ENDPOINT="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$DOCKER_CONTEXT_NAME" 2>/dev/null || true)"
if [[ "$DOCKER_ENDPOINT" != unix://* ]]; then
  fail "Docker context must point to the local Unix socket."
fi

INITIAL_BOOTSTRAP=true
ACTIVE_TARGET=""
ACTIVE_SHA=""
ACTIVE_RELEASE_ID=""
if [[ -L "$ACTIVE_LINK" ]]; then
  ACTIVE_TARGET="$(readlink "$ACTIVE_LINK")"
  ACTIVE_RELEASE_ID="${ACTIVE_TARGET#releases/}"
  if [[ ! "$ACTIVE_TARGET" =~ ^releases/[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$ || ! -f "$APP_DIR/$ACTIVE_TARGET/metadata.json" ]]; then
    fail "active release pointer is invalid."
  fi
  INITIAL_BOOTSTRAP=false
  ACTIVE_SHA="${ACTIVE_RELEASE_ID:0:40}"
  ACTIVE_RELEASE_DIR="$APP_DIR/$ACTIVE_TARGET"
  if ! grep -Fq "\"commit\":\"$ACTIVE_SHA\"" "$ACTIVE_RELEASE_DIR/metadata.json" ||
     ! grep -Fq "\"releaseId\":\"$ACTIVE_RELEASE_ID\"" "$ACTIVE_RELEASE_DIR/metadata.json" ||
     ! grep -Fq "\"image\":\"bot-ndi:$ACTIVE_RELEASE_ID\"" "$ACTIVE_RELEASE_DIR/metadata.json" ||
     [[ ! -f "$ACTIVE_RELEASE_DIR/compose.yaml" || ! -f "$ACTIVE_RELEASE_DIR/release.env" ]] ||
     ! file_value_matches "$ACTIVE_RELEASE_DIR/release.env" BOT_NDI_IMAGE_TAG "$ACTIVE_RELEASE_ID" ||
     ! file_value_matches "$ACTIVE_RELEASE_DIR/release.env" BOT_NDI_COMMIT_SHA "$ACTIVE_SHA"; then
    fail "active release metadata does not match its commit and release identity."
  fi
  ACTIVE_IMAGE_REVISION="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bot-ndi:$ACTIVE_RELEASE_ID" 2>/dev/null || true)"
  if [[ "$ACTIVE_IMAGE_REVISION" != "$ACTIVE_SHA" ]]; then
    fail "previous local image is unavailable or its revision cannot be verified; refusing deployment."
  fi
elif [[ -e "$ACTIVE_LINK" ]]; then
  fail "active release path exists but is not a symlink."
fi
PRE_DEPLOY_ACTIVE_TARGET="$ACTIVE_TARGET"

if [[ -n "$ROLLBACK_SHA" ]]; then
  if [[ "$INITIAL_BOOTSTRAP" == true ]]; then
    fail "manual rollback requires a different, active Bot NDI deployment."
  fi
  if [[ ! -f "$PREVIOUS_RELEASE_FILE" || -L "$PREVIOUS_RELEASE_FILE" ]]; then
    fail "manual rollback target must match the last successful previous-release SHA."
  fi
  ROLLBACK_RELEASE_ID="$(cat "$PREVIOUS_RELEASE_FILE")"
  if [[ ! "$ROLLBACK_RELEASE_ID" =~ ^[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$ ]]; then
    fail "manual rollback pointer does not identify a retained release."
  fi
  if [[ "$ROLLBACK_RELEASE_ID" == "$ACTIVE_RELEASE_ID" ]]; then
    fail "manual rollback target is already the active release."
  fi
  ROLLBACK_RELEASE_DIR="$APP_DIR/releases/$ROLLBACK_RELEASE_ID"
  if [[ ! -d "$ROLLBACK_RELEASE_DIR" || -L "$ROLLBACK_RELEASE_DIR" ||
        ! -f "$ROLLBACK_RELEASE_DIR/metadata.json" ||
        ! -f "$ROLLBACK_RELEASE_DIR/compose.yaml" ||
        ! -f "$ROLLBACK_RELEASE_DIR/release.env" ]] ||
     ! grep -Fq "\"commit\":\"$ROLLBACK_SHA\"" "$ROLLBACK_RELEASE_DIR/metadata.json" ||
     ! grep -Fq "\"releaseId\":\"$ROLLBACK_RELEASE_ID\"" "$ROLLBACK_RELEASE_DIR/metadata.json" ||
     ! grep -Fq "\"image\":\"bot-ndi:$ROLLBACK_RELEASE_ID\"" "$ROLLBACK_RELEASE_DIR/metadata.json" ||
     ! file_value_matches "$ROLLBACK_RELEASE_DIR/release.env" BOT_NDI_IMAGE_TAG "$ROLLBACK_RELEASE_ID" ||
     ! file_value_matches "$ROLLBACK_RELEASE_DIR/release.env" BOT_NDI_COMMIT_SHA "$ROLLBACK_SHA" ||
     [[ ! -f "$ROLLBACK_RELEASE_DIR/health-verified.json" || -L "$ROLLBACK_RELEASE_DIR/health-verified.json" ]] ||
     ! grep -Fq "\"commit\":\"$ROLLBACK_SHA\"" "$ROLLBACK_RELEASE_DIR/health-verified.json" ||
     ! grep -Fq "\"releaseId\":\"$ROLLBACK_RELEASE_ID\"" "$ROLLBACK_RELEASE_DIR/health-verified.json" ||
     ! grep -Fq "\"image\":\"bot-ndi:$ROLLBACK_RELEASE_ID\"" "$ROLLBACK_RELEASE_DIR/health-verified.json" ||
     ! grep -Fq '"health":"passed"' "$ROLLBACK_RELEASE_DIR/health-verified.json"; then
    fail "rollback target SHA must match the last successful health-verified retained release."
  fi
  ROLLBACK_IMAGE_REVISION="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bot-ndi:$ROLLBACK_RELEASE_ID" 2>/dev/null || true)"
  if [[ "$ROLLBACK_IMAGE_REVISION" != "$ROLLBACK_SHA" ]]; then
    fail "rollback target local image is unavailable or its revision cannot be verified."
  fi
fi

if [[ "$INITIAL_BOOTSTRAP" == true ]]; then
  for key in \
    SCHEDULER_ENABLED \
    LEARNING_CAPTURE_ENABLED \
    LEARNING_ACTIVATION_ENABLED \
    LEARNING_RETRIEVAL_ENABLED \
    LEARNING_PROMPT_INTEGRATION_ENABLED \
    LEARNING_SHADOW_ENABLED \
    LEARNING_RETENTION_ENABLED; do
    if ! file_value_matches "$ENV_FILE" "$key" false; then
      fail "initial bootstrap requires $key=false and scheduler/Learning execution disabled."
    fi
  done
  for key in TEBAR_API_KEY TEBAR_PROFILE_ID TEBAR_ACCOUNT_ID TEBAR_WEBHOOK_SECRET OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    if ! file_value_is_empty "$ENV_FILE" "$key"; then
      fail "initial bootstrap requires new external integration credentials to remain unset."
    fi
  done
fi

if [[ -f "$VOLUME_MARKER" ]]; then
  if ! grep -Fxq "volume=$VOLUME_NAME" "$VOLUME_MARKER" ||
     ! grep -Eq '^state=(pending|ready)$' "$VOLUME_MARKER"; then
    fail "database volume state marker is invalid."
  fi
  VOLUME_STATE="$(awk -F= '$1 == "state" { print $2 }' "$VOLUME_MARKER")"
  if [[ "$VOLUME_STATE" == "ready" ]]; then
    docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 ||
      fail "persistent MySQL volume is missing; refusing to create a replacement database."
  fi
elif [[ "$INITIAL_BOOTSTRAP" == false ]]; then
  fail "active release has no database volume marker; refusing to continue."
else
  docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 &&
    fail "an existing MySQL volume has no Bot NDI bootstrap marker; refusing to reuse it."
fi

mkdir -p "$APP_DIR/source" "$APP_DIR/releases" "$APP_DIR/backups" "$STATE_DIR"
if [[ ! -f "$VOLUME_MARKER" ]]; then
  printf 'volume=%s\nstate=pending\n' "$VOLUME_NAME" > "$VOLUME_MARKER"
fi

for key in "${ENVIRONMENT_KEYS[@]}"; do
  unset "$key" || true
done

SOURCE_DIR="$APP_DIR/source/$COMMIT_SHA"
SOURCE_MARKER="$SOURCE_DIR/.bot-ndi-commit"
SOURCE_STAGING=""
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"
RELEASE_STAGING=""
CANDIDATE_APP_ATTEMPTED=false
PREVIOUS_APP_STOPPED=false
DEPLOYMENT_PROMOTED=false
VERIFICATION_MARKER_CREATED=false
VERIFICATION_MARKER_TMP=""
VERIFICATION_MARKER=""
PREVIOUS_RELEASE_TMP=""
PREVIOUS_RELEASE_RESTORE_TMP=""
PREVIOUS_RELEASE_UPDATE_STARTED=false
PREVIOUS_RELEASE_EXISTED=false
PREVIOUS_RELEASE_VALUE=""
PREVIOUS_SHA=""
PREVIOUS_RELEASE_ID=""
COMPOSE_ARGS=()

compose_for_release() {
  local release_dir="$1"
  COMPOSE_ARGS=(
    compose
    --project-directory "$APP_DIR"
    --env-file "$ENV_FILE"
    --env-file "$release_dir/release.env"
    --project-name bot-ndi
    --file "$release_dir/compose.yaml"
  )
}

compose() {
  docker "${COMPOSE_ARGS[@]}" "$@"
}

cleanup_staging() {
  if [[ -n "$SOURCE_STAGING" && -d "$SOURCE_STAGING" && "$SOURCE_STAGING" == "$APP_DIR/source/.${COMMIT_SHA}."* ]]; then
    rm -rf -- "$SOURCE_STAGING"
  fi
  if [[ -n "$RELEASE_STAGING" && -d "$RELEASE_STAGING" && "$RELEASE_STAGING" == "$APP_DIR/releases/.${RELEASE_ID}."* ]]; then
    rm -rf -- "$RELEASE_STAGING"
  fi
}

rollback_to_previous_release() {
  local release_dir="$APP_DIR/$PRE_DEPLOY_ACTIVE_TARGET"
  if [[ -z "$PRE_DEPLOY_ACTIVE_TARGET" || ! -d "$release_dir" ]]; then
    printf 'Deployment recovery: no verified previous app release is available.\n' >&2
    return 1
  fi

  compose_for_release "$release_dir"
  if compose up -d --no-deps --wait --wait-timeout 120 app >/dev/null 2>&1 &&
     curl --fail --silent --show-error --max-time 10 \
       "http://$DEPLOY_HOST_IP:$HOST_PORT_VALUE/health/ready" >/dev/null 2>&1; then
    printf 'Automatic rollback to local release %s succeeded.\n' "$ACTIVE_SHA" >&2
    return 0
  fi
  printf 'Deployment recovery failed; the previous app release did not become healthy. Inspect the LXC before retrying.\n' >&2
  return 1
}

cleanup_deployment() {
  local exit_status=$?
  trap - EXIT
  if [[ "$exit_status" -ne 0 && "$DEPLOYMENT_PROMOTED" != true ]]; then
    if [[ "$CANDIDATE_APP_ATTEMPTED" == true ]]; then
      compose stop app >/dev/null 2>&1 || true
    fi
    if [[ "$PRE_DEPLOY_ACTIVE_TARGET" != "" ]]; then
      rollback_to_previous_release || true
    elif [[ "$CANDIDATE_APP_ATTEMPTED" == true ]]; then
      printf 'Deployment recovery: no previous app release exists; the failed first-deploy candidate was stopped.\n' >&2
    fi

    if [[ "$PREVIOUS_RELEASE_UPDATE_STARTED" == true ]]; then
      if [[ "$PREVIOUS_RELEASE_EXISTED" == true ]]; then
        PREVIOUS_RELEASE_RESTORE_TMP="$(mktemp "$APP_DIR/.previous-release-restore.${COMMIT_SHA}.XXXXXX" 2>/dev/null || true)"
        if [[ -n "$PREVIOUS_RELEASE_RESTORE_TMP" ]] &&
           printf '%s\n' "$PREVIOUS_RELEASE_VALUE" > "$PREVIOUS_RELEASE_RESTORE_TMP" &&
           mv -f "$PREVIOUS_RELEASE_RESTORE_TMP" "$PREVIOUS_RELEASE_FILE"; then
          PREVIOUS_RELEASE_RESTORE_TMP=""
        else
          printf 'Deployment warning: failed to restore the previous-release pointer; inspect it before recovery.\n' >&2
        fi
      elif [[ -f "$PREVIOUS_RELEASE_FILE" && ! -L "$PREVIOUS_RELEASE_FILE" ]] &&
           [[ "$(cat "$PREVIOUS_RELEASE_FILE" 2>/dev/null || true)" == "$PREVIOUS_RELEASE_ID" ]]; then
        rm -f -- "$PREVIOUS_RELEASE_FILE" ||
          printf 'Deployment warning: failed to remove the uncommitted previous-release pointer.\n' >&2
      fi
    fi
    if [[ "$VERIFICATION_MARKER_CREATED" == true && -n "$VERIFICATION_MARKER" ]]; then
      rm -f -- "$VERIFICATION_MARKER" ||
        printf 'Deployment warning: failed to remove the unpromoted health verification marker.\n' >&2
    fi
  fi
  if [[ -n "$PREVIOUS_RELEASE_TMP" && -f "$PREVIOUS_RELEASE_TMP" ]]; then
    rm -f -- "$PREVIOUS_RELEASE_TMP" || true
  fi
  if [[ -n "$PREVIOUS_RELEASE_RESTORE_TMP" && -f "$PREVIOUS_RELEASE_RESTORE_TMP" ]]; then
    rm -f -- "$PREVIOUS_RELEASE_RESTORE_TMP" || true
  fi
  if [[ -n "$VERIFICATION_MARKER_TMP" && -f "$VERIFICATION_MARKER_TMP" ]]; then
    rm -f -- "$VERIFICATION_MARKER_TMP" || true
  fi
  cleanup_staging
  return "$exit_status"
}
trap cleanup_deployment EXIT

DEPLOYMENT_SHA="$COMMIT_SHA"
DEPLOYMENT_RELEASE_ID="$RELEASE_ID"
if [[ -n "$ROLLBACK_SHA" ]]; then
  SOURCE_DIR=""
  DEPLOYMENT_SHA="$ROLLBACK_SHA"
  DEPLOYMENT_RELEASE_ID="$ROLLBACK_RELEASE_ID"
  RELEASE_DIR="$ROLLBACK_RELEASE_DIR"
  compose_for_release "$RELEASE_DIR"
  compose config --quiet || fail "rollback Docker Compose configuration is invalid."
else
  SOURCE_DIR="$APP_DIR/source/$COMMIT_SHA"
  SOURCE_MARKER="$SOURCE_DIR/.bot-ndi-commit"
  if [[ -d "$SOURCE_DIR" ]]; then
    [[ -f "$SOURCE_MARKER" ]] && [[ "$(cat "$SOURCE_MARKER")" == "$COMMIT_SHA" ]] ||
      fail "existing source workspace does not match the release commit."
  else
    SOURCE_STAGING="$(mktemp -d "$APP_DIR/source/.${COMMIT_SHA}.XXXXXX")"
    git -C "$WORKSPACE" archive --format=tar "$COMMIT_SHA" | tar -xf - -C "$SOURCE_STAGING"
    printf '%s\n' "$COMMIT_SHA" > "$SOURCE_STAGING/.bot-ndi-commit"
    mv "$SOURCE_STAGING" "$SOURCE_DIR"
    SOURCE_STAGING=""
  fi

  if [[ -e "$RELEASE_DIR" || -L "$RELEASE_DIR" ]]; then
    fail "immutable release identity already exists; start a new workflow dispatch attempt."
  fi
  RELEASE_STAGING="$(mktemp -d "$APP_DIR/releases/.${RELEASE_ID}.XXXXXX")"
  install -m 0644 "$WORKSPACE/compose.yaml" "$RELEASE_STAGING/compose.yaml"
  {
    printf 'BOT_NDI_IMAGE_TAG=%s\n' "$RELEASE_ID"
    printf 'BOT_NDI_BUILD_CONTEXT=%s\n' "$SOURCE_DIR"
    printf 'BOT_NDI_COMMIT_SHA=%s\n' "$COMMIT_SHA"
  } > "$RELEASE_STAGING/release.env"
  RELEASED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"commit":"%s","releaseId":"%s","image":"bot-ndi:%s","createdAt":"%s"}\n' \
    "$COMMIT_SHA" "$RELEASE_ID" "$RELEASE_ID" "$RELEASED_AT" > "$RELEASE_STAGING/metadata.json"
  mv "$RELEASE_STAGING" "$RELEASE_DIR"
  RELEASE_STAGING=""

  compose_for_release "$RELEASE_DIR"
  compose config --quiet || fail "Docker Compose configuration is invalid."
  docker build \
    --target runtime \
    --build-arg "VCS_REF=$COMMIT_SHA" \
    --tag "bot-ndi:$RELEASE_ID" \
    "$SOURCE_DIR" || fail "local Docker image build failed."

  BUILT_IMAGE_REVISION="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bot-ndi:$RELEASE_ID" 2>/dev/null || true)"
  if [[ "$BUILT_IMAGE_REVISION" != "$COMMIT_SHA" ]]; then
    fail "locally built image revision does not match the dispatched commit."
  fi
fi

if [[ "$INITIAL_BOOTSTRAP" == false ]]; then
  if [[ -n "$(compose ps -q app)" ]]; then
    compose stop app || fail "the previous app service could not be stopped safely."
    PREVIOUS_APP_STOPPED=true
  fi
fi

compose up -d --wait --wait-timeout 120 db || fail "MySQL did not become healthy."
if [[ -z "$ROLLBACK_SHA" ]]; then
  compose run --rm --no-deps app npm run migrate || fail "application migrations failed."
fi
CANDIDATE_APP_ATTEMPTED=true
compose up -d --no-deps --wait --wait-timeout 120 app || fail "application container did not become healthy."

HEALTH_RETRIES="${BOT_NDI_HEALTH_RETRIES:-15}"
HEALTH_RETRY_DELAY="${BOT_NDI_HEALTH_RETRY_DELAY:-2}"
if [[ ! "$HEALTH_RETRIES" =~ ^[1-9][0-9]*$ || ! "$HEALTH_RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  fail "health-check retry configuration is invalid."
fi

check_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    if curl --fail --silent --show-error --max-time 10 \
      "http://$DEPLOY_HOST_IP:$HOST_PORT_VALUE/health/ready" >/dev/null 2>&1; then
      printf 'LXC application health check passed.\n'
      return 0
    fi
    if (( attempt < HEALTH_RETRIES )); then sleep "$HEALTH_RETRY_DELAY"; fi
  done
  fail "application health check failed; the previous verified release will be restored if available."
}
check_health

APP_CONTAINER_ID="$(compose ps -q app | head -n 1)"
if [[ -z "$APP_CONTAINER_ID" ]]; then
  fail "healthy app service has no running container."
fi
RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CONTAINER_ID" 2>/dev/null || true)"
RUNNING_REVISION="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$APP_CONTAINER_ID" 2>/dev/null || true)"
if [[ "$RUNNING_IMAGE" != "bot-ndi:$DEPLOYMENT_RELEASE_ID" || "$RUNNING_REVISION" != "$DEPLOYMENT_SHA" ]]; then
  fail "running app image does not match the selected deployment SHA."
fi

RUNTIME_ENV="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER_ID" 2>/dev/null || true)"
for key in \
  SCHEDULER_ENABLED \
  LEARNING_CAPTURE_ENABLED \
  LEARNING_ACTIVATION_ENABLED \
  LEARNING_RETRIEVAL_ENABLED \
  LEARNING_PROMPT_INTEGRATION_ENABLED \
  LEARNING_SHADOW_ENABLED \
  LEARNING_RETENTION_ENABLED; do
  value="$(printf '%s\n' "$RUNTIME_ENV" | awk -F= -v key="$key" '$1 == key { count++; value = $2 } END { if (count == 1) print value }')"
  if [[ "$value" != "true" && "$value" != "false" ]]; then
    fail "effective runtime flag $key is missing or invalid."
  fi
  if [[ "$INITIAL_BOOTSTRAP" == true && "$value" != "false" ]]; then
    fail "effective initial runtime flag $key must be false."
  fi
done

if [[ -z "$ROLLBACK_SHA" ]]; then
  VERIFICATION_MARKER="$RELEASE_DIR/health-verified.json"
  if [[ -e "$VERIFICATION_MARKER" || -L "$VERIFICATION_MARKER" ]]; then
    if [[ ! -f "$VERIFICATION_MARKER" || -L "$VERIFICATION_MARKER" ]] ||
       ! grep -Fq "\"commit\":\"$COMMIT_SHA\"" "$VERIFICATION_MARKER" ||
       ! grep -Fq "\"releaseId\":\"$RELEASE_ID\"" "$VERIFICATION_MARKER" ||
       ! grep -Fq "\"image\":\"bot-ndi:$RELEASE_ID\"" "$VERIFICATION_MARKER" ||
       ! grep -Fq '"health":"passed"' "$VERIFICATION_MARKER"; then
      fail "existing release health verification marker does not match this release identity."
    fi
  else
    VERIFICATION_MARKER_TMP="$(mktemp "$RELEASE_DIR/.health-verified.${RELEASE_ID}.XXXXXX")"
    printf '{"commit":"%s","releaseId":"%s","image":"bot-ndi:%s","health":"passed","verifiedAt":"%s"}\n' \
      "$COMMIT_SHA" "$RELEASE_ID" "$RELEASE_ID" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$VERIFICATION_MARKER_TMP"
    mv "$VERIFICATION_MARKER_TMP" "$VERIFICATION_MARKER"
    VERIFICATION_MARKER_TMP=""
    VERIFICATION_MARKER_CREATED=true
  fi
fi

if [[ -f "$VOLUME_MARKER" ]]; then
  printf 'volume=%s\nstate=ready\n' "$VOLUME_NAME" > "$VOLUME_MARKER.tmp"
  mv -f "$VOLUME_MARKER.tmp" "$VOLUME_MARKER"
fi

if [[ -L "$ACTIVE_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink "$ACTIVE_LINK")"
  PREVIOUS_RELEASE_ID="${PREVIOUS_TARGET#releases/}"
  PREVIOUS_SHA="${PREVIOUS_RELEASE_ID:0:40}"
  if [[ -e "$PREVIOUS_RELEASE_FILE" || -L "$PREVIOUS_RELEASE_FILE" ]]; then
    if [[ ! -f "$PREVIOUS_RELEASE_FILE" || -L "$PREVIOUS_RELEASE_FILE" ]]; then
      fail "previous-release pointer exists but is not a regular file."
    fi
    PREVIOUS_RELEASE_EXISTED=true
    PREVIOUS_RELEASE_VALUE="$(cat "$PREVIOUS_RELEASE_FILE")"
    if [[ ! "$PREVIOUS_RELEASE_VALUE" =~ ^[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$ ]]; then
      fail "previous-release pointer contains an invalid release identity."
    fi
  fi
  PREVIOUS_RELEASE_TMP="$(mktemp "$APP_DIR/.previous-release.${COMMIT_SHA}.XXXXXX")"
  printf '%s\n' "$PREVIOUS_RELEASE_ID" > "$PREVIOUS_RELEASE_TMP"
  PREVIOUS_RELEASE_UPDATE_STARTED=true
  mv -f "$PREVIOUS_RELEASE_TMP" "$PREVIOUS_RELEASE_FILE"
  PREVIOUS_RELEASE_TMP=""
fi

NEXT_ACTIVE_LINK="$APP_DIR/.active-$DEPLOYMENT_RELEASE_ID-$$"
ln -s "releases/$DEPLOYMENT_RELEASE_ID" "$NEXT_ACTIVE_LINK"
if mv --version >/dev/null 2>&1; then
  mv -fT "$NEXT_ACTIVE_LINK" "$ACTIVE_LINK"
else
  mv -fh "$NEXT_ACTIVE_LINK" "$ACTIVE_LINK"
fi
DEPLOYMENT_PROMOTED=true

if [[ -n "$ROLLBACK_SHA" ]]; then
  printf 'Manual rollback to retained release %s succeeded.\n' "$ROLLBACK_SHA"
else
  printf 'Deployment succeeded for commit %s.\n' "$COMMIT_SHA"
  printf 'Local image bot-ndi:%s (commit %s) is retained for rollback.\n' "$RELEASE_ID" "$COMMIT_SHA"
fi
printf 'Scheduler and Learning flags were verified in the running app environment.\n'
