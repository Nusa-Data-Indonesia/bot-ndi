'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const deployScript = path.resolve(__dirname, '../scripts/deploy-homelab.sh');
const runtimeFlags = [
  'SCHEDULER_ENABLED',
  'LEARNING_CAPTURE_ENABLED',
  'LEARNING_ACTIVATION_ENABLED',
  'LEARNING_RETRIEVAL_ENABLED',
  'LEARNING_PROMPT_INTEGRATION_ENABLED',
  'LEARNING_SHADOW_ENABLED',
  'LEARNING_RETENTION_ENABLED',
];

function runGit(workspace, args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

function commitSource(fixture, content = 'FROM node:22-bookworm-slim\n') {
  fs.writeFileSync(path.join(fixture.workspace, 'Dockerfile'), content);
  fs.writeFileSync(path.join(fixture.workspace, 'compose.yaml'), 'name: bot-ndi\nservices: {}\n');
  if (!fs.existsSync(path.join(fixture.workspace, '.git'))) {
    runGit(fixture.workspace, ['init', '-q']);
    runGit(fixture.workspace, ['config', 'user.name', 'Bot NDI Test']);
    runGit(fixture.workspace, ['config', 'user.email', 'bot-ndi@example.test']);
  }
  runGit(fixture.workspace, ['add', 'Dockerfile', 'compose.yaml']);
  runGit(fixture.workspace, ['commit', '-q', '-m', 'Test deployment source']);
  return runGit(fixture.workspace, ['rev-parse', 'HEAD']);
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-ndi-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const systemMv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
  const fixture = {
    root,
    workspace: path.join(root, 'workspace'),
    appDir: path.join(root, 'opt', 'bot-ndi'),
    bin: path.join(root, 'bin'),
    dockerLog: path.join(root, 'docker.log'),
    curlLog: path.join(root, 'curl.log'),
    activeImageFile: path.join(root, 'active-image-ref'),
    envFile: path.join(root, 'opt', 'bot-ndi', '.env'),
    deploymentCount: 0,
  };
  fs.mkdirSync(fixture.workspace, { recursive: true });
  fs.mkdirSync(fixture.appDir, { recursive: true });
  fs.mkdirSync(fixture.bin, { recursive: true });
  const envLines = [
    'NODE_ENV=production', 'PORT=3000', 'HOST_IP=192.0.2.77', 'HOST_PORT=3000',
    'BASE_URL=https://botndi.sequein.my.id', 'TIMEZONE=Asia/Jakarta',
    'TRUST_PROXY=', 'DB_HOST=db', 'DB_PORT=3306', 'DB_NAME=bot_ndi',
    'DB_USER=bot_ndi_app', 'DB_PASSWORD=test-db-secret-must-not-print',
    'DB_ROOT_PASSWORD=test-root-secret-must-not-print', 'DB_POOL_SIZE=5',
    'TEBAR_API_KEY=', 'TEBAR_PROFILE_ID=', 'TEBAR_ACCOUNT_ID=', 'TEBAR_WEBHOOK_SECRET=',
    'OPENROUTER_API_KEY=', 'TELEGRAM_BOT_TOKEN=', 'TELEGRAM_CHAT_ID=',
    ...runtimeFlags.map(flag => `${flag}=false`),
  ];
  fs.writeFileSync(fixture.envFile, `${envLines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(fixture.envFile, 0o600);

  fs.writeFileSync(path.join(fixture.bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "$1" == context && "$2" == show ]]; then printf 'default\\n'; exit 0; fi
if [[ "$1" == context && "$2" == inspect ]]; then printf 'unix:///var/run/docker.sock\\n'; exit 0; fi
if [[ "$1" == info ]]; then exit 0; fi
if [[ "$1" == compose && "$2" == version ]]; then printf 'Docker Compose version v5.7.1\\n'; exit 0; fi
if [[ "$1" == volume && "$2" == inspect ]]; then [[ "\${FAKE_VOLUME_EXISTS:-false}" == true ]]; exit; fi
if [[ "$1" == build ]]; then exit "\${FAKE_BUILD_STATUS:-0}"; fi
if [[ "$1" == image && "$2" == inspect ]]; then
  format="$4"
  case "$format" in
    *org.opencontainers.image.revision*) image_ref="$5"; image_tag="\${image_ref#bot-ndi:}"; printf '%s\\n' "\${image_tag:0:40}" ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "$1" == inspect ]]; then
  format="$3"
  case "$format" in
    *Config.Image*) cat "$FAKE_ACTIVE_IMAGE_FILE" ;;
    *org.opencontainers.image.revision*) sed 's/^bot-ndi://' "$FAKE_ACTIVE_IMAGE_FILE" | cut -c1-40 ;;
    *Config.Env*) printf '%s\\n' \\
      'SCHEDULER_ENABLED=false' \\
      'LEARNING_CAPTURE_ENABLED=false' \\
      'LEARNING_ACTIVATION_ENABLED=false' \\
      'LEARNING_RETRIEVAL_ENABLED=false' \\
      'LEARNING_PROMPT_INTEGRATION_ENABLED=false' \\
      'LEARNING_SHADOW_ENABLED=false' \\
      'LEARNING_RETENTION_ENABLED=false' ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "$1" == compose ]]; then
  release_env=''
  previous=''
  for arg in "$@"; do
    if [[ "$previous" == '--env-file' ]]; then release_env="$arg"; fi
    previous="$arg"
  done
  image_tag="$(awk -F= '$1 == "BOT_NDI_IMAGE_TAG" { print $2 }' "$release_env")"
  build_context="$(awk -F= '$1 == "BOT_NDI_BUILD_CONTEXT" { print $2 }' "$release_env")"
  printf 'compose-env BOT_NDI_IMAGE_TAG=%s BOT_NDI_BUILD_CONTEXT=%s\\n' "$image_tag" "$build_context" >> "$DOCKER_LOG"
  args=" $* "
  case "$args" in
    *' config --quiet '*) exit 0 ;;
    *' ps -q app '*) if [[ "\${FAKE_APP_RUNNING:-false}" == true ]] || grep -q 'up -d --no-deps --wait --wait-timeout 120 app' "$DOCKER_LOG"; then printf 'fake-container\\n'; fi; exit 0 ;;
    *' up -d --wait --wait-timeout 120 db '*) exit "\${FAKE_DB_STATUS:-0}" ;;
    *' run --rm --no-deps app npm run migrate '*) exit "\${FAKE_MIGRATE_STATUS:-0}" ;;
    *' stop app '*) exit 0 ;;
    *' up -d --no-deps --wait --wait-timeout 120 app '*)
      status="\${FAKE_APP_STATUS:-0}"
      if [[ "$status" == 0 ]]; then printf 'bot-ndi:%s\\n' "$image_tag" > "$FAKE_ACTIVE_IMAGE_FILE"; fi
      exit "$status"
      ;;
    *) printf 'Unexpected fake compose command\\n' >&2; exit 2 ;;
  esac
fi
printf 'Unexpected fake docker command\\n' >&2
exit 2
`);
  fs.writeFileSync(path.join(fixture.bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CURL_LOG"
if [[ "\${FAKE_CURL_FAIL_FIRST:-false}" == true && ! -f "$CURL_LOG.first-failure" ]]; then
  : > "$CURL_LOG.first-failure"
  exit 22
fi
exit "\${FAKE_CURL_STATUS:-0}"
`);
  fs.writeFileSync(path.join(fixture.bin, 'ip'), `#!/usr/bin/env bash
if [[ "\${FAKE_IP_MISMATCH:-false}" == true ]]; then
  printf '2: eth0    inet 192.0.2.78/24 brd 192.0.2.255 scope global eth0\\n'
else
  printf '2: eth0    inet 192.0.2.77/24 brd 192.0.2.255 scope global eth0\\n'
fi
`);
  fs.writeFileSync(path.join(fixture.bin, 'mv'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_ACTIVE_PROMOTION_STATUS:-0}" != 0 ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "$BOT_NDI_APP_DIR"/.active-* ]]; then exit "$FAKE_ACTIVE_PROMOTION_STATUS"; fi
  done
fi
exec ${JSON.stringify(systemMv)} "$@"
`);
  fs.chmodSync(path.join(fixture.bin, 'docker'), 0o755);
  fs.chmodSync(path.join(fixture.bin, 'curl'), 0o755);
  fs.chmodSync(path.join(fixture.bin, 'ip'), 0o755);
  fs.chmodSync(path.join(fixture.bin, 'mv'), 0o755);
  fixture.sha = commitSource(fixture);
  return fixture;
}

function deploymentEnv(fixture, sha, extra = {}) {
  const runId = String(fixture.deploymentCount);
  return {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH}`,
    DOCKER_LOG: fixture.dockerLog,
    CURL_LOG: fixture.curlLog,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'Nusa-Data-Indonesia/bot-ndi',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKSPACE: fixture.workspace,
    BOT_NDI_COMMIT_SHA: sha,
    BOT_NDI_APP_DIR: fixture.appDir,
    BOT_NDI_TEST_MODE: '1',
    BOT_NDI_HEALTH_RETRIES: '1',
    BOT_NDI_HEALTH_RETRY_DELAY: '0',
    FAKE_EXPECTED_SHA: sha,
    FAKE_ACTIVE_IMAGE_FILE: fixture.activeImageFile,
    ...extra,
  };
}

function deploy(fixture, sha, extra = {}) {
  fixture.deploymentCount += 1;
  const deploymentId = `${sha}-${fixture.deploymentCount}-1`;
  const result = spawnSync('bash', [deployScript], {
    cwd: fixture.workspace,
    env: deploymentEnv(fixture, sha, extra),
    encoding: 'utf8',
    timeout: 15_000,
  });
  result.deploymentId = deploymentId;
  return result;
}

function logText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function activeReleaseId(fixture) {
  return fs.readlinkSync(path.join(fixture.appDir, 'active')).slice('releases/'.length);
}

test('deployment rejects non-dispatch, non-main, other repository, and mismatched SHA before Docker mutations', t => {
  const fixture = createFixture(t);
  for (const extra of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/feature/untrusted' },
    { GITHUB_REPOSITORY: 'attacker/bot-ndi' },
    { GITHUB_SHA: 'f'.repeat(40) },
  ]) {
    const result = deploy(fixture, fixture.sha, extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /deployment provenance.*refusing/i);
  }
  assert.equal(logText(fixture.dockerLog), '');
});

test('deployment refuses an environment IP that is not assigned to the LXC', t => {
  const fixture = createFixture(t);
  const result = deploy(fixture, fixture.sha, { FAKE_IP_MISMATCH: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HOST_IP is not currently assigned to this LXC/i);
  assert.equal(logText(fixture.dockerLog), '');
});

test('first bootstrap refuses scheduler or Learning execution before starting the app', t => {
  const fixture = createFixture(t);
  fs.appendFileSync(fixture.envFile, 'SCHEDULER_ENABLED=true\n');
  const result = deploy(fixture, fixture.sha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /initial bootstrap.*disabled/i);
  assert.equal(logText(fixture.dockerLog).includes('build '), false);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
});

test('fresh deployment builds the exact commit locally, migrates, verifies readiness and revision, and preserves the local environment', t => {
  const fixture = createFixture(t);
  const envBefore = fs.readFileSync(fixture.envFile);
  const result = deploy(fixture, fixture.sha, {
    BOT_NDI_IMAGE_TAG: 'stale-runner-image',
    BOT_NDI_BUILD_CONTEXT: '/tmp/untrusted-build-context',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Deployment succeeded.*${fixture.sha}`));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /test-db-secret-must-not-print|test-root-secret-must-not-print/);
  assert.equal(fs.readFileSync(fixture.envFile).equals(envBefore), true);
  assert.equal(fs.statSync(fixture.envFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'source', fixture.sha, '.env')), false);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'source', fixture.sha, '.bot-ndi-commit'), 'utf8').trim(), fixture.sha);
  assert.equal(activeReleaseId(fixture), result.deploymentId);
  const releaseDir = path.join(fixture.appDir, 'releases', result.deploymentId);
  const metadata = JSON.parse(fs.readFileSync(path.join(releaseDir, 'metadata.json'), 'utf8'));
  assert.equal(metadata.commit, fixture.sha);
  assert.equal(metadata.releaseId, result.deploymentId);
  assert.equal(metadata.image, `bot-ndi:${result.deploymentId}`);
  const healthMetadata = JSON.parse(fs.readFileSync(path.join(releaseDir, 'health-verified.json'), 'utf8'));
  assert.equal(healthMetadata.commit, fixture.sha);
  assert.equal(healthMetadata.releaseId, result.deploymentId);
  assert.equal(healthMetadata.image, `bot-ndi:${result.deploymentId}`);
  const commands = logText(fixture.dockerLog);
  assert.match(fs.readFileSync(path.join(releaseDir, 'release.env'), 'utf8'), new RegExp(`^BOT_NDI_IMAGE_TAG=${result.deploymentId}\\nBOT_NDI_BUILD_CONTEXT=${fixture.appDir}/source/${fixture.sha}\\nBOT_NDI_COMMIT_SHA=${fixture.sha}\\n$`));
  assert.doesNotMatch(commands, /stale-runner-image|untrusted-build-context/);
  assert.match(commands, new RegExp(`build .*--target runtime .*--build-arg VCS_REF=${fixture.sha} .*--tag bot-ndi:${result.deploymentId}`));
  assert.match(commands, /run --rm --no-deps app npm run migrate/);
  assert.match(commands, /up -d --wait --wait-timeout 120 db/);
  assert.match(commands, /up -d --no-deps --wait --wait-timeout 120 app/);
  assert.match(logText(fixture.curlLog), /192\.0\.2\.77:3000\/health\/ready/);
  assert.doesNotMatch(commands, /down -v|volume rm|image prune|image rm|ghcr\.io|ssh /i);
});

