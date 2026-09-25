import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const guides = ['docs/AKS.md', 'docs/ACR-CI.md', 'docs/AKS-AUTH.md'];

function blocks(text, language) {
  return [...text.matchAll(/^([ \t]*)```(\w+)\n([\s\S]*?)^\1```/gm)]
    .filter((match) => match[2] === language)
    .map((match) =>
      match[3]
        .split('\n')
        .map((line) =>
          line.startsWith(match[1]) ? line.slice(match[1].length) : line,
        )
        .join('\n'),
    );
}

test('shared deployment guides contain valid Bash and no literal deployment IDs', () => {
  for (const guide of guides) {
    const text = readFileSync(path.join(root, guide), 'utf8');
    assert.doesNotMatch(
      text,
      /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i,
    );
    assert.doesNotMatch(text, /@sha256:[0-9a-f]{64}/);
    for (const block of blocks(text, 'bash')) {
      const result = spawnSync('bash', ['-n'], {
        input: block,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${guide}: ${result.stderr}`);
    }
  }
});

test('documented overlay generator supports another registry, namespace and both deployment profiles', (t) => {
  const azure = path.join(root, '.azure');
  mkdirSync(azure, { recursive: true });
  const directory = mkdtempSync(path.join(azure, 'guide-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = blocks(
    readFileSync(path.join(root, 'docs/AKS.md'), 'utf8'),
    'python',
  )[0];
  assert.ok(script);
  for (const [regional, calgary] of [
    ['false', 'false'],
    ['true', 'false'],
    ['true', 'true'],
  ]) {
    const result = spawnSync('python3', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        AKS_OVERLAY_DIR: directory,
        NAMESPACE: 'another-namespace',
        ACR_LOGIN_SERVER: 'exampleacr.azurecr.io',
        APP_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        REGIONAL_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
        USE_AUSTIN_EXAMPLE: regional,
        USE_CALGARY_EXAMPLE: calgary,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const overlay = JSON.parse(
      readFileSync(path.join(directory, 'kustomization.yaml'), 'utf8'),
    );
    assert.equal(overlay.namespace, 'another-namespace');
    assert.equal(overlay.images.length, regional === 'true' ? 2 : 1);
    assert.equal(
      overlay.images[0].newName,
      'exampleacr.azurecr.io/gods-eye-view',
    );
    assert.equal(
      path.resolve(directory, overlay.resources[0]),
      path.join(
        root,
        calgary === 'true'
          ? 'infra/aks/calgary'
          : regional === 'true'
            ? 'infra/aks/regional'
            : 'infra/aks',
      ),
    );
  }
});
