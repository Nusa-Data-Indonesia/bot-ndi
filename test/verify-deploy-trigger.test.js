'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyDeployTrigger } = require('../scripts/verify-deploy-trigger');

const repository = 'Nusa-Data-Indonesia/bot-ndi';
const sha = 'a'.repeat(40);
const liveSha = sha;
const workflow = { id: 42, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };
const run = {
  id: 123, name: 'CI', workflow_id: 42, path: '.github/workflows/ci.yml@refs/heads/main',
  run_number: 10, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success',
  repository: { full_name: repository }, head_repository: { full_name: repository }, pull_requests: [],
};

function response(value, ok = true) {
  return { ok, json: async () => value };
}

function payloadFor(value = run) {
  return {
    action: 'completed',
    repository: { full_name: repository },
    workflow_run: {
      ...Object.fromEntries(['id', 'workflow_id', 'run_attempt', 'head_sha', 'head_branch', 'event', 'status', 'conclusion'].map(key => [key, value[key]])),
      repository: value.repository,
      head_repository: value.head_repository,
    },
  };
}

function apiMock({ workflowValue = workflow, runValue = run, headSha = liveSha, listedRuns } = {}) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/actions/workflows/ci.yml')) return response(workflowValue);
    if (pathname.endsWith(`/actions/workflows/${workflow.id}`)) return response(workflowValue);
    if (pathname.endsWith(`/actions/runs/${run.id}`)) return response(runValue);
    if (pathname.endsWith(`/actions/workflows/${workflow.id}/runs`)) {
      return response({ workflow_runs: listedRuns || [run] });
    }
    if (pathname.endsWith('/git/ref/heads/main')) return response({ object: { sha: headSha } });
    throw new Error('unexpected mock API request');
  };
  return { calls, fetchImpl };
}

function automaticOptions(overrides = {}) {
  return {
    eventName: 'workflow_run', ref: 'refs/heads/main', repository,
    sha: 'f'.repeat(40), payload: payloadFor(), token: 'test-only-token',
    ...overrides,
  };
}

test('successful trusted push CI on latest main resolves its own SHA, not workflow_run GITHUB_SHA', async () => {
  const api = apiMock();
  const result = await verifyDeployTrigger({ ...automaticOptions(), fetchImpl: api.fetchImpl });
  assert.deepEqual(result, {
    deploymentMode: 'automatic', commitSha: sha, ciRunId: '123', ciRunAttempt: '2', ciWorkflowId: '42',
  });
  assert.notEqual(result.commitSha, 'f'.repeat(40));
  assert.deepEqual(api.calls.map(call => new URL(call.url).pathname), [
    '/repos/Nusa-Data-Indonesia/bot-ndi/actions/runs/123',
    '/repos/Nusa-Data-Indonesia/bot-ndi/actions/workflows/42',
    '/repos/Nusa-Data-Indonesia/bot-ndi/git/ref/heads/main',
  ]);
  assert.ok(api.calls.every(call => call.request.headers.Authorization === 'Bearer test-only-token'));
});

test('trusted push CI remains deployable when GitHub associates it with a merged pull request', async () => {
  const mergedPrRun = { ...run, pull_requests: [{ number: 8, head: { ref: 'feature', sha: sha }, base: { ref: 'main' } }] };
  const result = await verifyDeployTrigger({
    ...automaticOptions({ payload: payloadFor(mergedPrRun) }),
    fetchImpl: apiMock({ runValue: mergedPrRun }).fetchImpl,
  });
  assert.equal(result.commitSha, sha);
});

test('failed, cancelled, skipped, pull-request, and fork CI runs are refused', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    const failedRun = { ...run, conclusion };
    await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ payload: payloadFor(failedRun) }), fetchImpl: apiMock({ runValue: failedRun }).fetchImpl }), /successful trusted CI push/);
  }
  const pullRequest = { ...run, event: 'pull_request' };
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ payload: payloadFor(pullRequest) }), fetchImpl: apiMock({ runValue: pullRequest }).fetchImpl }), /successful trusted CI push/);
  const forkRun = { ...run, head_repository: { full_name: 'contributor/bot-ndi' } };
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ payload: payloadFor(forkRun) }), fetchImpl: apiMock({ runValue: forkRun }).fetchImpl }), /successful trusted CI push/);
});

