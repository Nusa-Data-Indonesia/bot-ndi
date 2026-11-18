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
  'EXTERNAL_INTEGRATIONS_ENABLED',
  'LEARNING_CAPTURE_ENABLED',
  'LEARNING_ACTIVATION_ENABLED',
  'LEARNING_RETRIEVAL_ENABLED',
  'LEARNING_PROMPT_INTEGRATION_ENABLED',
  'LEARNING_SHADOW_ENABLED',
  'LEARNING_RETENTION_ENABLED',
];
const configuredIntegrations = {
  TEBAR_API_KEY: 'test-tebar-key-must-not-print',
  TEBAR_PROFILE_ID: 'test-tebar-profile-must-not-print',
  TEBAR_ACCOUNT_ID: 'test-tebar-account-must-not-print',
  TEBAR_WEBHOOK_SECRET: 'test-webhook-secret-must-not-print',
  OPENROUTER_API_KEY: 'test-openrouter-key-must-not-print',
  TELEGRAM_BOT_TOKEN: 'test-telegram-token-must-not-print',
  TELEGRAM_CHAT_ID: 'test-telegram-chat-must-not-print',
};

function runGit(workspace, args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

function commitSource(fixture, content = 'FROM node:22-bookworm-slim\n', {
  migrationContent = '-- unchanged Bot NDI test migration\n',
  migratorSource = 'module.exports = { testFixture: true };\n',
  runtimeContent = 'module.exports = { appFixture: true };\n',
  cliSource = 'module.exports = { startupFixture: true };\n',
  databaseSource = 'module.exports = { databaseFixture: true };\n',
  configSource = 'module.exports = { configFixture: true };\n',
  packageManifest = '{"name":"bot-ndi-test","version":"1.0.0"}\n',
  packageLock = '{"name":"bot-ndi-test","version":"1.0.0","lockfileVersion":3,"packages":{}}\n',
  dockerContent = content,
  composeContent = 'name: bot-ndi\nservices: {}\n',
  dockerIgnoreContent = 'node_modules\n.env\n',
  dockerfileIgnoreContent = '',
  attributesContent = '',
} = {}) {
  const sourceFiles = {
    Dockerfile: dockerContent,
    'compose.yaml': composeContent,
    '.dockerignore': dockerIgnoreContent,
    'Dockerfile.dockerignore': dockerfileIgnoreContent,
    '.gitattributes': attributesContent,
    'package.json': packageManifest,
    'package-lock.json': packageLock,
    'migrations/001_test.sql': migrationContent,
    'src/migrate.js': migratorSource,
    'src/cli.js': cliSource,
    'src/db.js': databaseSource,
    'src/config.js': configSource,
    'src/feature.js': runtimeContent,
  };
  for (const [relativePath, source] of Object.entries(sourceFiles)) {
    const absolutePath = path.join(fixture.workspace, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, source);
  }
  if (!fs.existsSync(path.join(fixture.workspace, '.git'))) {
    runGit(fixture.workspace, ['init', '-q']);
    runGit(fixture.workspace, ['config', 'user.name', 'Bot NDI Test']);
    runGit(fixture.workspace, ['config', 'user.email', 'bot-ndi@example.test']);
  }
  runGit(fixture.workspace, ['add', ...Object.keys(sourceFiles)]);
  runGit(fixture.workspace, ['commit', '-q', '-m', 'Test deployment source']);
  return runGit(fixture.workspace, ['rev-parse', 'HEAD']);
}

function createFixture(t, integrationValues = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-ndi-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const systemMv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
  const systemNode = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  const fixture = {
    root,
    workspace: path.join(root, 'workspace'),
    appDir: path.join(root, 'opt', 'bot-ndi'),
    bin: path.join(root, 'bin'),
    dockerLog: path.join(root, 'docker.log'),
    curlLog: path.join(root, 'curl.log'),
    headCheckLog: path.join(root, 'head-check.log'),
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
    ...Object.keys(configuredIntegrations).map(key => `${key}=${integrationValues[key] || ''}`),
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
    *State.Health.Status*) printf '%s\\n' "\${FAKE_DB_HEALTH:-healthy}" ;;
    *Config.Image*) cat "$FAKE_ACTIVE_IMAGE_FILE" ;;
    *org.opencontainers.image.revision*) sed 's/^bot-ndi://' "$FAKE_ACTIVE_IMAGE_FILE" | cut -c1-40 ;;
    *Config.Env*) printf '%s\\n' \\
      'SCHEDULER_ENABLED=false' \\
      'EXTERNAL_INTEGRATIONS_ENABLED=false' \\
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
    *' ps -q db '*) printf 'fake-database-container\\n'; exit 0 ;;
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
  fs.writeFileSync(path.join(fixture.bin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "$GITHUB_WORKSPACE/scripts/check-release-head.js" ]]; then
  printf '%s\\n' "$COMMIT_SHA" >> "$FAKE_HEAD_CHECK_LOG"
  check_number="$(awk 'END { print NR }' "$FAKE_HEAD_CHECK_LOG")"
  main_head_sha="\${FAKE_MAIN_HEAD_SHA:-$COMMIT_SHA}"
  if [[ -n "\${FAKE_MAIN_HEAD_SHA_AFTER_CHECK:-}" &&
        "$check_number" -ge "\${FAKE_MAIN_HEAD_CHECK_NUMBER:-1}" ]]; then
    main_head_sha="$FAKE_MAIN_HEAD_SHA_AFTER_CHECK"
  fi
  if [[ "$main_head_sha" != "$COMMIT_SHA" || "\${FAKE_HEAD_CHECK_FAIL_AT:-}" == "$check_number" ]]; then
    exit 1
  fi
  exit 0
