const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

function installProjectRegistry({ ipcMain, trusted, parent, registryFile, collaborationFile, safeStorage, ui }) {
  let registry, selecting = false;
  const folders = new Map();
  const store = () => registry ||= import('./project-registry.mjs').then(({ createProjectRegistry }) => createProjectRegistry(registryFile()));
  if (collaborationFile) require('./collaboration-ipc.cjs').installCollaboration({ ipcMain, trusted, safeStorage, parent, dialog: ui.dialog, registryFile: collaborationFile, getProjects: async () => (await store()).list(), restoreProjectMetadata: async (request, authority) => (await store()).restoreMetadata(request, authority) });
  ipcMain.handle('workspace:registry', async (event, action, value) => {
    trusted(event); // Only the main local renderer; no HTTP route or remote-device access.
    if (action === 'list') return (await store()).list();
    if (action === 'select-folder') {
      if (selecting) throw new Error('A folder dialog is already open.');
      selecting = true;
      try {
        const result = await ui.dialog.showOpenDialog(parent(), { title: 'Associate a local project folder', properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return null;
        const directory = await fs.realpath(result.filePaths[0]);
        if (!(await fs.stat(directory)).isDirectory()) throw new Error('Choose a directory.');
        folders.clear();
        const token = randomUUID(); folders.set(token, directory);
        return { token, label: path.basename(directory) || directory };
      } finally { selecting = false; }
    }
    if (action === 'create') {
      if (!value || typeof value !== 'object') throw new Error('Invalid project request.');
      const folder = value.folderToken === undefined ? undefined : folders.get(value.folderToken);
      if (value.folderToken !== undefined && !folder) throw new Error('Select the folder again before creating the project.');
      const project = await (await store()).create(value.input, folder);
      if (value.folderToken) folders.delete(value.folderToken);
      return project;
    }
    if (action === 'update') return (await store()).update(value?.id, value?.patch);
    if (action === 'open-folder') {
      const project = (await (await store()).list()).projects.find(item => item.id === value);
      if (!project?.localRoot) throw new Error('This project has no associated folder.');
      if (!(await fs.stat(project.localRoot)).isDirectory()) throw new Error('The associated folder is unavailable.');
      if (await ui.shell.openPath(project.localRoot)) throw new Error('The associated folder could not be opened.');
      return;
    }
    throw new Error('Unsupported registry action.');
  });
}
module.exports = { installProjectRegistry };
