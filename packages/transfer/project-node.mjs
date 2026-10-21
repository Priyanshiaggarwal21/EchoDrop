import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { PROJECT_LIMIT, PACKAGE_LIMIT, FILE_LIMIT, COUNT_LIMIT, EXCLUDED, safePath, projectName, validateProject, parseProject, decodeBytes, compatibility } from './project.mjs';

export async function importFolder(directory) {
  const root = await fs.realpath(directory);
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Choose a project folder.');
  const project = { format: 'echodrop-project', version: 1, name: projectName(path.basename(root)), files: [] };
  const excluded = []; let size = 0, visited = 0;
  const omit = value => { if (excluded.length < 100) excluded.push(value); };
  async function walk(relative = '') {
    const location = path.join(root, relative);
    if (await fs.realpath(location) !== location || (await fs.lstat(location)).isSymbolicLink()) throw new Error('Project changed during import. Select it again.');
    const directoryHandle = await fs.opendir(location);
    for await (const item of directoryHandle) {
      if (++visited > 5000) throw new Error('Project contains more than 5,000 entries.');
      const name = relative ? relative + '/' + item.name : item.name;
      if (item.isSymbolicLink() || (item.isDirectory() && EXCLUDED.includes(item.name.toLowerCase()))) { omit(name); continue; }
      safePath(name);
      const source = path.join(root, ...name.split('/'));
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink() || await fs.realpath(source) !== source) { omit(name); continue; }
      if (stat.isDirectory()) { await walk(name); continue; }
      if (!stat.isFile() || stat.nlink > 1) { omit(name); continue; }
      if (stat.size > FILE_LIMIT || size + stat.size > PROJECT_LIMIT || project.files.length >= COUNT_LIMIT) throw new Error('Project limit: 1,000 files, 32 MiB total, 8 MiB per file.');
      const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || !opened.isFile()) throw new Error('Project changed during import.');
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
        const after = await handle.stat();
        if (offset !== stat.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) throw new Error('Project changed during import.');
        size += offset;
        project.files.push({ path: name, data: buffer.subarray(0, offset).toString('base64') });
      } finally { await handle.close(); }
    }
  }
  await walk(); validateProject(project);
  return { project, excluded };
}

export async function readPackage(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PACKAGE_LIMIT) throw new Error('Select a regular EchoDrop project package under 46 MiB.');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset !== stat.size) throw new Error('Project package changed while reading.');
    return parseProject(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } finally { await handle.close(); }
}

export async function receiveProject(project, destination) {
  // Validate the complete envelope before creating anything. No merge, overwrite, links or permissions from sender.
  validateProject(project);
  const parent = await fs.realpath(destination);
  const root = await fs.mkdtemp(path.join(parent, project.name + '-'));
  if (path.dirname(root) !== parent) throw new Error('Invalid destination.');
  try {
    await fs.chmod(root, 0o700);
    for (const entry of project.files) {
      const target = path.join(root, ...entry.path.split('/'));
      if (!target.startsWith(root + path.sep)) throw new Error('Unsafe destination.');
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) throw new Error('Destination changed during extraction.');
      await fs.writeFile(target, decodeBytes(entry.data), { flag: 'wx', mode: 0o600 });
    }
    return { directory: root, name: project.name, report: compatibility(project) };
  } catch (error) {
    // root is the fresh, verified child created above, never a caller-supplied deletion target.
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