fi
exec ${JSON.stringify(systemNode)} "$@"
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
  fs.chmodSync(path.join(fixture.bin, 'node'), 0o755);
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
    FAKE_HEAD_CHECK_LOG: fixture.headCheckLog,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'Nusa-Data-Indonesia/bot-ndi',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKSPACE: fixture.workspace,
    RELEASE_GITHUB_TOKEN: 'mock-release-token',
    BOT_NDI_COMMIT_SHA: sha,
    BOT_NDI_DEPLOYMENT_MODE: 'manual',
    BOT_NDI_CI_RUN_ID: '12345',
    BOT_NDI_CI_RUN_ATTEMPT: '1',
    BOT_NDI_CI_WORKFLOW_ID: '67',
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

function deployAutomatically(fixture, sha, extra = {}) {
  return deploy(fixture, sha, {
    BOT_NDI_DEPLOYMENT_MODE: 'automatic',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_SHA: 'f'.repeat(40),
    BOT_NDI_CI_RUN_ID: '23456',
    BOT_NDI_CI_RUN_ATTEMPT: '2',
    BOT_NDI_CI_WORKFLOW_ID: '67',
    RELEASE_GITHUB_TOKEN: 'mock-release-token',
    FAKE_MAIN_HEAD_SHA: sha,
    ...extra,
  });
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
    assert.match(result.stderr, /provenance.*refusing/i);
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

test('first bootstrap refuses scheduler, external integrations or Learning execution before Docker mutations', t => {
  for (const flag of runtimeFlags) {
    const fixture = createFixture(t, configuredIntegrations);
    fs.writeFileSync(fixture.envFile, fs.readFileSync(fixture.envFile, 'utf8').replace(`${flag}=false`, `${flag}=true`));
    const result = deploy(fixture, fixture.sha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`initial bootstrap requires ${flag}=false`));
    assert.doesNotMatch(logText(fixture.dockerLog), /build |up -d|run --rm/);
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
  }
});

test('first bootstrap permits configured external credentials while execution is disabled without disclosing or changing them', t => {
  const fixture = createFixture(t, configuredIntegrations);
  const envBefore = fs.readFileSync(fixture.envFile);
  assert.match(envBefore.toString(), /^EXTERNAL_INTEGRATIONS_ENABLED=false$/m);
  const result = deploy(fixture, fixture.sha);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(activeReleaseId(fixture), result.deploymentId);
  assert.equal(fs.readFileSync(fixture.envFile).equals(envBefore), true);
  assert.equal(fs.statSync(fixture.envFile).mode & 0o777, 0o600);
  const output = `${result.stdout}\n${result.stderr}\n${logText(fixture.dockerLog)}\n${logText(fixture.curlLog)}`;
  for (const value of Object.values(configuredIntegrations)) assert.equal(output.includes(value), false);
  assert.match(logText(fixture.dockerLog), /up -d --no-deps --wait --wait-timeout 120 app/);
});