test('failed health rolls back to the previous verified local image and preserves release pointers', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const previousReleaseId = first.deploymentId;
  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# second release\n');
  const second = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(activeReleaseId(fixture), second.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), previousReleaseId);

  const promotedReleaseId = second.deploymentId;
  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# failing release\n');
  const failed = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true', FAKE_CURL_FAIL_FIRST: 'true' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /health check failed/i);
  assert.match(failed.stderr, /Automatic rollback to local release/);
  assert.equal(activeReleaseId(fixture), promotedReleaseId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), previousReleaseId);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'releases', failed.deploymentId, 'health-verified.json')), false);
  const failedDeploymentCommands = logText(fixture.dockerLog);
  const candidateStart = failedDeploymentCommands.indexOf('up -d --no-deps --wait --wait-timeout 120 app');
  const lastAppStop = failedDeploymentCommands.lastIndexOf(' stop app');
  const rollbackStart = failedDeploymentCommands.lastIndexOf('up -d --no-deps --wait --wait-timeout 120 app');
  assert.ok(lastAppStop > candidateStart, 'a failed candidate must be stopped');
  assert.ok(rollbackStart > lastAppStop, 'the verified previous app image must be restarted after stopping the candidate');
  assert.match(failedDeploymentCommands, new RegExp(`/releases/${promotedReleaseId}/release\\.env`));
  assert.doesNotMatch(failedDeploymentCommands, /image prune|image rm|down -v|volume rm/i);

  fs.writeFileSync(path.join(fixture.appDir, 'previous-release'), `${failed.deploymentId}\n`);
  const composeCount = (failedDeploymentCommands.match(/^compose --project-directory /gm) || []).length;
  const rejectedRollback = deploy(fixture, fixture.sha, {
    BOT_NDI_ROLLBACK_SHA: fixture.sha,
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(rejectedRollback.status, 0);
  assert.match(rejectedRollback.stderr, /health-verified retained release/i);
  assert.equal((logText(fixture.dockerLog).match(/^compose --project-directory /gm) || []).length, composeCount);
});

