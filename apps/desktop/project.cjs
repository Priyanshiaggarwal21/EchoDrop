const { dialog, shell } = require('electron');
const { randomUUID } = require('node:crypto');

function installProjects({ ipcMain, trusted, parent, authorize, download, ui = { dialog, shell } }) {
  let busy = false, received = new Map();
  ipcMain.handle('workspace:project', async (event, action, route) => {
    trusted(event);
    await authorize();
    if (busy) throw new Error('A project operation is in progress.');
    busy = true;
    try {
      const { importFolder, readPackage, receiveProject } = await import('../../packages/transfer/project-node.mjs');
      const { parseProject, PACKAGE_LIMIT } = await import('../../packages/transfer/project.mjs');
      if (action === 'select') {
        const result = await ui.dialog.showOpenDialog(parent(), { title: 'Select a developer project', properties: ['openDirectory'] });
        return result.canceled ? null : await importFolder(result.filePaths[0]);
      }
      if (action === 'receive') {
        let project;
        if (route !== undefined) {
          if (typeof route !== 'string' || !/^\/files\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/.test(route)) throw new Error('Invalid shared project.');
          const response = await download(route);
          if (Number(response.headers.get('content-length')) > PACKAGE_LIMIT) { await response.body.cancel(); throw new Error('Project package exceeds 46 MiB.'); }
          const chunks = []; let size = 0;
          for await (const chunk of response.body) { size += chunk.length; if (size > PACKAGE_LIMIT) throw new Error('Project package exceeds 46 MiB.'); chunks.push(chunk); }
          project = parseProject(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } else {
          const result = await ui.dialog.showOpenDialog(parent(), { title: 'Receive a downloaded EchoDrop project', properties: ['openFile'], filters: [{ name: 'EchoDrop project', extensions: ['echoproject'] }] });
          if (result.canceled) return null;
          project = await readPackage(result.filePaths[0]);
        }
        const destination = await ui.dialog.showOpenDialog(parent(), { title: 'Choose parent folder for a new project copy', properties: ['openDirectory', 'createDirectory'] });
        if (destination.canceled) return null;
        const result = await receiveProject(project, destination.filePaths[0]);
        const id = randomUUID(); received.set(id, result.directory);
        return { ...result, id };
      }
      if (action === 'open') {
        const directory = received.get(route);
        if (!directory) throw new Error('Receive this project before opening it.');
        const error = await ui.shell.openPath(directory);
        if (error) throw new Error('The project folder could not be opened.');
        return null;
      }
      throw new Error('Unsupported project action.');
    } finally { busy = false; }
  });
}
module.exports = { installProjects };