test('first bootstrap accepts an existing environment without the external activation flag and preserves it', t => {
  const fixture = createFixture(t, configuredIntegrations);
  fs.writeFileSync(fixture.envFile, fs.readFileSync(fixture.envFile, 'utf8').replace('EXTERNAL_INTEGRATIONS_ENABLED=false\n', ''));
  const envBefore = fs.readFileSync(fixture.envFile);
  const result = deploy(fixture, fixture.sha);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(activeReleaseId(fixture), result.deploymentId);
  assert.equal(fs.readFileSync(fixture.envFile).equals(envBefore), true);
  const output = `${result.stdout}\n${result.stderr}\n${logText(fixture.dockerLog)}\n${logText(fixture.curlLog)}`;
  for (const value of Object.values(configuredIntegrations)) assert.equal(output.includes(value), false);
});

test('first bootstrap refuses invalid or ambiguous external activation entries before Docker mutations', t => {
  for (const entry of ['', 'true', 'false\nEXTERNAL_INTEGRATIONS_ENABLED=true', 'false\nexport EXTERNAL_INTEGRATIONS_ENABLED=true']) {
    const fixture = createFixture(t, configuredIntegrations);
    fs.writeFileSync(fixture.envFile, fs.readFileSync(fixture.envFile, 'utf8').replace('EXTERNAL_INTEGRATIONS_ENABLED=false', `EXTERNAL_INTEGRATIONS_ENABLED=${entry}`));
    const result = deploy(fixture, fixture.sha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /initial bootstrap requires EXTERNAL_INTEGRATIONS_ENABLED=false/);
    assert.doesNotMatch(logText(fixture.dockerLog), /build |up -d|run --rm/);
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
  }
});

test('first bootstrap still requires unambiguous integration environment entries', t => {
  for (const invalidEntry of ['missing', 'duplicate']) {
    const fixture = createFixture(t, configuredIntegrations);
    const environment = fs.readFileSync(fixture.envFile, 'utf8');
    fs.writeFileSync(fixture.envFile, invalidEntry === 'missing'
      ? environment.replace(`TEBAR_API_KEY=${configuredIntegrations.TEBAR_API_KEY}\n`, '')
      : `${environment}TEBAR_API_KEY=\n`);
    const result = deploy(fixture, fixture.sha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /one runtime environment entry for TEBAR_API_KEY/);
    assert.equal(logText(fixture.dockerLog).includes('build '), false);
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
    for (const value of Object.values(configuredIntegrations)) assert.equal(`${result.stdout}\n${result.stderr}`.includes(value), false);
  }
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
  fixture.sha = commitSource(fixture, undefined, { migrationContent: '-- new schema migration\n' });
  const failedMigrationSha = fixture.sha;

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
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-baseline'), 'utf8').trim(), previousSha);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-migration-in-progress'), 'utf8').trim(), failedMigrationSha);

  runGit(fixture.workspace, ['reset', '--hard', previousSha]);
  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const dockerLogBeforeAutomatic = logText(fixture.dockerLog).length;
  const automatic = deployAutomatically(fixture, fixture.sha, {
    FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(automatic.status, 0);
  assert.match(automatic.stderr, /unverified database migration/i);
  assert.equal(activeReleaseId(fixture), first.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(dockerLogBeforeAutomatic), /build |stop app|run --rm|up -d/);
});

