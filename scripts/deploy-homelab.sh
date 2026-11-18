#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'Deployment refused: %s\n' "$1" >&2
  exit 1
}

set_deployment_result() {
  local result="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'result=%s\n' "$result" >> "$GITHUB_OUTPUT"
  fi
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

file_value_is_defined() {
  local file="$1" key="$2"
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == key && index($0, "=") > 0) {
        count++
      }
    }
    END { exit !(count == 1) }
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
  SCHEDULER_ENABLED SCHEDULER_INTERVAL_SECONDS EXTERNAL_INTEGRATIONS_ENABLED
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
DEPLOYMENT_MODE="${BOT_NDI_DEPLOYMENT_MODE:-}"
if [[ "$DEPLOYMENT_MODE" == manual ]]; then
  COMMIT_SHA="${BOT_NDI_COMMIT_SHA:-${GITHUB_SHA:-}}"
else
  COMMIT_SHA="${BOT_NDI_COMMIT_SHA:-}"
fi
ROLLBACK_SHA="${BOT_NDI_ROLLBACK_SHA:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}"
CI_RUN_ID="${BOT_NDI_CI_RUN_ID:-}"
CI_RUN_ATTEMPT="${BOT_NDI_CI_RUN_ATTEMPT:-}"
CI_WORKFLOW_ID="${BOT_NDI_CI_WORKFLOW_ID:-}"

if [[ -z "$WORKSPACE" || "$REPOSITORY" != "Nusa-Data-Indonesia/bot-ndi" ||
      "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
  fail "deployment repository or main-branch provenance is invalid; refusing deployment."
fi
case "$DEPLOYMENT_MODE" in
  manual)
    if [[ "${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" || "$COMMIT_SHA" != "${GITHUB_SHA:-}" ||
          -z "${RELEASE_GITHUB_TOKEN:-}" ]]; then
      fail "manual main-branch deployment provenance is invalid; refusing deployment."
    fi
    ;;
  automatic)
    if [[ "${GITHUB_EVENT_NAME:-}" != "workflow_run" || -n "$ROLLBACK_SHA" ||
          -z "${RELEASE_GITHUB_TOKEN:-}" ]]; then
      fail "automatic deployment provenance or rollback input is invalid; refusing deployment."
    fi
    ;;
  *)
    fail "deployment mode is missing or invalid; refusing deployment."
    ;;
