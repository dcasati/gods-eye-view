import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const assemble = path.join(root, 'scripts/ci/assemble-source.sh');
const validate = path.join(root, 'scripts/ci/validate-publish.sh');
const canonical = 'https://github.com/bilawalsidhu/gods-eye-view.git';
const exclusions = '**/.env\n**/.env.*\n**/ENVIRONMENT\n**/*.pem\n**/*.key\n';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const directory = mkdtempSync(path.join(root, '.acr-ci-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = path.join(directory, 'upstream');
  const downstream = path.join(directory, 'downstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-b', 'main');
  git(upstream, 'config', 'user.name', 'CI test');
  git(upstream, 'config', 'user.email', 'ci@example.invalid');
  writeFileSync(path.join(upstream, 'app.txt'), 'base\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'base');
  git(directory, 'clone', upstream, downstream);
  git(downstream, 'config', 'user.name', 'CI test');
  git(downstream, 'config', 'user.email', 'ci@example.invalid');
  // Tests redirect only the fixed canonical URL to their local Git fixture.
  git(downstream, 'config', `url.${upstream}.insteadOf`, canonical);
  writeFileSync(path.join(downstream, '.dockerignore'), exclusions);
  writeFileSync(path.join(downstream, 'downstream.txt'), 'production patch\n');
  git(downstream, 'add', '.');
  git(downstream, 'commit', '-m', 'downstream additions');
  const output = path.join(directory, 'output');
  return {
    upstream,
    downstream,
    output,
    run: () =>
      spawnSync('bash', [assemble], {
        cwd: downstream,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_OUTPUT: output,
        },
      }),
  };
}

test('assembly merges newest upstream while retaining downstream additions and both SHAs', (t) => {
  const f = fixture(t);
  const downstreamSha = git(f.downstream, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.upstream, 'app.txt'), 'latest upstream\n');
  git(f.upstream, 'commit', '-am', 'upstream update');
  const upstreamSha = git(f.upstream, 'rev-parse', 'HEAD');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(path.join(f.downstream, 'app.txt'), 'utf8'),
    'latest upstream\n',
  );
  assert.equal(
    readFileSync(path.join(f.downstream, 'downstream.txt'), 'utf8'),
    'production patch\n',
  );
  assert.equal(
    readFileSync(f.output, 'utf8'),
    `downstream=${downstreamSha}\nupstream=${upstreamSha}\ntag=run-123-2-${downstreamSha.slice(0, 12)}-${upstreamSha.slice(0, 12)}\n`,
  );
  assert.equal(git(f.downstream, 'rev-parse', 'HEAD'), downstreamSha);
});

test('conflicting upstream fails explicitly and restores downstream patch', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.downstream, 'app.txt'), 'downstream fix\n');
  git(f.downstream, 'commit', '-am', 'downstream fix');
  writeFileSync(path.join(f.upstream, 'app.txt'), 'conflicting upstream\n');
  git(f.upstream, 'commit', '-am', 'upstream conflict');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicts with downstream patches/);
  assert.equal(
    readFileSync(path.join(f.downstream, 'app.txt'), 'utf8'),
    'downstream fix\n',
  );
  assert.equal(git(f.downstream, 'status', '--porcelain'), '');
});

test('assembly refuses dirty worktrees and missing secret exclusions', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.downstream, '.dockerignore'), '');
  assert.match(f.run().stderr, /requires a clean downstream checkout/);
  git(f.downstream, 'commit', '-am', 'remove exclusion');
  assert.match(f.run().stderr, /Required Docker secret exclusion is missing/);
});

test('publisher accepts only expected main identity, target, and unique run tag', () => {
  const sha = 'a'.repeat(40);
  const uuid = '00000000-0000-0000-0000-000000000001';
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'dcasati/gods-eye-view',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: sha,
    DOWNSTREAM_SHA: sha,
    UPSTREAM_SHA: sha,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    IMAGE_TAG: `run-123-2-${sha.slice(0, 12)}-${sha.slice(0, 12)}`,
    ACR_NAME: 'acrmiracaldova',
    ACR_LOGIN_SERVER: 'acrmiracaldova.azurecr.io',
    IMAGE_NAME: 'gods-eye-view',
    AZURE_CLIENT_ID: uuid,
    AZURE_TENANT_ID: uuid,
    AZURE_SUBSCRIPTION_ID: uuid,
  };
  const run = (overrides = {}) =>
    spawnSync('bash', [validate], {
      cwd: root,
      encoding: 'utf8',
      env: { ...env, ...overrides },
    });
  assert.equal(run().status, 0);
  for (const overrides of [
    { GITHUB_REPOSITORY: 'attacker/fork' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { AZURE_CLIENT_ID: '' },
    { AZURE_SUBSCRIPTION_ID: 'invalid' },
    { ACR_LOGIN_SERVER: 'attacker.azurecr.io' },
    { ACR_NAME: 'other' },
    { IMAGE_NAME: 'other' },
    { IMAGE_TAG: 'latest' },
    { DOWNSTREAM_SHA: 'b'.repeat(40) },
    { UPSTREAM_SHA: 'not-a-sha' },
    { GITHUB_RUN_ATTEMPT: '3' },
  ]) {
    assert.notEqual(run(overrides).status, 0, JSON.stringify(overrides));
  }
});