test('database startup failure leaves schema state uncertain and blocks later automatic runs', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const initialSha = fixture.sha;

  fixture.sha = commitSource(fixture, undefined, {
    composeContent: 'name: bot-ndi\nservices:\n  db:\n    image: mysql:9\n',
  });
  const candidateSha = fixture.sha;
  const failedDatabaseStart = deploy(fixture, candidateSha, {
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
    FAKE_DB_STATUS: '1',
  });
  assert.notEqual(failedDatabaseStart.status, 0);
  assert.match(failedDatabaseStart.stderr, /MySQL did not become healthy/i);
  assert.equal(activeReleaseId(fixture), initial.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-migration-in-progress'), 'utf8').trim(), candidateSha);

  runGit(fixture.workspace, ['reset', '--hard', initialSha]);
  fixture.sha = initialSha;
  const beforeAutomatic = logText(fixture.dockerLog).length;
  const automatic = deployAutomatically(fixture, initialSha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.notEqual(automatic.status, 0);
  assert.match(automatic.stderr, /unverified database migration/i);
  assert.equal(activeReleaseId(fixture), initial.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(beforeAutomatic), /build |stop app|run --rm|up -d/);
});

test('automatic deployment uses the verified CI SHA and deploys only an app-only main update', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const initialReleaseId = initial.deploymentId;
  const environmentBeforeAutomatic = fs.readFileSync(fixture.envFile);
  assert.match(environmentBeforeAutomatic.toString(), /^SCHEDULER_ENABLED=false$/m);

  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const oldWorkflowSha = 'f'.repeat(40);
  fs.writeFileSync(fixture.headCheckLog, '');
  const automatic = deployAutomatically(fixture, fixture.sha, {
    GITHUB_SHA: oldWorkflowSha,
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
  });
  assert.equal(automatic.status, 0, automatic.stderr || automatic.stdout);
  assert.match(automatic.stdout, new RegExp(`Deployment succeeded for commit ${fixture.sha}`));
  assert.equal(activeReleaseId(fixture), automatic.deploymentId);
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.appDir, 'releases', automatic.deploymentId, 'metadata.json'), 'utf8'));
  assert.equal(metadata.commit, fixture.sha);
  assert.equal(metadata.deploymentMode, 'automatic');
  assert.equal(metadata.ciRunId, '23456');
  assert.equal(metadata.ciRunAttempt, 2);
  assert.equal(metadata.ciWorkflowId, 67);
  assert.notEqual(metadata.commit, oldWorkflowSha);
  assert.equal(fs.readFileSync(fixture.envFile).equals(environmentBeforeAutomatic), true);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-volume'), 'utf8'), 'volume=bot-ndi_mysql_data\nstate=ready\n');
  assert.equal(logText(fixture.headCheckLog).trim().split('\n').length, 4);
  assert.match(logText(fixture.dockerLog), /build .*--build-arg VCS_REF=/);
  assert.match(logText(fixture.dockerLog), /run --rm --no-deps app npm run migrate/);
  assert.match(logText(fixture.curlLog), /192\.0\.2\.77:3000\/health\/ready/);
  assert.doesNotMatch(`${logText(fixture.curlLog)}\n${logText(fixture.dockerLog)}`, /threads\.net|api\.tebar|telegram|down -v|volume rm|image prune/i);

  const previousPointer = fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim();
  assert.equal(previousPointer, initialReleaseId);
  const dockerLogBeforeDuplicate = logText(fixture.dockerLog).length;
  const duplicate = deployAutomatically(fixture, fixture.sha, {
    FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true', GITHUB_SHA: 'e'.repeat(40),
  });
  assert.equal(duplicate.status, 0, duplicate.stderr || duplicate.stdout);
  assert.match(duplicate.stdout, /already active/i);
  assert.equal(activeReleaseId(fixture), automatic.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), previousPointer);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(dockerLogBeforeDuplicate), /build |stop app|run --rm|up -d/);
});

test('automatic deployment refuses migration SQL or execution-surface changes before Docker mutation', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const active = initial.deploymentId;
  const activeSha = fixture.sha;
  const changedSources = [
    { migrationContent: '-- schema changed\n' },
    { migratorSource: 'module.exports = { testFixture: false };\n' },
    { cliSource: 'module.exports = { startupFixture: false };\n' },
    { databaseSource: 'module.exports = { databaseFixture: false };\n' },
    { configSource: 'module.exports = { configFixture: false };\n' },
    { packageManifest: '{"name":"bot-ndi-test","version":"2.0.0"}\n' },
    { packageLock: '{"name":"bot-ndi-test","version":"2.0.0","lockfileVersion":3,"packages":{}}\n' },
    { dockerContent: 'FROM node:22-bookworm-slim\n# build input changed\n' },
    { composeContent: 'name: bot-ndi\nservices: {}\n# startup input changed\n' },
    { dockerIgnoreContent: 'node_modules\n' },
    { dockerfileIgnoreContent: 'migrations/\n' },
    { attributesContent: 'migrations/ export-ignore\n' },
  ];

  for (const changedSource of changedSources) {
    runGit(fixture.workspace, ['reset', '--hard', activeSha]);
    fixture.sha = commitSource(fixture, undefined, changedSource);
    const dockerLogBeforeAttempt = logText(fixture.dockerLog).length;

    const blocked = deployAutomatically(fixture, fixture.sha, {
      FAKE_APP_RUNNING: 'true',
      FAKE_VOLUME_EXISTS: 'true',
    });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /migration or startup execution surface changed/i);
    assert.equal(activeReleaseId(fixture), active);
    assert.doesNotMatch(logText(fixture.dockerLog).slice(dockerLogBeforeAttempt), /build |stop app|run --rm|up -d/);
  }
});