esac
if [[ ! "$CI_RUN_ID" =~ ^[1-9][0-9]*$ || ! "$CI_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ||
      ! "$CI_WORKFLOW_ID" =~ ^[1-9][0-9]*$ ]]; then
  fail "verified CI run identity is missing or invalid."
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
HEALTH_RETRIES="${BOT_NDI_HEALTH_RETRIES:-15}"
HEALTH_RETRY_DELAY="${BOT_NDI_HEALTH_RETRY_DELAY:-2}"
if [[ ! "$HEALTH_RETRIES" =~ ^[1-9][0-9]*$ || ! "$HEALTH_RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  fail "health-check retry configuration is invalid."
fi

ACTIVE_LINK="$APP_DIR/active"
PREVIOUS_RELEASE_FILE="$APP_DIR/previous-release"
STATE_DIR="$APP_DIR/state"
VOLUME_MARKER="$STATE_DIR/database-volume"
VOLUME_NAME="bot-ndi_mysql_data"
SCHEMA_BASELINE_FILE="$STATE_DIR/database-schema-baseline"
SCHEMA_TRACKING_FILE="$STATE_DIR/database-schema-tracking"
MIGRATION_IN_PROGRESS_FILE="$STATE_DIR/database-migration-in-progress"
AUTO_DEPLOYMENT_HOLD_FILE="$STATE_DIR/automatic-deployment-hold"
SCHEMA_BASELINE_SHA=""
SCHEMA_TRACKING_ENABLED=false
MIGRATION_IN_PROGRESS=false
AUTO_DEPLOYMENT_HOLD_SHA=""
AUTO_DEPLOYMENT_HOLD_EXISTED=false
AUTO_DEPLOYMENT_HOLD_VALUE=""
PREVIOUS_RELEASE_EXISTED=false
PREVIOUS_RELEASE_VALUE=""
PREVIOUS_RELEASE_SHA=""

if [[ -n "${DOCKER_HOST:-}" || -n "${DOCKER_CONTEXT:-}" ]]; then
  fail "remote Docker endpoint overrides are not allowed on the Bot NDI runner."
fi
for command_name in docker git tar curl awk grep stat readlink mktemp install mv head date ln rm cat sleep mkdir ip node; do
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

check_latest_main_head() {
  if ! GITHUB_REPOSITORY="$REPOSITORY" COMMIT_SHA="$COMMIT_SHA" RELEASE_GITHUB_TOKEN="$RELEASE_GITHUB_TOKEN" \
       node "$WORKSPACE/scripts/check-release-head.js" >/dev/null; then
    fail "release is no longer the current main head; refusing to continue."
  fi
}

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

if [[ -e "$PREVIOUS_RELEASE_FILE" || -L "$PREVIOUS_RELEASE_FILE" ]]; then
  if [[ ! -f "$PREVIOUS_RELEASE_FILE" || -L "$PREVIOUS_RELEASE_FILE" ]]; then
    fail "previous-release pointer is not a regular file; refusing before image build or migration."
  fi
  PREVIOUS_RELEASE_VALUE="$(cat "$PREVIOUS_RELEASE_FILE")"
  if [[ ! "$PREVIOUS_RELEASE_VALUE" =~ ^[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$ ]]; then
    fail "previous-release pointer contains an invalid release identity; refusing before image build or migration."
  fi
  PREVIOUS_RELEASE_SHA="${PREVIOUS_RELEASE_VALUE:0:40}"
  PREVIOUS_RELEASE_DIR="$APP_DIR/releases/$PREVIOUS_RELEASE_VALUE"
  if [[ ! -d "$PREVIOUS_RELEASE_DIR" || -L "$PREVIOUS_RELEASE_DIR" ||
        ! -f "$PREVIOUS_RELEASE_DIR/metadata.json" ||
        ! -f "$PREVIOUS_RELEASE_DIR/compose.yaml" ||
        ! -f "$PREVIOUS_RELEASE_DIR/release.env" ||
        ! -f "$PREVIOUS_RELEASE_DIR/health-verified.json" ||
        -L "$PREVIOUS_RELEASE_DIR/health-verified.json" ]] ||
     ! grep -Fq "\"commit\":\"$PREVIOUS_RELEASE_SHA\"" "$PREVIOUS_RELEASE_DIR/metadata.json" ||
     ! grep -Fq "\"releaseId\":\"$PREVIOUS_RELEASE_VALUE\"" "$PREVIOUS_RELEASE_DIR/metadata.json" ||
     ! grep -Fq "\"image\":\"bot-ndi:$PREVIOUS_RELEASE_VALUE\"" "$PREVIOUS_RELEASE_DIR/metadata.json" ||
     ! grep -Fq "\"commit\":\"$PREVIOUS_RELEASE_SHA\"" "$PREVIOUS_RELEASE_DIR/health-verified.json" ||
     ! grep -Fq "\"releaseId\":\"$PREVIOUS_RELEASE_VALUE\"" "$PREVIOUS_RELEASE_DIR/health-verified.json" ||
     ! grep -Fq "\"image\":\"bot-ndi:$PREVIOUS_RELEASE_VALUE\"" "$PREVIOUS_RELEASE_DIR/health-verified.json" ||
     ! grep -Fq '"health":"passed"' "$PREVIOUS_RELEASE_DIR/health-verified.json" ||
     ! file_value_matches "$PREVIOUS_RELEASE_DIR/release.env" BOT_NDI_IMAGE_TAG "$PREVIOUS_RELEASE_VALUE" ||
     ! file_value_matches "$PREVIOUS_RELEASE_DIR/release.env" BOT_NDI_COMMIT_SHA "$PREVIOUS_RELEASE_SHA"; then
    fail "previous-release pointer target is not a health-verified retained release; refusing before image build or migration."
  fi
  PREVIOUS_RELEASE_IMAGE_REVISION="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bot-ndi:$PREVIOUS_RELEASE_VALUE" 2>/dev/null || true)"
  if [[ "$PREVIOUS_RELEASE_IMAGE_REVISION" != "$PREVIOUS_RELEASE_SHA" ]]; then
    fail "previous-release pointer image cannot be verified; refusing before image build or migration."
  fi
  PREVIOUS_RELEASE_EXISTED=true
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
      fail "initial bootstrap requires $key=false and scheduler, external integrations, and Learning execution disabled."
    fi
  done
  if grep -Eq '^[[:space:]]*export[[:space:]]+EXTERNAL_INTEGRATIONS_ENABLED([[:space:]]*=|[[:space:]]*$)' "$ENV_FILE" ||
     { grep -Eq '^[[:space:]]*EXTERNAL_INTEGRATIONS_ENABLED([[:space:]]*=|[[:space:]]*$)' "$ENV_FILE" &&
       ! file_value_matches "$ENV_FILE" EXTERNAL_INTEGRATIONS_ENABLED false; }; then
    fail "initial bootstrap requires EXTERNAL_INTEGRATIONS_ENABLED=false when configured."
  fi
  for key in TEBAR_API_KEY TEBAR_PROFILE_ID TEBAR_ACCOUNT_ID TEBAR_WEBHOOK_SECRET OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    if ! file_value_is_defined "$ENV_FILE" "$key"; then
      fail "initial bootstrap requires one runtime environment entry for $key."
    fi
  done
fi

if [[ -f "$VOLUME_MARKER" ]]; then
  if ! grep -Fxq "volume=$VOLUME_NAME" "$VOLUME_MARKER" ||
     ! grep -Eq '^state=(pending|ready)$' "$VOLUME_MARKER"; then
    fail "database volume state marker is invalid."
  fi
  VOLUME_STATE="$(awk -F= '$1 == "state" { print $2 }' "$VOLUME_MARKER")"
  if [[ "$INITIAL_BOOTSTRAP" == false && "$VOLUME_STATE" != ready ]]; then
    fail "an active release requires a ready persistent MySQL volume marker."
  fi
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

if [[ -e "$SCHEMA_TRACKING_FILE" || -L "$SCHEMA_TRACKING_FILE" ]]; then
  if [[ ! -f "$SCHEMA_TRACKING_FILE" || -L "$SCHEMA_TRACKING_FILE" ]] ||
     [[ "$(cat "$SCHEMA_TRACKING_FILE" 2>/dev/null || true)" != "version=1" ]]; then
    fail "database schema tracking marker is invalid; operator reconciliation is required."
  fi
  SCHEMA_TRACKING_ENABLED=true
fi

if [[ -e "$SCHEMA_BASELINE_FILE" || -L "$SCHEMA_BASELINE_FILE" ]]; then
  if [[ ! -f "$SCHEMA_BASELINE_FILE" || -L "$SCHEMA_BASELINE_FILE" ]]; then
    fail "database schema baseline is not a regular file; operator reconciliation is required."
  fi
  SCHEMA_BASELINE_SHA="$(cat "$SCHEMA_BASELINE_FILE")"
  if ! is_full_sha "$SCHEMA_BASELINE_SHA"; then
    fail "database schema baseline cannot be verified from release history; operator reconciliation is required."
  fi
  if [[ "$DEPLOYMENT_MODE" == automatic ]] &&
     ! git -C "$WORKSPACE" cat-file -e "$SCHEMA_BASELINE_SHA^{commit}" 2>/dev/null; then
    fail "database schema baseline is missing from release history; operator reconciliation is required."
  fi
elif [[ "$SCHEMA_TRACKING_ENABLED" == true ]]; then
  fail "managed database schema baseline is missing; operator reconciliation is required."
fi

if [[ -e "$AUTO_DEPLOYMENT_HOLD_FILE" || -L "$AUTO_DEPLOYMENT_HOLD_FILE" ]]; then
  if [[ ! -f "$AUTO_DEPLOYMENT_HOLD_FILE" || -L "$AUTO_DEPLOYMENT_HOLD_FILE" ]]; then
    fail "automatic deployment hold is invalid; operator reconciliation is required."
  fi
  AUTO_DEPLOYMENT_HOLD_SHA="$(cat "$AUTO_DEPLOYMENT_HOLD_FILE")"
  if ! is_full_sha "$AUTO_DEPLOYMENT_HOLD_SHA"; then
    fail "automatic deployment hold cannot be verified; operator reconciliation is required."
  fi
  AUTO_DEPLOYMENT_HOLD_EXISTED=true
  AUTO_DEPLOYMENT_HOLD_VALUE="$AUTO_DEPLOYMENT_HOLD_SHA"
fi

if [[ -e "$MIGRATION_IN_PROGRESS_FILE" || -L "$MIGRATION_IN_PROGRESS_FILE" ]]; then
  if [[ ! -f "$MIGRATION_IN_PROGRESS_FILE" || -L "$MIGRATION_IN_PROGRESS_FILE" ]] ||
     ! is_full_sha "$(cat "$MIGRATION_IN_PROGRESS_FILE" 2>/dev/null || true)"; then
    fail "database migration state is invalid; operator reconciliation is required."
  fi
  MIGRATION_IN_PROGRESS=true
fi

if [[ "$DEPLOYMENT_MODE" == automatic ]]; then
  if [[ "$INITIAL_BOOTSTRAP" != false ]]; then
    fail "automatic deployment requires an existing verified release."
  fi
  ACTIVE_HEALTH_MARKER="$APP_DIR/$ACTIVE_TARGET/health-verified.json"
  if [[ ! -f "$ACTIVE_HEALTH_MARKER" || -L "$ACTIVE_HEALTH_MARKER" ]] ||
     ! grep -Fq "\"commit\":\"$ACTIVE_SHA\"" "$ACTIVE_HEALTH_MARKER" ||
     ! grep -Fq "\"releaseId\":\"$ACTIVE_RELEASE_ID\"" "$ACTIVE_HEALTH_MARKER" ||
     ! grep -Fq "\"image\":\"bot-ndi:$ACTIVE_RELEASE_ID\"" "$ACTIVE_HEALTH_MARKER" ||
     ! grep -Fq '"health":"passed"' "$ACTIVE_HEALTH_MARKER"; then
    fail "automatic deployment requires a health-verified active release baseline."
  fi
  if [[ "$MIGRATION_IN_PROGRESS" == true ]]; then
    fail "automatic deployment is blocked by an unverified database migration; operator reconciliation is required."
  fi
  if [[ "$AUTO_DEPLOYMENT_HOLD_SHA" == "$COMMIT_SHA" ]]; then
    fail "automatic deployment is blocked by an operator-requested rollback for this main commit."
  fi
  if [[ -z "$SCHEMA_BASELINE_SHA" ]]; then
    SCHEMA_BASELINE_SHA="$ACTIVE_SHA"
  fi
  if ! git -C "$WORKSPACE" cat-file -e "$SCHEMA_BASELINE_SHA^{commit}" 2>/dev/null; then
    fail "automatic migration compatibility cannot be verified from the schema baseline SHA."
  fi
  if git -C "$WORKSPACE" diff --quiet "$SCHEMA_BASELINE_SHA" "$COMMIT_SHA" -- \
    migrations/ src/migrate.js src/cli.js src/db.js src/config.js package.json package-lock.json \
    Dockerfile compose.yaml .dockerignore Dockerfile.dockerignore .gitattributes; then
    :
  else
    DIFF_STATUS=$?
    if [[ "$DIFF_STATUS" -eq 1 ]]; then
      fail "automatic deployment is blocked because the database migration or startup execution surface changed; use the reviewed manual deployment procedure."
    fi
    fail "automatic migration compatibility comparison failed; refusing deployment."
  fi
  if [[ "$ACTIVE_SHA" != "$COMMIT_SHA" && "$PREVIOUS_RELEASE_SHA" == "$COMMIT_SHA" ]]; then
    fail "automatic deployment is blocked after an operator rollback of this main commit; use manual redeployment or advance main."
  fi
fi
check_latest_main_head

if [[ "$DEPLOYMENT_MODE" == automatic && "$ACTIVE_SHA" == "$COMMIT_SHA" ]]; then
  printf 'Automatic deployment skipped; verified commit %s is already active.\n' "$COMMIT_SHA"
  set_deployment_result "already_active"
  exit 0
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
PREVIOUS_APP_STOP_ATTEMPTED=false
DEPLOYMENT_PROMOTED=false
VERIFICATION_MARKER_CREATED=false
VERIFICATION_MARKER_TMP=""
VERIFICATION_MARKER=""
MIGRATION_MARKER_TMP=""
SCHEMA_BASELINE_TMP=""
SCHEMA_TRACKING_TMP=""
AUTO_HOLD_TMP=""
AUTO_HOLD_RESTORE_TMP=""
AUTO_HOLD_UPDATE_STARTED=false
PREVIOUS_RELEASE_TMP=""
PREVIOUS_RELEASE_RESTORE_TMP=""
PREVIOUS_RELEASE_UPDATE_STARTED=false
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
    if [[ "$PRE_DEPLOY_ACTIVE_TARGET" != "" &&
          ( "$CANDIDATE_APP_ATTEMPTED" == true || "$PREVIOUS_APP_STOP_ATTEMPTED" == true ) ]]; then
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
    if [[ "$AUTO_HOLD_UPDATE_STARTED" == true ]]; then
      if [[ "$AUTO_DEPLOYMENT_HOLD_EXISTED" == true ]]; then
        AUTO_HOLD_RESTORE_TMP="$(mktemp "$STATE_DIR/.automatic-deployment-hold-restore.${COMMIT_SHA}.XXXXXX" 2>/dev/null || true)"
        if [[ -n "$AUTO_HOLD_RESTORE_TMP" ]] &&
           printf '%s\n' "$AUTO_DEPLOYMENT_HOLD_VALUE" > "$AUTO_HOLD_RESTORE_TMP" &&
           mv -f "$AUTO_HOLD_RESTORE_TMP" "$AUTO_DEPLOYMENT_HOLD_FILE"; then
          AUTO_HOLD_RESTORE_TMP=""
        else
          printf 'Deployment warning: failed to restore the automatic deployment hold; inspect state before retrying.\n' >&2
        fi
      elif [[ -f "$AUTO_DEPLOYMENT_HOLD_FILE" && ! -L "$AUTO_DEPLOYMENT_HOLD_FILE" ]] &&
           [[ "$(cat "$AUTO_DEPLOYMENT_HOLD_FILE" 2>/dev/null || true)" == "$COMMIT_SHA" ]]; then
        rm -f -- "$AUTO_DEPLOYMENT_HOLD_FILE" ||
          printf 'Deployment warning: failed to remove the uncommitted automatic deployment hold.\n' >&2
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
  if [[ -n "$AUTO_HOLD_TMP" && -f "$AUTO_HOLD_TMP" ]]; then
    rm -f -- "$AUTO_HOLD_TMP" || true
  fi
  if [[ -n "$AUTO_HOLD_RESTORE_TMP" && -f "$AUTO_HOLD_RESTORE_TMP" ]]; then
    rm -f -- "$AUTO_HOLD_RESTORE_TMP" || true
  fi
  if [[ -n "$SCHEMA_BASELINE_TMP" && -f "$SCHEMA_BASELINE_TMP" ]]; then
    rm -f -- "$SCHEMA_BASELINE_TMP" || true
  fi
  if [[ -n "$SCHEMA_TRACKING_TMP" && -f "$SCHEMA_TRACKING_TMP" ]]; then
    rm -f -- "$SCHEMA_TRACKING_TMP" || true
  fi
  if [[ -n "$MIGRATION_MARKER_TMP" && -f "$MIGRATION_MARKER_TMP" ]]; then
    rm -f -- "$MIGRATION_MARKER_TMP" || true
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

record_successful_migration() {
  SCHEMA_BASELINE_TMP="$(mktemp "$STATE_DIR/.database-schema-baseline.XXXXXX")"
  printf '%s\n' "$COMMIT_SHA" > "$SCHEMA_BASELINE_TMP"
  mv -f "$SCHEMA_BASELINE_TMP" "$SCHEMA_BASELINE_FILE"
  SCHEMA_BASELINE_TMP=""
  SCHEMA_BASELINE_SHA="$COMMIT_SHA"

  SCHEMA_TRACKING_TMP="$(mktemp "$STATE_DIR/.database-schema-tracking.XXXXXX")"
  printf 'version=1\n' > "$SCHEMA_TRACKING_TMP"
  mv -f "$SCHEMA_TRACKING_TMP" "$SCHEMA_TRACKING_FILE"
  SCHEMA_TRACKING_TMP=""
  SCHEMA_TRACKING_ENABLED=true

  rm -f -- "$MIGRATION_IN_PROGRESS_FILE" ||
    fail "database migration succeeded but its in-progress state could not be cleared; automatic deployment remains blocked."
  MIGRATION_IN_PROGRESS=false
}

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
  printf '{"commit":"%s","releaseId":"%s","image":"bot-ndi:%s","deploymentMode":"%s","ciRunId":"%s","ciRunAttempt":%s,"ciWorkflowId":%s,"createdAt":"%s"}\n' \
    "$COMMIT_SHA" "$RELEASE_ID" "$RELEASE_ID" "$DEPLOYMENT_MODE" "$CI_RUN_ID" "$CI_RUN_ATTEMPT" "$CI_WORKFLOW_ID" "$RELEASED_AT" > "$RELEASE_STAGING/metadata.json"
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

check_latest_main_head

if [[ -n "$ROLLBACK_SHA" ]]; then
  compose_for_release "$APP_DIR/$PRE_DEPLOY_ACTIVE_TARGET"
  DATABASE_CONTAINER_ID="$(compose ps -q db | head -n 1)"
  if [[ -z "$DATABASE_CONTAINER_ID" ]]; then
    fail "manual app rollback requires the existing MySQL container to be available; refusing to recreate it from an older release."
  fi
  DATABASE_HEALTH="$(docker inspect --format '{{.State.Health.Status}}' "$DATABASE_CONTAINER_ID" 2>/dev/null || true)"
  if [[ "$DATABASE_HEALTH" != healthy ]]; then
    fail "manual app rollback requires a healthy existing MySQL container; refusing to recreate it from an older release."
  fi
  compose_for_release "$RELEASE_DIR"
fi

if [[ "$INITIAL_BOOTSTRAP" == false ]]; then
  if [[ -n "$(compose ps -q app)" ]]; then
    PREVIOUS_APP_STOP_ATTEMPTED=true
    compose stop app || fail "the previous app service could not be stopped safely."
    PREVIOUS_APP_STOPPED=true
  fi
fi

if [[ -z "$ROLLBACK_SHA" ]]; then
  MIGRATION_MARKER_TMP="$(mktemp "$STATE_DIR/.database-migration-in-progress.${RUN_ID}.XXXXXX")"
  printf '%s\n' "$COMMIT_SHA" > "$MIGRATION_MARKER_TMP"
  mv -f "$MIGRATION_MARKER_TMP" "$MIGRATION_IN_PROGRESS_FILE"
  MIGRATION_MARKER_TMP=""
  compose up -d --wait --wait-timeout 120 db || fail "MySQL did not become healthy."
  if ! compose run --rm --no-deps app npm run migrate; then
    fail "application migrations failed; the database schema is not automatically rolled back."
  fi
  record_successful_migration
fi
CANDIDATE_APP_ATTEMPTED=true
compose up -d --no-deps --wait --wait-timeout 120 app || fail "application container did not become healthy."

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
  EXTERNAL_INTEGRATIONS_ENABLED \
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

check_latest_main_head

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
  if [[ "$PREVIOUS_RELEASE_EXISTED" == true ]]; then
    if [[ ! -f "$PREVIOUS_RELEASE_FILE" || -L "$PREVIOUS_RELEASE_FILE" ||
          "$(cat "$PREVIOUS_RELEASE_FILE" 2>/dev/null || true)" != "$PREVIOUS_RELEASE_VALUE" ]]; then
      fail "previous-release pointer changed during deployment; refusing to promote."
    fi
  elif [[ -e "$PREVIOUS_RELEASE_FILE" || -L "$PREVIOUS_RELEASE_FILE" ]]; then
    fail "previous-release pointer appeared during deployment; refusing to promote."
  fi
  PREVIOUS_RELEASE_TMP="$(mktemp "$APP_DIR/.previous-release.${COMMIT_SHA}.XXXXXX")"
  printf '%s\n' "$PREVIOUS_RELEASE_ID" > "$PREVIOUS_RELEASE_TMP"
  PREVIOUS_RELEASE_UPDATE_STARTED=true
  mv -f "$PREVIOUS_RELEASE_TMP" "$PREVIOUS_RELEASE_FILE"
  PREVIOUS_RELEASE_TMP=""
fi

NEXT_ACTIVE_LINK="$APP_DIR/.active-$DEPLOYMENT_RELEASE_ID-$$"
check_latest_main_head
if [[ -n "$ROLLBACK_SHA" ]]; then
  AUTO_HOLD_TMP="$(mktemp "$STATE_DIR/.automatic-deployment-hold.${RUN_ID}.XXXXXX")"
  printf '%s\n' "$COMMIT_SHA" > "$AUTO_HOLD_TMP"
  AUTO_HOLD_UPDATE_STARTED=true
  mv -f "$AUTO_HOLD_TMP" "$AUTO_DEPLOYMENT_HOLD_FILE"
  AUTO_HOLD_TMP=""
fi
ln -s "releases/$DEPLOYMENT_RELEASE_ID" "$NEXT_ACTIVE_LINK"
if mv --version >/dev/null 2>&1; then
  mv -fT "$NEXT_ACTIVE_LINK" "$ACTIVE_LINK"
else
  mv -fh "$NEXT_ACTIVE_LINK" "$ACTIVE_LINK"
fi
DEPLOYMENT_PROMOTED=true

if [[ -z "$ROLLBACK_SHA" ]]; then
  if [[ -e "$AUTO_DEPLOYMENT_HOLD_FILE" || -L "$AUTO_DEPLOYMENT_HOLD_FILE" ]]; then
    if [[ ! -f "$AUTO_DEPLOYMENT_HOLD_FILE" || -L "$AUTO_DEPLOYMENT_HOLD_FILE" ]]; then
      fail "release is active but automatic deployment hold state is invalid; operator reconciliation is required."
    fi
    rm -f -- "$AUTO_DEPLOYMENT_HOLD_FILE" ||
      fail "release is active but the previous rollback hold could not be cleared."
  fi
fi

if [[ -n "$ROLLBACK_SHA" ]]; then
  printf 'Manual rollback to retained release %s succeeded.\n' "$ROLLBACK_SHA"
  set_deployment_result "rolled_back"
else
  printf 'Deployment succeeded for commit %s.\n' "$COMMIT_SHA"
  printf 'Local image bot-ndi:%s (commit %s) is retained for rollback.\n' "$RELEASE_ID" "$COMMIT_SHA"
  set_deployment_result "deployed"
fi
printf 'Scheduler and Learning flags were verified in the running app environment.\n'