test('automatic verification rejects wrong branch, repository, payload SHA, and CI workflow identity', async () => {
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ ref: 'refs/heads/release' }), fetchImpl: apiMock().fetchImpl }), /completed main workflow/);
  const wrongRepositoryApi = apiMock();
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ repository: 'fork/bot-ndi' }), fetchImpl: wrongRepositoryApi.fetchImpl }), /Bot NDI repository/);
  assert.equal(wrongRepositoryApi.calls.length, 0);

  const changedPayload = payloadFor(); changedPayload.workflow_run.head_sha = 'b'.repeat(40);
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ payload: changedPayload }), fetchImpl: apiMock().fetchImpl }), /payload does not match/);
  const missingAttempt = payloadFor(); delete missingAttempt.workflow_run.run_attempt;
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ payload: missingAttempt }), fetchImpl: apiMock().fetchImpl }), /payload is incomplete/);
  const mismatchedRepository = payloadFor(); mismatchedRepository.workflow_run.head_repository = { full_name: 'contributor/bot-ndi' };
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions({ payload: mismatchedRepository }), fetchImpl: apiMock().fetchImpl }), /payload does not match/);

  const wrongWorkflow = { ...workflow, path: '.github/workflows/untrusted.yml' };
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions(), fetchImpl: apiMock({ workflowValue: wrongWorkflow }).fetchImpl }), /trusted CI workflow/);
});

test('automatic verification refuses a run whose SHA is no longer the main head', async () => {
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions(), fetchImpl: apiMock({ headSha: 'b'.repeat(40) }).fetchImpl }), /no longer the latest main head/);
});

test('automatic verification fails closed when GitHub metadata is unavailable', async () => {
  await assert.rejects(verifyDeployTrigger({ ...automaticOptions(), fetchImpl: async () => response({}, false) }), /GitHub release verification failed/);
});

test('manual deployment still requires a successful push CI for current main', async () => {
  const api = apiMock();
  const result = await verifyDeployTrigger({
    eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository, sha,
    payload: { repository: { full_name: repository } }, token: 'test-only-token', fetchImpl: api.fetchImpl,
  });
  assert.deepEqual(result, {
    deploymentMode: 'manual', commitSha: sha, ciRunId: '123', ciRunAttempt: '2', ciWorkflowId: '42',
  });
  assert.match(api.calls[1].url, /branch=main.*event=push.*head_sha=/);
  assert.doesNotMatch(api.calls[1].url, /exclude_pull_requests=true/);
});

test('manual deployment rejects missing successful CI, stale SHA, and non-main dispatch', async () => {
  const failedRun = { ...run, conclusion: 'failure' };
  await assert.rejects(verifyDeployTrigger({
    eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository, sha,
    payload: { repository: { full_name: repository } }, token: 'test-only-token',
    fetchImpl: apiMock({ runValue: failedRun, listedRuns: [failedRun] }).fetchImpl,
  }), /successful trusted CI push/);
  await assert.rejects(verifyDeployTrigger({
    eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository, sha,
    payload: { repository: { full_name: repository } }, token: 'test-only-token',
    fetchImpl: apiMock({ headSha: 'b'.repeat(40) }).fetchImpl,
  }), /no longer the latest main head/);
  await assert.rejects(verifyDeployTrigger({
    eventName: 'workflow_dispatch', ref: 'refs/heads/feature', repository, sha,
    payload: { repository: { full_name: repository } }, token: 'test-only-token', fetchImpl: apiMock().fetchImpl,
  }), /full main-branch/);
});