test('automatic deployment rejects a stale main head before building and recovers if main advances before promotion', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const active = initial.deploymentId;
  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const beforeStaleAttempt = logText(fixture.dockerLog).length;
  const stale = deployAutomatically(fixture, fixture.sha, {
    FAKE_MAIN_HEAD_SHA: 'd'.repeat(40),
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /no longer the current main head/i);
  assert.equal(activeReleaseId(fixture), active);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(beforeStaleAttempt), /build |stop app|run --rm|up -d/);

  fs.writeFileSync(fixture.headCheckLog, '');
  const beforeLateCheck = logText(fixture.dockerLog).length;
  const advancedDuringDeployment = deployAutomatically(fixture, fixture.sha, {
    FAKE_MAIN_HEAD_SHA: fixture.sha,
    FAKE_HEAD_CHECK_FAIL_AT: '4',
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(advancedDuringDeployment.status, 0);
  assert.match(advancedDuringDeployment.stderr, /no longer the current main head/i);
  assert.equal(activeReleaseId(fixture), active);
  assert.equal(fs.readFileSync(fixture.activeImageFile, 'utf8').trim(), `bot-ndi:${active}`);
  const recoveryCommands = logText(fixture.dockerLog).slice(beforeLateCheck);
  assert.match(recoveryCommands, /up -d --no-deps --wait --wait-timeout 120 app/);
  assert.doesNotMatch(recoveryCommands, /down -v|volume rm|image prune|image rm/i);
});

test('a newer main commit can deploy after an older automatic run migrates and is superseded before promotion', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);

  const supersededSha = commitSource(fixture, undefined, {
    runtimeContent: 'module.exports = { appFixture: "superseded" };\n',
  });
  const newerWorktree = path.join(fixture.root, 'newer-worktree');
  runGit(fixture.workspace, ['worktree', 'add', '--detach', newerWorktree, supersededSha]);
  fs.writeFileSync(path.join(newerWorktree, 'src', 'feature.js'), 'module.exports = { appFixture: "latest" };\n');
  runGit(newerWorktree, ['add', 'src/feature.js']);
  runGit(newerWorktree, ['commit', '-q', '-m', 'Latest app-only update']);
  const latestSha = runGit(newerWorktree, ['rev-parse', 'HEAD']);

  fs.writeFileSync(fixture.headCheckLog, '');
  const superseded = deployAutomatically(fixture, supersededSha, {
    FAKE_MAIN_HEAD_SHA_AFTER_CHECK: latestSha,
    FAKE_MAIN_HEAD_CHECK_NUMBER: '4',
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(superseded.status, 0);
  assert.match(superseded.stderr, /no longer the current main head/i);
  assert.equal(activeReleaseId(fixture), initial.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-baseline'), 'utf8').trim(), supersededSha);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'state', 'database-migration-in-progress')), false);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-tracking'), 'utf8'), 'version=1\n');

  runGit(fixture.workspace, ['checkout', '--detach', latestSha]);
  fixture.sha = latestSha;
  fs.writeFileSync(fixture.headCheckLog, '');
  const latest = deployAutomatically(fixture, latestSha, {
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
  });
  assert.equal(latest.status, 0, latest.stderr || latest.stdout);
  assert.equal(activeReleaseId(fixture), latest.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-baseline'), 'utf8').trim(), latestSha);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'state', 'database-migration-in-progress')), false);
});

test('a managed schema baseline cannot silently fall back to the active app SHA when missing', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-tracking'), 'utf8'), 'version=1\n');
  fs.rmSync(path.join(fixture.appDir, 'state', 'database-schema-baseline'));
  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const before = logText(fixture.dockerLog).length;

  const rejected = deployAutomatically(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /managed database schema baseline is missing/i);
  assert.equal(activeReleaseId(fixture), initial.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(before), /build |stop app|run --rm|up -d/);
});

