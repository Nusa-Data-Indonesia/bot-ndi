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
const verifier = fs.readFileSync(path.join(root, 'scripts/verify-deploy-trigger.js'), 'utf8');

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

test('automatic deployment waits for completed CI workflow runs on main and preserves manual dispatch', () => {
  assert.match(deployWorkflow, /^on:\s*$/m);
  assert.match(deployWorkflow, /workflow_run:\s*\n\s+workflows:\s*\[CI\]\s*\n\s+types:\s*\[completed\]\s*\n\s+branches:\s*\[main\]/);
  assert.match(deployWorkflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+rollback_sha:/);
  assert.doesNotMatch(deployWorkflow, /^\s+(push|pull_request|pull_request_target|schedule):/m);
  assert.match(validationJob, /runs-on:\s*ubuntu-latest/);
  assert.match(validationJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(validationJob, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(validationJob, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(validationJob, /github\.event\.workflow_run\.status == 'completed'/);
  assert.match(validationJob, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(validationJob, /github\.event\.workflow_run\.head_repository\.full_name == 'Nusa-Data-Indonesia\/bot-ndi'/);
  assert.match(validationJob, /ref:\s*\$\{\{\s*github\.workflow_sha\s*\}\}/);
  assert.match(validationJob, /node scripts\/verify-deploy-trigger\.js/);
  assert.match(validationJob, /RELEASE_GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(validationJob, /outputs:\s*\n\s+deployment_mode:/);
  for (const output of ['commit_sha', 'ci_run_id', 'ci_run_attempt', 'ci_workflow_id']) {
    assert.match(validationJob, new RegExp(`${output}: \\$\\{\\{ steps\\.validate\\.outputs\\.${output} \\}\\}`));
  }
  assert.match(deployJob, /needs: validate_release/);
  assert.match(deployJob, /needs\.validate_release\.result == 'success'/);
  assert.match(deployJob, /needs\.validate_release\.outputs\.commit_sha != ''/);
  assert.match(deployJob, /github\.repository == 'Nusa-Data-Indonesia\/bot-ndi'/);
  assert.match(deployJob, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(deployJob, /commit_sha\s*==\s*github\.sha|BOT_NDI_COMMIT_SHA:\s*\$\{\{\s*github\.sha/);
  assert.match(deployJob, /runs-on:\s*\[self-hosted, linux, x64, bot-ndi\]/);
  assert.match(deployJob, /environment:\s*\n\s+name:\s*production/);
  assert.match(deployWorkflow, /actions:\s*read\s*\n\s+contents:\s*read/);
  assert.match(deployJob, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(deployJob, /actions:\s*read/);
});

test('verified trigger rejects untrusted or stale CI provenance before deployment runner selection', () => {
  assert.match(verifier, /const REPOSITORY = 'Nusa-Data-Indonesia\/bot-ndi'/);
  assert.match(verifier, /const CI_WORKFLOW_PATH = '\.github\/workflows\/ci\.yml'/);
  assert.match(verifier, /run\.event !== 'push'/);
  assert.match(verifier, /run\.head_branch !== 'main'/);
  assert.match(verifier, /run\.status !== 'completed'/);
  assert.match(verifier, /run\.conclusion !== 'success'/);
  assert.match(verifier, /run\.head_repository\?\.full_name !== REPOSITORY/);
  assert.match(verifier, /await verifyMainHead\(run\.head_sha/);
  assert.match(verifier, /deploymentMode: 'automatic'/);
  assert.match(verifier, /deploymentMode: 'manual'/);
  assert.match(verifier, /CI_WORKFLOW_NAME = 'CI'/);
  assert.match(verifier, /workflow\.path !== CI_WORKFLOW_PATH/);
  assert.match(verifier, /workflow\.state !== 'active'/);
  assert.doesNotMatch(verifier, /process\.env\.GITHUB_SHA\s*,?\s*\/\/.{0,40}commit/i);
  assert.match(deployJob, /ref:\s*\$\{\{\s*needs\.validate_release\.outputs\.commit_sha\s*\}\}/);
  assert.match(deployJob, /fetch-depth:\s*0/);
  assert.match(deployJob, /persist-credentials:\s*false/);
  assert.doesNotMatch(deployWorkflow, /download-artifact|upload-artifact|pull_request_target/);
});

test('deployment is serialized, rechecks latest main, and supports manually selected rollback', () => {
  assert.match(deployJob, /group:\s*bot-ndi-production/);
  assert.match(deployJob, /queue:\s*max/);
  assert.match(deployJob, /cancel-in-progress:\s*false/);
  assert.match(deployJob, /RELEASE_GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(deployJob, /node scripts\/check-release-head\.js/);
  assert.match(deployJob, /BOT_NDI_ROLLBACK_SHA:\s*\$\{\{\s*inputs\.rollback_sha\s*\}\}/);
  assert.match(deployJob, /bash scripts\/deploy-homelab\.sh/);
  assert.match(deployJob, /BOT_NDI_COMMIT_SHA:\s*\$\{\{\s*needs\.validate_release\.outputs\.commit_sha\s*\}\}/);
  assert.match(deployScript, /DEPLOYMENT_MODE="\$\{BOT_NDI_DEPLOYMENT_MODE:-\}"/);
  assert.match(deployScript, /GITHUB_EVENT_NAME:-\}.*workflow_run/s);
  assert.match(deployScript, /-n "\$ROLLBACK_SHA"/);
  assert.match(deployScript, /check_latest_main_head/);
  assert.match(deployScript, /migrations\/ src\/migrate\.js src\/cli\.js src\/db\.js src\/config\.js package\.json package-lock\.json/);
  assert.match(deployScript, /Dockerfile compose\.yaml \.dockerignore Dockerfile\.dockerignore \.gitattributes/);
});

test('deployment keeps local build, health recovery, scheduler settings, and database volume intact', () => {
  assert.match(composeYaml, /pull_policy:\s*never/);
  assert.match(composeYaml, /image:\s*bot-ndi:\$\{BOT_NDI_IMAGE_TAG:-local\}/);
  assert.match(deployJob, /actions\/setup-node@/);
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
  assert.match(deployScript, /bot-ndi_mysql_data/);
  assert.match(deployScript, /SCHEDULER_ENABLED/);
  assert.doesNotMatch(deployScript, /down -v|docker image prune|docker image rm|docker pull|docker login|ghcr\.io/i);
});

test('active workflows and deployment scripts are independent from legacy systems and external registries', () => {
  assert.doesNotMatch(activeWorkflows, /ghcr\.io|GitHub Packages|docker login|docker pull|botmerzz|BOTMERZZ/i);
  assert.doesNotMatch(deployScript, /ghcr\.io|docker login|docker pull|botmerzz|BOTMERZZ|192\.168\.|LXC 10027/i);
  assert.match(deployScript, /DB_NAME bot_ndi/);
  assert.match(deployScript, /DB_USER bot_ndi_app/);
  assert.match(deployScript, /HOST_IP/);
});
