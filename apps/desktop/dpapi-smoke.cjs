// Isolated native smoke test. Never points at the user's EchoDrop registry.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { stat, lstat } = require('node:fs/promises');
const root = process.argv.find(value => value.startsWith('--smoke-root='))?.slice('--smoke-root='.length);
async function validateRoot() {
  if (!root || !path.basename(root).startsWith('echodrop-dpapi-')) throw Error('Invalid isolated smoke root.');
  const resolved = path.resolve(root);
  const [parentStat, tempStat, rootStat, rootLink] = await Promise.all([
    stat(path.dirname(resolved)),
    stat(os.tmpdir()),
    stat(resolved),
    lstat(resolved),
  ]);
  if (parentStat.dev !== tempStat.dev || parentStat.ino !== tempStat.ino || rootLink.isSymbolicLink() || !rootStat.isDirectory()) throw Error('Invalid isolated smoke root.');
}
async function run() {
  await validateRoot();
  app.setPath('userData', root);
  await app.whenReady();
  assert.equal(process.platform, 'win32'); assert.equal(safeStorage.isEncryptionAvailable(), true);
  const { osIdentityProtection } = await import('./participant-identity.mjs');
  const { createCollaborationStore } = await import('./collaboration-store.mjs');
  const projectId = '91c7f423-e665-4218-8fe4-8b31d593ecb2';
  const file = path.join(root, 'smoke-registry.json');
  const store = createCollaborationStore(file, async () => ({ projects: [{ id: projectId, name: 'DPAPI smoke fixture' }] }), undefined, osIdentityProtection(safeStorage));
  const snapshot = await store.snapshot(projectId);
  let expected;
  try { expected = JSON.parse(await fs.readFile(path.join(root, 'expected.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!expected) {
    const certificate = await fs.readFile(path.join(__dirname, 'test-fixtures/remote-tls/host-cert.pem'), 'utf8');
    const key = await fs.readFile(path.join(__dirname, 'test-fixtures/remote-tls/host-key.pem'), 'utf8');
    await store.remoteLocal(projectId, 'import-identity', { certificate, key });
    await fs.writeFile(path.join(root, 'expected.json'), JSON.stringify({ participantId: snapshot.localParticipant.id, principalId: snapshot.actor.id }));
  } else { assert.equal(snapshot.localParticipant.id, expected.participantId); assert.equal(snapshot.actor.id, expected.principalId); }
  const identity = await store.remoteCredentials(); assert(identity.key.includes('PRIVATE KEY'));
  const disk = await fs.readFile(file, 'utf8'); assert(!disk.includes('PRIVATE KEY'));
  const view = JSON.stringify(await store.remoteStatus()); assert(!view.includes('PRIVATE KEY')); assert(!view.includes('sealedKey'));
  console.log(JSON.stringify({ ok: true, phase: expected ? 'restore' : 'create', electron: process.versions.electron, node: process.versions.node, platform: process.platform, dpapi: true }));
}
run().then(() => app.exit(0), error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
