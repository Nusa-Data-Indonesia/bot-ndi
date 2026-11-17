'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDir = path.join(root, '.github/workflows');
const ciPath = path.join(workflowDir, 'ci.yml');
const deployPath = path.join(workflowDir, 'deploy-homelab.yml');
const composeYaml = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
const workflow = fs.readFileSync(ciPath, 'utf8');
const deployWorkflow = fs.readFileSync(deployPath, 'utf8');
const deployJob = deployWorkflow.split(/^  deploy:\s*$/m)[1] || '';
const validationJob = deployWorkflow.split(/^  validate_release:\s*$/m)[1]?.split(/^  deploy:\s*$/m)[0] || '';
const activeWorkflows = fs.readdirSync(workflowDir)
  .filter(file => /\.ya?ml$/.test(file))
  .map(file => fs.readFileSync(path.join(workflowDir, file), 'utf8'))
  .join('\n');
const deployScript = fs.readFileSync(path.join(root, 'scripts/deploy-homelab.sh'), 'utf8');

test('GitHub-hosted CI validates pull requests and main pushes with isolated MySQL', () => {
  assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /image:\s*mysql:8\.4/);
  assert.match(workflow, /MYSQL_DATABASE:\s*bot_ndi_test/);
  assert.match(workflow, /DB_HOST:\s*127\.0\.0\.1/);
  assert.match(workflow, /ALLOW_DESTRUCTIVE_DB_TESTS:\s*["']true["']/);
  assert.match(workflow, /run:\s*npm run lint/);
  assert.match(workflow, /run:\s*npm run typecheck/);
  assert.match(workflow, /run:\s*npm run check/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /run:\s*npm run test:integration/);
  assert.match(workflow, /docker build --target runtime --tag bot-ndi:ci/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(workflow, /self-hosted|workflow_run/);
});

test('deployment has only a manual trigger and validates successful main CI before selecting production runner', () => {
  assert.match(deployWorkflow, /^on:\s*\n\s+workflow_dispatch:\s*$/m);
  assert.match(deployWorkflow, /rollback_sha:/);
  assert.doesNotMatch(deployWorkflow, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(validationJob, /context\.eventName !== 'workflow_dispatch'/);
  assert.match(validationJob, /context\.ref !== 'refs\/heads\/main'/);
  assert.match(validationJob, /Nusa-Data-Indonesia\/bot-ndi/);
  assert.match(validationJob, /\.github\/workflows\/ci\.yml/);
  assert.match(validationJob, /event: 'push'/);
  assert.match(validationJob, /status: 'completed'/);
  assert.match(validationJob, /conclusion !== 'success'/);
  assert.match(validationJob, /candidate\.head_sha === context\.sha/);
  assert.match(deployJob, /needs: validate_release/);
  assert.match(deployJob, /github\.ref == 'refs\/heads\/main'/);
  assert.match(deployJob, /needs\.validate_release\.outputs\.commit_sha == github\.sha/);
  assert.match(deployJob, /runs-on:\s*\[self-hosted, linux, x64, bot-ndi\]/);
  assert.match(deployJob, /environment:\s*\n\s+name:\s*production/);
});

test('deployment is serialized and repository token permissions stay read-only', () => {
  assert.match(deployJob, /group:\s*bot-ndi-production/);
  assert.match(deployJob, /cancel-in-progress:\s*false/);
  assert.match(deployWorkflow, /permissions:\s*\n\s+actions:\s*read\s*\n\s+contents:\s*read/);
  assert.match(deployJob, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(deployWorkflow, /contents:\s*write|packages:\s*(read|write)|id-token:\s*write/);
  assert.match(deployJob, /persist-credentials:\s*false/);
});

test('deployment checks out the validated full SHA and builds a local release-ID-tagged image', () => {
  assert.match(composeYaml, /pull_policy:\s*never/);
  assert.match(composeYaml, /image:\s*bot-ndi:\$\{BOT_NDI_IMAGE_TAG:-local\}/);
  assert.match(deployJob, /ref:\s*\$\{\{\s*needs\.validate_release\.outputs\.commit_sha\s*\}\}/);
  assert.match(deployJob, /checkReleaseHead/);
  assert.match(deployJob, /RELEASE_GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(deployJob, /BOT_NDI_ROLLBACK_SHA:\s*\$\{\{\s*inputs\.rollback_sha\s*\}\}/);
  assert.match(deployJob, /bash scripts\/deploy-homelab\.sh/);
  assert.match(deployJob, /BOT_NDI_COMMIT_SHA:\s*\$\{\{\s*needs\.validate_release\.outputs\.commit_sha\s*\}\}/);
  assert.match(deployScript, /COMMIT_SHA="\$\{BOT_NDI_COMMIT_SHA:-\$\{GITHUB_SHA:-\}\}"/);
  assert.match(deployScript, /docker build/);
  assert.match(deployScript, /--build-arg "VCS_REF=\$COMMIT_SHA"/);
  assert.match(deployScript, /RELEASE_ID="\$\{COMMIT_SHA\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}"/);
  assert.match(deployScript, /--tag "bot-ndi:\$RELEASE_ID"/);
  assert.match(deployScript, /compose run --rm --no-deps app npm run migrate/);
  assert.match(deployScript, /compose up -d --wait --wait-timeout 120 db/);
  assert.match(deployScript, /health\/ready/);
  assert.match(deployScript, /rollback_to_previous_release/);
  assert.match(deployScript, /Manual rollback to retained release/);
  assert.match(deployScript, /docker image inspect/);
  assert.doesNotMatch(deployScript, /down -v|docker image prune|docker image rm|docker pull|docker login|ghcr\.io/i);
});

test('active workflows and deployment scripts are independent from BotMerzz and external registries', () => {
  assert.doesNotMatch(activeWorkflows, /ghcr\.io|GitHub Packages|docker login|docker pull|\n\s+workflow_run:|botmerzz|BOTMERZZ/i);
  assert.doesNotMatch(deployScript, /ghcr\.io|docker login|docker pull|botmerzz|BOTMERZZ|192\.168\.|LXC 10027/i);
  assert.match(deployScript, /bot-ndi_mysql_data/);
  assert.match(deployScript, /DB_NAME bot_ndi/);
  assert.match(deployScript, /DB_USER bot_ndi_app/);
  assert.match(deployScript, /HOST_IP/);
});
