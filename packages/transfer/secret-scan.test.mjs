import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFile, withSharingCheck, SCAN_LIMIT } from './secret-scan.mjs';

const file = (name, text = '') => new File([text], name);

test('sensitive filenames are flagged without exposing file contents', async () => {
  for (const name of ['.env', '.env.local', 'id_rsa', 'id_ed25519', 'server.pem', 'credentials', '.npmrc', '.netrc', 'service-account.json', 'terraform.tfstate']) {
    const result = await scanFile(file(name, 'private-value-not-for-output'));
    assert(result.needsConfirmation, name);
    assert(result.categories.length, name);
    assert(!JSON.stringify(result).includes('private-value-not-for-output'));
  }
});

test('high-confidence credential signatures in text are detected without excerpts', async () => {
  const samples = [
    '-----BEGIN OPENSSH PRIVATE KEY-----', 'AKIA' + 'A'.repeat(16),
    'ghp_' + 'a'.repeat(36), 'github_pat_' + 'a'.repeat(70),
    'xoxb-' + '1'.repeat(24), 'sk_live_' + 'a'.repeat(24), 'AIza' + 'a'.repeat(35),
  ];
  for (const value of samples) {
    const result = await scanFile(file('code.ts', `const credential = "${value}";`));
    assert(result.categories.length);
    assert(!JSON.stringify(result).includes(value));
  }
});

test('safe files, public keys, placeholders and ordinary identifiers do not trigger content rules', async () => {
  for (const [name, text] of [['readme.md', 'Hello world'], ['id_rsa.pub', 'ssh-rsa AAAAB3 public-key'], ['index.ts', 'const password = "YOUR_PASSWORD"; const token = "ghp_example";'], ['empty.txt', '']]) {
    assert.equal((await scanFile(file(name, text))).needsConfirmation, false);
  }
});

test('large files are bounded and require explicit acknowledgement of incomplete coverage', async () => {
  let bounds;
  const result = await scanFile({ name: 'large.txt', size: SCAN_LIMIT * 20, slice(start, end) { bounds = [start, end]; return new Blob(['safe prefix']); } });
  assert.deepEqual(bounds, [0, SCAN_LIMIT]);
  assert(result.needsConfirmation);
  assert.match(result.limitations.join(' '), /first 1 MiB/);
});

test('binary, archive, unreadable and invalid UTF-8 content cannot silently pass', async () => {
  const unreadable = { name: 'readme.txt', size: 1, slice() { throw new Error('SECRET_READ_ERROR'); } };
  for (const input of [file('archive.zip', 'PK'), file('blob.bin', '\0'), new File([new Uint8Array([255])], 'bad.txt'), unreadable]) {
    const result = await scanFile(input);
    assert(result.needsConfirmation);
    assert(result.limitations.length);
    assert(!JSON.stringify(result).includes('SECRET_READ_ERROR'));
  }
});

test('stalled reads time out into an explicit warning', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = scanFile({ name: 'slow.txt', size: 1, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) });
  t.mock.timers.tick(3000);
  const result = await pending;
  assert(result.needsConfirmation);
  assert.match(result.limitations.join(' '), /timed out/);
});

test('no upload continuation runs until explicit consent; consent is not reused', async () => {
  const input = file('.env', 'anything');
  let uploads = 0, decide;
  const pending = withSharingCheck(input, () => new Promise(resolve => { decide = resolve; }), async () => { uploads++; });
  while (!decide) await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads, 0);
  decide(true);
  assert.equal(await pending, true);
  assert.equal(uploads, 1);
  for (const decision of [false, undefined, 'yes']) {
    assert.equal(await withSharingCheck(input, async () => decision, async () => { uploads++; }), false);
  }
  assert.equal(uploads, 1);
});

test('safe send proceeds normally; scan failure and cancelled retry never upload', async () => {
  let uploads = 0;
  await withSharingCheck(file('safe.txt', 'hello'), async () => { assert.fail('unexpected warning'); }, async () => { uploads++; });
  const broken = { name: 'safe.txt', size: 1, slice() { throw new Error('read failed'); } };
  assert.equal(await withSharingCheck(broken, async () => false, async () => { uploads++; }), false);
  await withSharingCheck(broken, async () => true, async () => { uploads++; });
  await assert.rejects(withSharingCheck(file('.env'), async () => { throw new Error('closed'); }, async () => { uploads++; }));
  assert.equal(uploads, 2);
});