test('automatic deployment refuses initial bootstrap and any rollback input', t => {
  const fixture = createFixture(t);
  const initial = deployAutomatically(fixture, fixture.sha);
  assert.notEqual(initial.status, 0);
  assert.match(initial.stderr, /automatic deployment requires an existing verified release/i);
  assert.doesNotMatch(logText(fixture.dockerLog), /build |up -d|run --rm/);

  const withRollback = deployAutomatically(fixture, fixture.sha, { BOT_NDI_ROLLBACK_SHA: fixture.sha });
  assert.notEqual(withRollback.status, 0);
  assert.match(withRollback.stderr, /automatic deployment provenance or rollback input/i);
  assert.doesNotMatch(logText(fixture.dockerLog), /build |up -d|run --rm/);
});

test('manual normal deployment refuses a main head that advanced before release promotion', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const before = logText(fixture.dockerLog).length;
  const staleManual = deploy(fixture, fixture.sha, {
    FAKE_MAIN_HEAD_SHA: 'b'.repeat(40), FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(staleManual.status, 0);
  assert.match(staleManual.stderr, /no longer the current main head/i);
  assert.equal(activeReleaseId(fixture), initial.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(before), /build |stop app|run --rm|up -d/);
});

test('active releases refuse pending or missing persistent database volumes before startup', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const marker = path.join(fixture.appDir, 'state', 'database-volume');

  fs.writeFileSync(marker, 'volume=bot-ndi_mysql_data\nstate=pending\n');
  let before = logText(fixture.dockerLog).length;
  let rejected = deployAutomatically(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /active release requires a ready persistent MySQL volume marker/i);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(before), /build |stop app|run --rm|up -d/);

  fs.writeFileSync(marker, 'volume=bot-ndi_mysql_data\nstate=ready\n');
  before = logText(fixture.dockerLog).length;
  rejected = deployAutomatically(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'false' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /persistent MySQL volume is missing/i);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(before), /build |stop app|run --rm|up -d/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'volume=bot-ndi_mysql_data\nstate=ready\n');
});

test('malformed previous-release state blocks a schema deployment before build or migration', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  fixture.sha = commitSource(fixture, undefined, { migrationContent: '-- operator-reviewed schema update\n' });
  fs.mkdirSync(path.join(fixture.appDir, 'previous-release'));
  const before = logText(fixture.dockerLog).length;

  const rejected = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /previous-release pointer is not a regular file/i);
  assert.equal(activeReleaseId(fixture), initial.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(before), /build |stop app|run --rm|up -d/);
});

test('a delayed older automatic deployment cannot replace the newer verified main release', t => {
  const fixture = createFixture(t);
  const initial = deploy(fixture, fixture.sha);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const initialReleaseId = initial.deploymentId;

  const olderSha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const newerSha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: "newer" };\n' });
  const newer = deployAutomatically(fixture, newerSha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(newer.status, 0, newer.stderr || newer.stdout);
  assert.equal(activeReleaseId(fixture), newer.deploymentId);

  runGit(fixture.workspace, ['reset', '--hard', olderSha]);
  fixture.sha = olderSha;
  const beforeDelayed = logText(fixture.dockerLog).length;
  const delayedOlder = deployAutomatically(fixture, olderSha, {
    FAKE_MAIN_HEAD_SHA: newerSha, FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(delayedOlder.status, 0);
  assert.match(delayedOlder.stderr, /no longer the current main head/i);
  assert.equal(activeReleaseId(fixture), newer.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), initialReleaseId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(beforeDelayed), /build |stop app|run --rm|up -d/);
});

test('manual rollback reuses a retained verified local image without rebuilding or migrating', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const previousSha = fixture.sha;
  const previousReleaseId = first.deploymentId;

  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# current release\n', { migrationContent: '-- schema generation B\n' });
  const current = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(current.status, 0, current.stderr || current.stdout);
  const currentSha = fixture.sha;
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-baseline'), 'utf8').trim(), currentSha);
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
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-baseline'), 'utf8').trim(), currentSha);

  const beforeQueuedAutomatic = logText(fixture.dockerLog).length;
  const queuedAutomatic = deployAutomatically(fixture, currentSha, {
    FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(queuedAutomatic.status, 0);
  assert.match(queuedAutomatic.stderr, /operator-requested rollback|blocked after an operator rollback/i);
  assert.equal(fs.readlinkSync(path.join(fixture.appDir, 'active')), `releases/${previousReleaseId}`);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), current.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(beforeQueuedAutomatic), /build |stop app|run --rm|up -d/);

  fixture.sha = commitSource(fixture, undefined, {
    dockerContent: 'FROM node:22-bookworm-slim\n# current release\n',
    runtimeContent: 'module.exports = { appFixture: "reverted schema" };\n',
  });
  const beforeSchemaRevert = logText(fixture.dockerLog).length;
  const schemaRevert = deployAutomatically(fixture, fixture.sha, {
    FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true',
  });
  assert.notEqual(schemaRevert.status, 0);
  assert.match(schemaRevert.stderr, /database migration or startup execution surface changed/i);
  assert.equal(activeReleaseId(fixture), previousReleaseId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'database-schema-baseline'), 'utf8').trim(), currentSha);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(beforeSchemaRevert), /build |stop app|run --rm|up -d/);

  const rollbackCommands = logText(fixture.dockerLog).slice(logBeforeRollback);
  assert.match(rollbackCommands, new RegExp(`/releases/${previousReleaseId}/compose\\.yaml up -d --no-deps --wait --wait-timeout 120 app`));
  assert.match(rollbackCommands, /ps -q db/);
  assert.doesNotMatch(rollbackCommands, /up -d --wait --wait-timeout 120 db/);
  assert.doesNotMatch(rollbackCommands, /build |npm run migrate|docker pull|image rm|image prune|down -v/i);
});

