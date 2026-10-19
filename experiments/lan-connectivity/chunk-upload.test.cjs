const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const CHUNK = 1024 * 1024;
const bytes = Buffer.alloc(2 * CHUNK + 61, 0xab);
const hash = createHash('sha256').update(bytes).digest('hex');
const headers = { 'X-File-Name': 'fresh-photo.jpg', 'X-File-Size': String(bytes.length), 'X-File-SHA256': hash };
const serverPath = path.join(__dirname, 'server.cjs');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-resume-'));
  let child;
  let base;
  let sessionCookie;
  const bootstrap = `
    const path = require('node:path');
    const { createLanServer } = require(process.argv[1]);
    const { server, bootstrapToken } = createLanServer({ uploadsDirectory: path.join(process.argv[2], 'uploads') });
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, bootstrapToken })));
  `;
  async function start() {
    child = spawn(process.execPath, ['-e', bootstrap, serverPath, temporary], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${stderr}`)));
      child.stdout.once('data', (data) => resolve(String(data).trim()));
    });
    const started = JSON.parse(port);
    base = `http://127.0.0.1:${started.port}`;
    const login = await fetch(base + '/auth/host', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' },
      body: JSON.stringify({ token: started.bootstrapToken }),
    });
    assert.equal(login.status, 200, await login.text());
    sessionCookie = login.headers.getSetCookie()[0].split(';')[0];
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  const api = {
    temporary, get base() { return base; }, get sessionCookie() { return sessionCookie; }, start, stop,
    request(route, options = {}) {
      return fetch(base + route, { ...options, headers: { Cookie: sessionCookie, 'X-EchoDrop-Request': '1', ...options.headers } });
    },
    async json(route, options, code = 200) {
      const result = await api.request(route, options);
      const text = await result.text();
      assert.equal(result.status, code, text);
      return JSON.parse(text);
    },
    async code(route, options, code) {
      const result = await api.request(route, options);
      assert.equal(result.status, code, await result.text());
    },
    directory(id) { return path.join(temporary, 'uploads', '.transfers', id); },
  };
  t.after(async () => {
    await stop();
    // Check the resolved target stays inside the intended temporary root before cleanup.
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert(path.basename(temporary).startsWith('echodrop-resume-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await start();
  return api;
}

async function browser(api, storage = new Map(), intercept) {
  const progressValues = [];
  const items = [], requests = [];
  const key = `echodrop:transfer:${hash}:${bytes.length}:fresh-photo.jpg`;
  let transfer;
  progressValues.push(0);
  try {
    const savedId = storage.get(key);
    const send = async (route, options = {}) => {
      requests.push({ route, options });
      if (route === '/transfers') assert.equal(options.headers['X-File-SHA256'], hash);
      return intercept ? intercept(route, options, () => api.request(route, options)) : api.request(route, options);
    };
    if (savedId) {
      const resumed = await send(`/transfers/${savedId}/resume`, { method: 'POST', headers });
      if (resumed.ok) transfer = await resumed.json();
      else if (resumed.status === 404 || resumed.status === 410) storage.delete(key);
      else throw new Error(await resumed.text());
    }
    if (!transfer) {
      transfer = await (await send('/transfers', { method: 'POST', headers })).json();
      storage.set(key, transfer.id);
    }
    progressValues.push(transfer.retainedBytes);
    while (transfer.state !== 'completed' && transfer.nextIndex * CHUNK < bytes.length) {
      const offset = transfer.nextIndex * CHUNK;
      const chunk = await send(`/transfers/${transfer.id}/chunks/${transfer.nextIndex}`, {
        method: 'PUT', body: bytes.subarray(offset, offset + CHUNK),
      });
      if (!chunk.ok) throw new Error(await chunk.text());
      transfer = await chunk.json();
      progressValues.push(transfer.retainedBytes);
    }
    const completion = await send(`/transfers/${transfer.id}/complete`, { method: 'POST' });
    if (!completion.ok) throw new Error(await completion.text());
    const completed = await completion.json();
    progressValues.push(completed.retainedBytes);
    items.push({ child: { download: completed.originalName } });
    storage.delete(key);
    return { items, status: 'Upload verified.', progressValues, requests };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retained = message.startsWith('Integrity check failed') ? 0 : transfer?.retainedBytes;
    if (message.startsWith('Integrity check failed')) storage.delete(key);
    return { items, status: retained === undefined ? message : `${message}; ${retained} bytes retained`, progressValues, requests };
  }
}

async function checkDownload(api, id) {
  const download = await api.request(`/files/${id}.bin`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /filename="fresh-photo\.jpg"/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const listed = await (await api.request('/')).text();
  assert(listed.includes('download="fresh-photo.jpg"'));
}

async function partialChunk(api, id) {
  const request = http.request(`${api.base}/transfers/${id}/chunks/1`, {
    method: 'PUT', headers: { 'Content-Length': CHUNK, Cookie: api.sessionCookie, 'X-EchoDrop-Request': '1' },
  });
  request.on('error', () => {});
  request.write(Buffer.alloc(65536, 0xab));
  // Wait until a real partial disk write exists before disconnecting or killing the server.
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await fs.stat(path.join(api.directory(id), '1.chunk.part')).catch(() => null);
    if (stat && stat.size > 0) return request;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  request.destroy();
  throw new Error('Partial chunk did not reach disk');
}

async function settledStatus(api, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await api.request(`/transfers/${id}`);
    if (result.status === 200) return result.json();
    assert.equal(result.status, 409, await result.text());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Transfer remained busy');
}

test('successful upload: verified download, progress, IDs, indexes and limit', { timeout: 30000 }, async (t) => {
  const api = await fixture(t);
  await api.code('/transfers/not-a-uuid', {}, 400);
  await api.code('/transfers', { method: 'POST', headers: { ...headers, 'X-File-Size': '100000001' } }, 413);
  let id;
  const result = await browser(api, new Map(), async (route, options, send) => {
    if (route.endsWith('/complete')) {
      await api.code(`/files/${id}.bin`, {}, 404);
      assert(!(await (await api.request('/')).text()).includes(`href="/files/${id}.bin"`));
    }
    const response = await send();
    if (route === '/transfers') {
      id = (await response.clone().json()).id;
      for (const index of ['-1', '1.5', '01', '9007199254740992', '3']) {
        await api.code(`/transfers/${id}/chunks/${index}`, { method: 'PUT', body: 'x' }, 400);
      }
      await api.code(`/transfers/${id}/chunks/1`, { method: 'PUT', body: 'x' }, 409);
      await api.code(`/transfers/${id}/complete`, { method: 'POST' }, 409);
    }
    return response;
  });
  assert.equal(result.status, 'Upload verified.');
  assert.deepEqual(result.progressValues, [0, 0, CHUNK, 2 * CHUNK, bytes.length, bytes.length]);
  assert.equal(result.items[0].child.download, 'fresh-photo.jpg');
  await checkDownload(api, id);
  const again = await api.json(`/transfers/${id}/complete`, { method: 'POST' }, 201);
  assert.equal(again.retainedBytes, bytes.length);
  assert.equal(again.state, 'completed');
});

test('interrupted upload resumes after browser reconnect without duplicate writes', { timeout: 30000 }, async (t) => {
  const api = await fixture(t);
  const storage = new Map();
  let id;
  const first = await browser(api, storage, async (route, options, send) => {
    if (route.endsWith('/chunks/1')) {
      const request = await partialChunk(api, id);
      request.destroy();
      const state = await settledStatus(api, id);
      assert.equal(state.retainedBytes, CHUNK);
      throw new Error('Connection interrupted');
    }
    const response = await send();
    if (route === '/transfers') id = (await response.clone().json()).id;
    return response;
  });
  assert.match(first.status, /1048576 bytes retained/);
  assert.equal(storage.size, 1);
  const chunk = path.join(api.directory(id), '0.chunk');
  const before = await fs.stat(chunk);
  const duplicate = await api.json(`/transfers/${id}/chunks/0`, { method: 'PUT', body: Buffer.alloc(CHUNK, 0xff) });
  assert.equal(duplicate.retainedBytes, CHUNK);
  assert.equal((await fs.stat(chunk)).mtimeMs, before.mtimeMs);
  await api.code(`/transfers/${id}/resume`, { method: 'POST', headers: { ...headers, 'X-File-SHA256': '0'.repeat(64) } }, 409);
  const second = await browser(api, storage);
  assert.equal(second.status, 'Upload verified.');
  assert.equal(second.requests[0].route, `/transfers/${id}/resume`);
  assert.deepEqual(second.requests.filter((entry) => entry.options.method === 'PUT').map((entry) => entry.route), [
    `/transfers/${id}/chunks/1`, `/transfers/${id}/chunks/2`,
  ]);
  assert.deepEqual(second.progressValues, [0, CHUNK, 2 * CHUNK, bytes.length, bytes.length]);
  assert.equal(storage.size, 0);
  await checkDownload(api, id);
});

test('server-restart recovery retains committed chunks and discards an in-flight chunk', { timeout: 30000 }, async (t) => {
  const api = await fixture(t);
  const transfer = await api.json('/transfers', { method: 'POST', headers }, 201);
  const id = transfer.id;
  await api.json(`/transfers/${id}/chunks/0`, { method: 'PUT', body: bytes.subarray(0, CHUNK) });
  const request = await partialChunk(api, id);
  await api.stop();
  request.destroy();
  await api.start();
  const retained = await api.json(`/transfers/${id}/resume`, { method: 'POST', headers });
  assert.equal(retained.retainedBytes, CHUNK);
  assert.deepEqual(retained.completedChunks, [0]);
  assert.equal(retained.nextIndex, 1);
  assert.deepEqual((await fs.readdir(api.directory(id))).sort(), ['0.chunk', 'state.json']);
  await api.code(`/files/${id}.bin`, {}, 404);
  for (let index = 1; index < 3; index++) {
    await api.json(`/transfers/${id}/chunks/${index}`, { method: 'PUT', body: bytes.subarray(index * CHUNK, (index + 1) * CHUNK) });
  }
  await api.json(`/transfers/${id}/complete`, { method: 'POST' }, 201);
  await api.stop();
  await api.start();
  const completed = await api.json(`/transfers/${id}`);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.retainedBytes, bytes.length);
  await checkDownload(api, id);
});

test('hash mismatch is rejected, cleaned up and stays unavailable after restart', { timeout: 30000 }, async (t) => {
  const api = await fixture(t);
  const storage = new Map();
  let id;
  const result = await browser(api, storage, async (route, options, send) => {
    if (route.endsWith('/chunks/0')) {
      const corrupted = new Uint8Array(options.body);
      corrupted[0] ^= 1;
      return api.request(route, { ...options, body: corrupted });
    }
    const response = await send();
    if (route === '/transfers') id = (await response.clone().json()).id;
    if (route.endsWith('/complete')) assert.equal(response.status, 422);
    return response;
  });
  assert.match(result.status, /Integrity check failed.*0 bytes retained/);
  assert.equal(result.items.length, 0);
  assert.equal(storage.size, 0);
  assert.deepEqual(await fs.readdir(api.directory(id)), ['state.json']);
  assert.deepEqual(await fs.readdir(path.join(api.temporary, 'uploads')), ['.transfers']);
  await api.stop();
  await api.start();
  const failed = await api.json(`/transfers/${id}`);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retainedBytes, 0);
  await api.code(`/files/${id}.bin`, {}, 404);
  await api.code(`/transfers/${id}/resume`, { method: 'POST', headers }, 410);
  assert(!(await (await api.request('/')).text()).includes(`href="/files/${id}.bin"`));
});