test('failed active-pointer promotion stops the candidate and restores previous-release', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const olderReleaseId = first.deploymentId;

  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# promoted release\n');
  const second = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const activeRelease = second.deploymentId;
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), olderReleaseId);

  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# pointer promotion fails\n');
  const failed = deploy(fixture, fixture.sha, {
    FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true', FAKE_ACTIVE_PROMOTION_STATUS: '1',
  });
  assert.notEqual(failed.status, 0);
  assert.equal(activeReleaseId(fixture), activeRelease);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), olderReleaseId);
  const commands = logText(fixture.dockerLog);
  assert.ok(commands.lastIndexOf(' stop app') > commands.indexOf('up -d --no-deps --wait --wait-timeout 120 app'));
  assert.ok(commands.lastIndexOf('up -d --no-deps --wait --wait-timeout 120 app') > commands.lastIndexOf(' stop app'));
});

test('failed same-SHA promotion stops the candidate and restores the pre-deployment pointer state', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const activeRelease = first.deploymentId;
  const activeSha = fixture.sha;
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'previous-release')), false);

  const failed = deploy(fixture, activeSha, {
    FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true', FAKE_ACTIVE_PROMOTION_STATUS: '1',
  });
  assert.notEqual(failed.status, 0);
  assert.equal(activeReleaseId(fixture), activeRelease);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'previous-release')), false);
  const commands = logText(fixture.dockerLog);
  assert.ok(commands.lastIndexOf(' stop app') > commands.indexOf('up -d --no-deps --wait --wait-timeout 120 app'));
  assert.ok(commands.lastIndexOf('up -d --no-deps --wait --wait-timeout 120 app') > commands.lastIndexOf(' stop app'));
});

