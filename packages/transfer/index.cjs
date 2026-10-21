const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');

const CHUNK_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 100_000_000;
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validHash = /^[0-9a-f]{64}$/;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function save(filename, value) {
  const temporary = `${filename}.tmp`;
  const file = await fs.open(temporary, 'w');
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  await fs.rename(temporary, filename);
}

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function createTransferStore(directory) {
  const active = new Set();
  const root = path.join(directory, '.transfers');
  const folder = (id) => path.join(root, id);
  const manifest = (id) => path.join(folder(id), 'state.json');
  const chunkPath = (id, index) => path.join(folder(id), `${index}.chunk`);
  const finalPath = (id) => path.join(directory, `${id}.bin`);

  async function locked(id, operation) {
    if (!validId.test(id)) throw fail(400, 'Invalid transfer ID.');
    if (active.has(id)) throw fail(409, 'Transfer is busy. Retry shortly.');
    active.add(id);
    try { return await operation(); }
    finally { active.delete(id); }
  }

  function snapshot(state) {
    const received = state.state === 'completed' ? state.size
      : state.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    return {
      id: state.id, state: state.state, size: state.size, originalName: state.originalName,
      sha256: state.expectedHash, chunkSize: CHUNK_BYTES,
      received, retainedBytes: received, nextIndex: state.chunks.length,
      completedChunks: state.chunks.map((chunk, index) => index),
      ...(state.state === 'completed' ? { name: `${state.id}.bin`, download: `/files/${state.id}.bin` } : {}),
    };
  }

  async function cleanup(state) {
    // Only internal files in this validated transfer's directory are removed.
    for (const name of await fs.readdir(folder(state.id))) {
      if (/^\d+\.chunk(?:\.part)?$/.test(name) || name === 'assembled.part') {
        await fs.rm(path.join(folder(state.id), name), { force: true });
      }
    }
  }

  async function reject(state) {
    state.state = 'failed';
    state.chunks = [];
    // Persist rejection first so a restart cannot revive rejected content.
    await save(manifest(state.id), state);
    await cleanup(state);
    await fs.rm(finalPath(state.id), { force: true });
    await fs.rm(`${finalPath(state.id)}.json`, { force: true });
  }

  async function load(id) {
    let state;
    try { state = JSON.parse(await fs.readFile(manifest(id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw fail(404, 'Unknown transfer.');
      throw error;
    }
    const count = Math.ceil(state.size / CHUNK_BYTES);
    if (state.version !== 1 || state.id !== id || !Number.isSafeInteger(state.size)
      || state.size < 0 || state.size > MAX_UPLOAD_BYTES || !validHash.test(state.expectedHash)
      || typeof state.originalName !== 'string' || !Array.isArray(state.chunks)
      || state.chunks.length > count || !['uploading', 'completed', 'failed'].includes(state.state)
      || state.chunks.some((chunk, index) => !chunk || !validHash.test(chunk.sha256)
        || chunk.size !== Math.min(CHUNK_BYTES, state.size - index * CHUNK_BYTES))) {
      throw fail(500, 'Invalid persisted transfer state.');
    }
    if (state.state === 'failed') {
      await cleanup(state);
      await fs.rm(finalPath(id), { force: true });
      await fs.rm(`${finalPath(id)}.json`, { force: true });
      return state;
    }
    if (state.state === 'completed') {
      const stat = await fs.stat(finalPath(id));
      if (!stat.isFile() || stat.size !== state.size) throw fail(500, 'Completed file is unavailable.');
      await cleanup(state);
      return state;
    }
    // Recover publication if the process stopped after the verified rename.
    const published = await fs.stat(finalPath(id)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (published) {
      if (!published.isFile() || published.size !== state.size || await digest(finalPath(id)) !== state.expectedHash) {
        await reject(state);
        return state;
      }
      await save(`${finalPath(id)}.json`, { originalName: state.originalName, sha256: state.expectedHash });
      state.state = 'completed';
      await save(manifest(id), state);
      await cleanup(state);
      return state;
    }
    // A chunk is retained only if its durable record AND disk contents agree.
    let retained = 0;
    for (const chunk of state.chunks) {
      const filename = chunkPath(id, retained);
      const stat = await fs.stat(filename).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!stat || !stat.isFile() || stat.size !== chunk.size || await digest(filename) !== chunk.sha256) break;
      retained += 1;
    }
    if (retained !== state.chunks.length) {
      state.chunks.length = retained;
      await save(manifest(id), state);
    }
    // Discard partial writes and chunks whose acknowledgement was never committed.
    for (const name of await fs.readdir(folder(id))) {
      const match = /^(\d+)\.chunk$/.exec(name);
      if ((match && Number(match[1]) >= retained) || /^\d+\.chunk\.part$/.test(name)
        || name === 'assembled.part') {
        await fs.rm(path.join(folder(id), name), { force: true });
      }
    }
    return state;
  }

  return {
    async create(originalName, size, expectedHash, requestedId) {
      if (!Number.isSafeInteger(size) || size < 0) throw fail(400, 'Invalid file size.');
      if (size > MAX_UPLOAD_BYTES) throw fail(413, 'File exceeds 100 MB.');
      if (typeof expectedHash !== 'string' || !validHash.test(expectedHash)) throw fail(400, 'Invalid SHA-256 hash.');
      if (typeof originalName !== 'string' || !originalName) throw fail(400, 'Invalid filename.');
      const id = requestedId === undefined ? randomUUID() : requestedId;
      return locked(id, async () => {
        let exists = false;
        try { await fs.access(manifest(id)); exists = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (exists) {
          const existing = await load(id);
          if (existing.originalName !== originalName || existing.size !== size || existing.expectedHash !== expectedHash) {
            throw fail(409, 'Transfer ID belongs to a different file.');
          }
          if (existing.state === 'failed') throw fail(410, 'Integrity check failed. Upload discarded.');
          return snapshot(existing);
        }
        // Never replace a published file whose manifest is missing.
        try { await fs.access(finalPath(id)); throw fail(409, 'Transfer ID already published.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.mkdir(folder(id), { recursive: true });
        const state = { version: 1, id, originalName, size, expectedHash, state: 'uploading', chunks: [] };
        await save(manifest(id), state);
        return snapshot(state);
      });
    },

    status(id) { return locked(id, async () => snapshot(await load(id))); },

    resume(id, originalName, size, expectedHash) {
      return locked(id, async () => {
        const state = await load(id);
        if (state.state === 'failed') throw fail(410, 'Integrity check failed. Upload discarded.');
        if (state.originalName !== originalName || state.size !== size || state.expectedHash !== expectedHash) {
          throw fail(409, 'Selected file does not match this transfer.');
        }
        return snapshot(state);
      });
    },

    append(id, index, input) {
      return locked(id, async () => {
        if (!Number.isSafeInteger(index) || index < 0) throw fail(400, 'Invalid chunk index.');
        const state = await load(id);
        if (state.state === 'failed') throw fail(410, 'Integrity check failed. Upload discarded.');
        if (index >= Math.ceil(state.size / CHUNK_BYTES)) throw fail(400, 'Invalid chunk index.');
        if (index < state.chunks.length) {
          input.resume();
          return snapshot(state); // Idempotent retry: never append duplicate bytes.
        }
        if (state.state !== 'uploading' || index !== state.chunks.length) throw fail(409, 'Unexpected chunk.');
        const expected = Math.min(CHUNK_BYTES, state.size - index * CHUNK_BYTES);
        const temporary = `${chunkPath(id, index)}.part`;
        const file = await fs.open(temporary, 'wx');
        let committed = false;
        try {
          let bytes = 0;
          const hash = createHash('sha256');
          for await (const chunk of input.iterator({ destroyOnReturn: false })) {
            bytes += chunk.length;
            if (bytes > expected) throw fail(413, 'Chunk exceeds expected size.');
            hash.update(chunk);
            await file.writeFile(chunk);
          }
          if (bytes !== expected) throw fail(400, 'Incomplete chunk.');
          await file.sync();
          await file.close();
          await fs.rename(temporary, chunkPath(id, index));
          state.chunks.push({ size: bytes, sha256: hash.digest('hex') });
          await save(manifest(id), state);
          committed = true;
          return snapshot(state);
        } finally {
          await file.close();
          if (!committed) await fs.rm(temporary, { force: true });
        }
      });
    },

    complete(id) {
      return locked(id, async () => {
        const state = await load(id);
        if (state.state === 'failed') throw fail(422, 'Integrity check failed. Upload discarded.');
        if (state.state === 'completed') return snapshot(state);
        if (state.chunks.length !== Math.ceil(state.size / CHUNK_BYTES)) throw fail(409, 'Transfer is incomplete.');
        const assembled = path.join(folder(id), 'assembled.part');
        const file = await fs.open(assembled, 'wx');
        let matches = false;
        try {
          const hash = createHash('sha256');
          for (let index = 0; index < state.chunks.length; index++) {
            for await (const chunk of createReadStream(chunkPath(id, index))) {
              hash.update(chunk);
              await file.writeFile(chunk);
            }
          }
          await file.sync();
          matches = hash.digest('hex') === state.expectedHash;
        } finally { await file.close(); }
        if (!matches) {
          await reject(state);
          throw fail(422, 'Integrity check failed. Upload discarded.');
        }
        await save(`${finalPath(id)}.json`, { originalName: state.originalName, sha256: state.expectedHash });
        await fs.rename(assembled, finalPath(id));
        state.state = 'completed';
        await save(manifest(id), state);
        await cleanup(state);
        return snapshot(state);
      });
    },

    async isDownloadable(name) {
      const id = name.slice(0, -4);
      if (!validId.test(id) || name !== `${id}.bin`) return false;
      try {
        const state = JSON.parse(await fs.readFile(manifest(id), 'utf8'));
        return state.state === 'completed' && state.id === id;
      } catch (error) {
        // Preserve files published by the earlier non-resumable experiment.
        if (error.code === 'ENOENT') return true;
        return false;
      }
    },
  };
}

module.exports = { CHUNK_BYTES, MAX_UPLOAD_BYTES, createTransferStore };
