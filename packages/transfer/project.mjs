// Versioned, uncompressed project envelope. No archive extraction library or executable metadata.
export const PROJECT_LIMIT = 32 * 1024 * 1024;
export const PACKAGE_LIMIT = 46 * 1024 * 1024;
export const FILE_LIMIT = 8 * 1024 * 1024;
export const COUNT_LIMIT = 1000;
export const EXCLUDED = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', 'coverage', '.cache', '.turbo'];
export function safePath(value) {
  if (typeof value !== 'string' || value.length > 220 || value !== value.normalize('NFC')) throw new Error('Unsupported project path.');
  const parts = value.split('/');
  if (parts.length > 16 || parts.some(p => !p || p === '.' || p === '..' || /[\\<>:"|?*\x00-\x1f\x7f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe project path.');
  return value;
}
export function excludedPath(value) { return value.split('/').slice(0, -1).some(p => EXCLUDED.includes(p.toLowerCase())); }
export function encodeBytes(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function decodeBytes(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(FILE_LIMIT / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value) || value.length % 4 !== 0) throw new Error('Invalid project file encoding.');
  const raw = atob(value);
  if (btoa(raw) !== value) throw new Error('Noncanonical project encoding.');
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
export function validateProject(value) {
  if (!value || value.format !== 'echodrop-project' || value.version !== 1 || typeof value.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.name) || !Array.isArray(value.files) || !value.files.length || value.files.length > COUNT_LIMIT) throw new Error('Invalid or oversized EchoDrop project.');
  let total = 0;
  const paths = new Set(), directories = new Set();
  for (const entry of value.files) {
    safePath(entry?.path);
    if (excludedPath(entry.path)) throw new Error('Project contains an excluded generated directory.');
    const key = entry.path.toLowerCase();
    if (paths.has(key) || directories.has(key)) throw new Error('Conflicting project paths.');
    const parts = key.split('/'); parts.pop();
    while (parts.length) { const parent = parts.join('/'); if (paths.has(parent)) throw new Error('Conflicting project paths.'); directories.add(parent); parts.pop(); }
    paths.add(key);
    const bytes = decodeBytes(entry.data);
    total += bytes.length;
    if (bytes.length > FILE_LIMIT || total > PROJECT_LIMIT) throw new Error('Project exceeds the 32 MiB / 8 MiB per-file limit.');
  }
  return value;
}
export function parseProject(text) {
  if (typeof text !== 'string' || text.length > PACKAGE_LIMIT) throw new Error('Project package is too large.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid EchoDrop project package.'); }
  return validateProject(value);
}
export function projectName(name) { return name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'project'; }
export function packageProject(project) {
  validateProject(project);
  const text = JSON.stringify({ format: 'echodrop-project', version: 1, name: project.name, files: [...project.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, data }) => ({ path, data })) });
  if (new TextEncoder().encode(text).length > PACKAGE_LIMIT) throw new Error('Project package is too large.');
  return text;
}
export async function importBrowserProject(files) {
  if (!files.length || files.length > 100000) throw new Error('This browser selection is too large. Use EchoDrop desktop to exclude generated directories before enumeration.');
  const root = files[0].webkitRelativePath.split('/')[0];
  if (!root) throw new Error('This browser did not provide a folder. Use EchoDrop desktop.');
  const project = { format: 'echodrop-project', version: 1, name: projectName(root), files: [] };
  const excluded = []; let size = 0;
  let visited = 0;
  for (const file of files) {
    if (++visited % 200 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    if (!file.webkitRelativePath.startsWith(root + '/')) throw new Error('Choose one project folder.');
    const relative = file.webkitRelativePath.slice(root.length + 1);
    if (excludedPath(relative)) { if (excluded.length < 100) excluded.push(relative); continue; }
    safePath(relative); size += file.size;
    if (file.size > FILE_LIMIT || size > PROJECT_LIMIT || project.files.length >= COUNT_LIMIT) throw new Error('Project limit: 1,000 files, 32 MiB total, 8 MiB per file.');
    project.files.push({ path: relative, data: encodeBytes(new Uint8Array(await file.arrayBuffer())) });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  validateProject(project);
  return { project, excluded };
}
export function compatibility(project) {
  const facts = [], unknowns = ['Dependencies, installed CLI runtimes, platform support and successful builds are not verified.'];
  const entry = project.files.find(f => f.path === 'package.json');
  let manifest;
  if (entry) {
    try {
      const raw = decodeBytes(entry.data);
      if (raw.length > 1024 * 1024) throw new Error();
      manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
      facts.push('Root package.json parsed successfully.');
    } catch { unknowns.push('Root package.json could not be inspected.'); }
  } else unknowns.push('No root package.json. Node.js project compatibility is unknown.');
  const managers = [['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']].filter(([file]) => project.files.some(f => f.path === file)).map(([, name]) => name);
  const unique = [...new Set(managers)];
  if (unique.length) facts.push('Lockfiles present: ' + unique.join(', ') + '.');
  if (unique.length > 1) unknowns.push('Multiple package managers have lockfiles. Resolve which one to use.');
  if (typeof manifest?.packageManager === 'string' && /^(npm|pnpm|yarn|bun)@[0-9][0-9A-Za-z.+_-]{0,60}$/.test(manifest.packageManager)) facts.push('Declared package manager: ' + manifest.packageManager + '.');
  else unknowns.push('Exact package manager version is not verified.');
  if (typeof manifest?.engines?.node === 'string' && /^[0-9v<>=~^.*| -]{1,80}$/.test(manifest.engines.node)) facts.push('Declared Node.js requirement: ' + manifest.engines.node + '.');
  else unknowns.push('Node.js version requirement is not declared or understood.');
  for (const name of ['.nvmrc', '.node-version']) {
    const versionFile = project.files.find(f => f.path === name);
    if (versionFile) {
      const bytes = decodeBytes(versionFile.data);
      const version = bytes.length <= 80 ? new TextDecoder().decode(bytes).trim() : '';
      if (/^(?:v?[0-9]+(?:\.[0-9x]+){0,2}|lts\/[a-z*]+|node)$/.test(version)) facts.push('Declared runtime in ' + name + ': ' + version + '.');
      else facts.push('Runtime version file present: ' + name + '. Contents require manual review.');
    }
  }
  if (project.files.some(f => /(^|\/)\.env(?:\.|$)/.test(f.path))) facts.push('Environment configuration or templates are included. Review values and recreate machine-specific settings.');
  const declaredManager = typeof manifest?.packageManager === 'string' ? manifest.packageManager.split('@')[0] : null;
  if (declaredManager && unique.length && !unique.includes(declaredManager)) unknowns.push('Declared package manager and detected lockfiles disagree.');
  const deps = { ...manifest?.dependencies, ...manifest?.devDependencies };
  if (Object.hasOwn(deps, 'react')) facts.push('React declared in dependencies.');
  if (Object.hasOwn(deps, 'typescript') || project.files.some(f => f.path === 'tsconfig.json')) facts.push('TypeScript dependency or configuration present.');
  const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? Object.keys(manifest.scripts).filter(s => /^[a-zA-Z0-9:_-]{1,60}$/.test(s)).slice(0, 50) : [];
  if (scripts.length) facts.push('Declared script names: ' + scripts.join(', ') + '. Commands have not been executed.');
  if (manifest?.workspaces) unknowns.push('Workspace configuration is present. Nested package compatibility is not verified.');
  return { facts, unknowns, guidance: ['Open the received folder and review package.json, scripts and dependencies before running commands.', 'Install the required runtime and package manager yourself. EchoDrop never installs or runs project code.', 'Recreate excluded environment values and credentials locally. Dependencies and build outputs are not included.', 'Dependency downloads may require internet access even though project sharing uses your LAN.'] };
}