test('failed same-SHA redeploy rolls back to the immutable previously verified image', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const previousTarget = fs.readlinkSync(path.join(fixture.appDir, 'active'));
  const previousReleaseId = previousTarget.slice('releases/'.length);
  const previousReleaseDir = path.join(fixture.appDir, 'releases', previousReleaseId);
  const previousImage = JSON.parse(fs.readFileSync(path.join(previousReleaseDir, 'metadata.json'), 'utf8')).image;
  const previousReleaseEnv = fs.readFileSync(path.join(previousReleaseDir, 'release.env'));

  const failed = deploy(fixture, fixture.sha, {
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
    FAKE_CURL_FAIL_FIRST: 'true',
  });
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readlinkSync(path.join(fixture.appDir, 'active')), previousTarget);
  assert.equal(fs.readFileSync(path.join(previousReleaseDir, 'release.env')).equals(previousReleaseEnv), true);
  assert.notEqual(previousImage, `bot-ndi:${failed.deploymentId}`);

  const commands = logText(fixture.dockerLog);
  assert.match(commands, new RegExp(`build .*--target runtime .*--build-arg VCS_REF=${fixture.sha} .*--tag bot-ndi:${failed.deploymentId}`));
  const rollbackCompose = commands.slice(commands.lastIndexOf(' stop app'));
  assert.match(rollbackCompose, new RegExp(`/releases/${previousReleaseId}/release\\.env`));
  assert.match(rollbackCompose, new RegExp(`compose-env BOT_NDI_IMAGE_TAG=${previousImage.slice('bot-ndi:'.length)}`));
  assert.equal(fs.readFileSync(fixture.activeImageFile, 'utf8').trim(), previousImage);
  assert.match(failed.stderr, /Automatic rollback to local release/);
});

