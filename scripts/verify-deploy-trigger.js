'use strict';

const { appendFileSync, readFileSync } = require('node:fs');

const REPOSITORY = 'Nusa-Data-Indonesia/bot-ndi';
const CI_WORKFLOW_NAME = 'CI';
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const MAIN_REF = 'refs/heads/main';
const FULL_SHA = /^[a-f0-9]{40}$/;
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;

function refuse(message) {
  throw new Error(message);
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

async function requestJson(path, token, fetchImpl) {
  try {
    const response = await fetchImpl(`${API_ROOT}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bot-ndi-deployment-preflight',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response?.ok) refuse('GitHub release verification failed.');
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('GitHub release verification failed.');
    return value;
  } catch {
    refuse('GitHub release verification failed.');
  }
}

function validateRepository(repository, payload) {
  if (repository !== REPOSITORY || payload?.repository?.full_name !== REPOSITORY) {
    refuse('Deployment is limited to the Bot NDI repository.');
  }
}

function validateCiWorkflow(workflow) {
  if (!workflow || !positiveInteger(workflow.id)
      || workflow.name !== CI_WORKFLOW_NAME
      || workflow.path !== CI_WORKFLOW_PATH
      || workflow.state !== 'active') {
    refuse('The trusted CI workflow could not be verified.');
  }
}

function validateSuccessfulPushRun(run, workflow, expectedSha) {
  const runWorkflowPath = typeof run?.path === 'string' ? run.path.split('@', 1)[0] : '';
  if (!run || !positiveInteger(run.id) || !positiveInteger(run.run_attempt)
      || String(run.workflow_id) !== String(workflow.id)
      || run.name !== CI_WORKFLOW_NAME || runWorkflowPath !== CI_WORKFLOW_PATH
      || run.event !== 'push' || run.head_branch !== 'main'
      || run.status !== 'completed' || run.conclusion !== 'success'
      || run.head_sha !== expectedSha || !FULL_SHA.test(run.head_sha)
      || run.repository?.full_name !== REPOSITORY
      || run.head_repository?.full_name !== REPOSITORY) {
    refuse('A successful trusted CI push for the current main commit is required.');
  }
}

function validatePayloadRunMatchesApi(payloadRun, verifiedRun) {
  const matchedFields = ['id', 'workflow_id', 'run_attempt', 'head_sha', 'head_branch', 'event', 'status', 'conclusion'];
  for (const field of matchedFields) {
    if (payloadRun[field] === undefined || payloadRun[field] === null ||
        String(payloadRun[field]) !== String(verifiedRun[field])) {
      refuse('The workflow_run payload does not match GitHub workflow metadata.');
    }
  }
  if (payloadRun.repository?.full_name !== verifiedRun.repository?.full_name ||
      payloadRun.head_repository?.full_name !== verifiedRun.head_repository?.full_name) {
    refuse('The workflow_run payload does not match GitHub workflow metadata.');
  }
}

async function verifyMainHead(expectedSha, token, fetchImpl) {
  const ref = await requestJson('/git/ref/heads/main', token, fetchImpl);
  const headSha = ref.object?.sha;
  if (!FULL_SHA.test(headSha || '') || headSha !== expectedSha) {
    refuse('The release commit is no longer the latest main head.');
  }
}

async function verifyAutomaticRun({ ref, payload, token, fetchImpl }) {
  if (ref !== MAIN_REF || payload?.action !== 'completed') {
    refuse('Automatic deployment requires a completed main workflow run.');
  }
  const payloadRun = payload.workflow_run;
  if (!positiveInteger(payloadRun?.id) || !positiveInteger(payloadRun?.workflow_id)
      || !positiveInteger(payloadRun?.run_attempt)
      || !FULL_SHA.test(payloadRun?.head_sha || '')) {
    refuse('The workflow_run payload is incomplete.');
  }

  const run = await requestJson(`/actions/runs/${payloadRun.id}`, token, fetchImpl);
  validatePayloadRunMatchesApi(payloadRun, run);
  validateSuccessfulPushRun(run, { id: payloadRun.workflow_id }, payloadRun.head_sha);

  const workflow = await requestJson(`/actions/workflows/${run.workflow_id}`, token, fetchImpl);
  validateCiWorkflow(workflow);
  if (String(workflow.id) !== String(run.workflow_id)) refuse('The CI workflow identity does not match its run.');
  await verifyMainHead(run.head_sha, token, fetchImpl);

  return {
    deploymentMode: 'automatic',
    commitSha: run.head_sha,
    ciRunId: String(run.id),
    ciRunAttempt: String(run.run_attempt),
    ciWorkflowId: String(workflow.id),
  };
}

async function verifyManualDispatch({ ref, sha, payload, token, fetchImpl }) {
  if (ref !== MAIN_REF || !FULL_SHA.test(sha || '')) {
    refuse('Manual deployment requires a full main-branch commit SHA.');
  }

  const workflow = await requestJson('/actions/workflows/ci.yml', token, fetchImpl);
  validateCiWorkflow(workflow);
  const query = new URLSearchParams({
    branch: 'main', event: 'push', head_sha: sha, status: 'completed',
    per_page: '100',
  });
  const runs = await requestJson(`/actions/workflows/${workflow.id}/runs?${query}`, token, fetchImpl);
  if (!Array.isArray(runs.workflow_runs)) refuse('The successful CI run could not be verified.');
  const candidates = runs.workflow_runs
    .filter((run) => run?.head_sha === sha)
    .sort((left, right) => {
      const timeDifference = Date.parse(right.created_at || '') - Date.parse(left.created_at || '');
      return (Number.isFinite(timeDifference) ? timeDifference : 0)
        || Number(right.run_number || 0) - Number(left.run_number || 0)
        || Number(right.run_attempt || 0) - Number(left.run_attempt || 0);
    });
  const candidate = candidates[0];
  if (!candidate || !positiveInteger(candidate.id)) refuse('The successful CI run could not be verified.');

  const run = await requestJson(`/actions/runs/${candidate.id}`, token, fetchImpl);
  validateSuccessfulPushRun(run, workflow, sha);
  await verifyMainHead(sha, token, fetchImpl);

  return {
    deploymentMode: 'manual',
    commitSha: run.head_sha,
    ciRunId: String(run.id),
    ciRunAttempt: String(run.run_attempt),
    ciWorkflowId: String(workflow.id),
  };
}

async function verifyDeployTrigger({ eventName, ref, repository, sha, payload, token, fetchImpl = fetch }) {
  validateRepository(repository, payload);
  if (!token) refuse('GitHub release verification credentials are missing.');

  if (eventName === 'workflow_run') {
    return verifyAutomaticRun({ ref, payload, token, fetchImpl });
  }
  if (eventName === 'workflow_dispatch') {
    return verifyManualDispatch({ ref, sha, payload, token, fetchImpl });
  }
  refuse('Only verified CI completion or manual main-branch dispatch can deploy.');
}

function writeOutput(path, values) {
  if (!path) refuse('GitHub Actions output file is unavailable.');
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) refuse('The verified release output is invalid.');
    appendFileSync(path, `${name}=${value}\n`);
  }
}

async function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); }
  catch { refuse('The GitHub event payload is unavailable or invalid.'); }

  const verified = await verifyDeployTrigger({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    payload,
    token: process.env.RELEASE_GITHUB_TOKEN,
  });
  writeOutput(process.env.GITHUB_OUTPUT, {
    deployment_mode: verified.deploymentMode,
    commit_sha: verified.commitSha,
    ci_run_id: verified.ciRunId,
    ci_run_attempt: verified.ciRunAttempt,
    ci_workflow_id: verified.ciWorkflowId,
  });
  process.stdout.write(`Verified ${verified.deploymentMode} release against CI run ${verified.ciRunId}.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = /^[A-Za-z0-9_. -]{1,160}$/.test(error?.message || '') ? error.message : 'GitHub release verification failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { verifyDeployTrigger };