test('a rollback dispatched from current main holds that main SHA against a queued automatic rollout', t => {
  const fixture = createFixture(t);
  const releaseA = deploy(fixture, fixture.sha);
  assert.equal(releaseA.status, 0, releaseA.stderr || releaseA.stdout);
  const shaA = fixture.sha;

  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: "B" };\n' });
  const releaseB = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(releaseB.status, 0, releaseB.stderr || releaseB.stdout);

  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: "C" };\n' });
  const shaC = fixture.sha;
  const rollbackLogOffset = logText(fixture.dockerLog).length;
  const rollback = deploy(fixture, shaC, {
    BOT_NDI_ROLLBACK_SHA: shaA,
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
  });
  assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
  assert.equal(activeReleaseId(fixture), releaseA.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), releaseB.deploymentId);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'state', 'automatic-deployment-hold'), 'utf8').trim(), shaC);
  const rollbackCommands = logText(fixture.dockerLog).slice(rollbackLogOffset);
  assert.match(rollbackCommands, /ps -q db/);
  assert.doesNotMatch(rollbackCommands, /up -d --wait --wait-timeout 120 db/);

  const beforeQueuedAutomatic = logText(fixture.dockerLog).length;
  const queuedAutomatic = deployAutomatically(fixture, shaC, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.notEqual(queuedAutomatic.status, 0);
  assert.match(queuedAutomatic.stderr, /operator-requested rollback for this main commit/i);
  assert.equal(activeReleaseId(fixture), releaseA.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(beforeQueuedAutomatic), /build |stop app|run --rm|up -d/);
});

test('manual rollback refuses to proceed when the existing database container is unhealthy', t => {
  const fixture = createFixture(t);
  const releaseA = deploy(fixture, fixture.sha);
  assert.equal(releaseA.status, 0, releaseA.stderr || releaseA.stdout);
  const shaA = fixture.sha;
  fixture.sha = commitSource(fixture, undefined, { runtimeContent: 'module.exports = { appFixture: false };\n' });
  const releaseB = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(releaseB.status, 0, releaseB.stderr || releaseB.stdout);
  const before = logText(fixture.dockerLog).length;

  const rollback = deploy(fixture, fixture.sha, {
    BOT_NDI_ROLLBACK_SHA: shaA,
    FAKE_APP_RUNNING: 'true',
    FAKE_VOLUME_EXISTS: 'true',
    FAKE_DB_HEALTH: 'unhealthy',
  });
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.stderr, /healthy existing MySQL container/i);
  assert.equal(activeReleaseId(fixture), releaseB.deploymentId);
  assert.doesNotMatch(logText(fixture.dockerLog).slice(before), /stop app| up -d /);
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