test('failed initial migration leaves no active release or app container', t => {
  const fixture = createFixture(t);
  const result = deploy(fixture, fixture.sha, { FAKE_MIGRATE_STATUS: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /migrations failed/i);
  const commands = logText(fixture.dockerLog);
  assert.match(commands, /run --rm --no-deps app npm run migrate/);
  assert.doesNotMatch(commands, /up -d --no-deps --wait --wait-timeout 120 app/);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
});

test('failed upgrade migration restarts the previous verified app image', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const previousSha = fixture.sha;
  const previousReleaseId = first.deploymentId;
  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# migration failure\n');

  const failed = deploy(fixture, fixture.sha, {
    FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true', FAKE_MIGRATE_STATUS: '1',
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /migrations failed/i);
  assert.match(failed.stderr, new RegExp(`Automatic rollback to local release ${previousSha} succeeded`));
  const commands = logText(fixture.dockerLog);
  assert.match(commands, new RegExp(`/releases/${previousReleaseId}/release\\.env`));
  assert.equal(fs.readlinkSync(path.join(fixture.appDir, 'active')), `releases/${previousReleaseId}`);
  assert.equal(fs.readFileSync(fixture.activeImageFile, 'utf8').trim(), `bot-ndi:${previousReleaseId}`);
});

test('manual rollback reuses a retained verified local image without rebuilding or migrating', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const previousSha = fixture.sha;
  const previousReleaseId = first.deploymentId;

  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# current release\n');
  const current = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(current.status, 0, current.stderr || current.stdout);
  const currentSha = fixture.sha;
  const logBeforeRollback = logText(fixture.dockerLog).length;

  const rollback = deploy(fixture, currentSha, {
    BOT_NDI_ROLLBACK_SHA: previousSha,
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
    FAKE_EXPECTED_SHA: previousSha,
  });
  assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
  assert.match(rollback.stdout, new RegExp(`Manual rollback to retained release ${previousSha} succeeded`));
  assert.equal(fs.readlinkSync(path.join(fixture.appDir, 'active')), `releases/${previousReleaseId}`);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), current.deploymentId);
  assert.equal(fs.readFileSync(fixture.activeImageFile, 'utf8').trim(), `bot-ndi:${previousReleaseId}`);

  const rollbackCommands = logText(fixture.dockerLog).slice(logBeforeRollback);
  assert.match(rollbackCommands, new RegExp(`/releases/${previousReleaseId}/compose\\.yaml up -d --no-deps --wait --wait-timeout 120 app`));
  assert.doesNotMatch(rollbackCommands, /build |npm run migrate|docker pull|image rm|image prune|down -v/i);
});

test('manual rollback refuses a malformed SHA before Docker mutations', t => {
  const fixture = createFixture(t);
  const result = deploy(fixture, fixture.sha, { BOT_NDI_ROLLBACK_SHA: 'latest' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback target must be a full commit SHA/i);
  assert.equal(logText(fixture.dockerLog), '');
});

test('first deployment refuses an unexplained pre-existing persistent database volume', t => {
  const fixture = createFixture(t);
  const result = deploy(fixture, fixture.sha, { FAKE_VOLUME_EXISTS: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing MySQL volume.*refusing/i);
  assert.equal(logText(fixture.dockerLog).includes('build '), false);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
});