test('publication streams credentials privately, locks the version tag, and records digest proof', (t) => {
  const directory = mkdtempSync(path.join(root, '.acr-ci-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'bin'));
  mkdirSync(path.join(directory, 'scripts/ci'), { recursive: true });
  copyFileSync(
    validate,
    path.join(directory, 'scripts/ci/validate-publish.sh'),
  );
  const sha = 'a'.repeat(40);
  const digest = `sha256:${'b'.repeat(64)}`;
  const uuid = '00000000-0000-0000-0000-000000000001';
  const tag = `run-123-2-${sha.slice(0, 12)}-${sha.slice(0, 12)}`;
  const log = path.join(directory, 'commands');
  const summary = path.join(directory, 'summary');
  const mocks = {
    az: `#!/usr/bin/env bash
set -euo pipefail
printf 'az %s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  'acr login --name acrmiracaldova --expose-token --query accessToken --output tsv') printf 'secret-fixture-token\\n' ;;
  'acr repository show --name acrmiracaldova --image gods-eye-view:'*' --query digest --output tsv'|'acr repository show --name acrmiracaldova --image overpass-austin:'*' --query digest --output tsv') printf '%s\\n' "$TEST_DIGEST" ;;
  'acr repository update --name acrmiracaldova --image gods-eye-view:'*' --write-enabled false --delete-enabled false --output none'|'acr repository update --name acrmiracaldova --image overpass-austin:'*' --write-enabled false --delete-enabled false --output none') ;;
  *) exit 99 ;;
esac
`,
    docker: `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
case "$1" in
  image) printf '%s\\n' "$DOWNSTREAM_SHA" ;;
  login) IFS= read -r token; [[ "$token" == 'secret-fixture-token' ]] ;;
  tag|push) ;;
  *) exit 99 ;;
esac
`,
  };
  for (const [name, content] of Object.entries(mocks)) {
    const file = path.join(directory, 'bin', name);
    writeFileSync(file, content);
    chmodSync(file, 0o755);
  }
  const result = spawnSync(
    'bash',
    [path.join(root, 'scripts/ci/publish-image.sh')],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: 'dcasati/gods-eye-view',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_SHA: sha,
        DOWNSTREAM_SHA: sha,
        UPSTREAM_SHA: sha,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        IMAGE_TAG: tag,
        ACR_NAME: 'acrmiracaldova',
        ACR_LOGIN_SERVER: 'acrmiracaldova.azurecr.io',
        IMAGE_NAME: 'gods-eye-view',
        AZURE_CLIENT_ID: uuid,
        AZURE_TENANT_ID: uuid,
        AZURE_SUBSCRIPTION_ID: uuid,
        COMMAND_LOG: log,
        TEST_DIGEST: digest,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (result.stdout + result.stderr).includes('secret-fixture-token'),
    false,
  );
  const commands = readFileSync(log, 'utf8');
  assert.match(
    commands,
    /docker login acrmiracaldova.azurecr.io --username 00000000-0000-0000-0000-000000000000 --password-stdin/,
  );
  assert.match(commands, /--write-enabled false --delete-enabled false/);
  assert.equal(commands.includes('secret-fixture-token'), false);
  const receipt = JSON.parse(
    readFileSync(path.join(directory, '.ci-output/publication.json'), 'utf8'),
  );
  assert.equal(receipt.image, `acrmiracaldova.azurecr.io/gods-eye-view:${tag}`);
  assert.equal(receipt.digest, digest);
  assert.equal(receipt.downstream, sha);
  assert.equal(receipt.upstream, sha);
  const regionalReceipt = JSON.parse(
    readFileSync(
      path.join(directory, '.ci-output/publication-overpass.json'),
      'utf8',
    ),
  );
  assert.equal(
    regionalReceipt.image,
    `acrmiracaldova.azurecr.io/overpass-austin:${tag}`,
  );
  assert.equal(
    regionalReceipt.pullReference,
    `acrmiracaldova.azurecr.io/overpass-austin@${digest}`,
  );
  assert.equal(regionalReceipt.downstream, sha);
  assert.equal(regionalReceipt.upstream, sha);
  assert.equal((commands.match(/^docker push /gm) || []).length, 2);
  assert.equal(
    (commands.match(/--write-enabled false --delete-enabled false/g) || [])
      .length,
    2,
  );
  assert.match(
    readFileSync(summary, 'utf8'),
    /No AKS deployment was performed/,
  );
});
