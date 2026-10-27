function installCollaboration({ ipcMain, trusted, registryFile, getProjects, restoreProjectMetadata, safeStorage, parent, dialog }) {
  let store;
  const getStore = () => store ||= import('./collaboration-store.mjs').then(async ({ createCollaborationStore }) => {
    const protection = safeStorage ? (await import('./participant-identity.mjs')).osIdentityProtection(safeStorage) : undefined;
    return createCollaborationStore(registryFile(), getProjects, undefined, protection);
  });
  require('./remote-ipc.cjs').installRemoteCollaboration({ ipcMain, trusted, getStore, getProjects, restoreProjectMetadata, parent, dialog, safeStorage, contentDirectory: () => require('node:path').join(require('node:path').dirname(registryFile()), 'secure-content') });
  ipcMain.handle('workspace:collaboration', async (event, action, projectId, command) => {
    trusted(event);
    // Actor identity is selected in the main process; never accept renderer/session identities.
    if (action === 'snapshot' && command === undefined) return (await getStore()).snapshot(projectId);
    if (action === 'execute') return (await getStore()).execute(projectId, command);
    throw new Error('Unsupported collaboration operation.');
  });
}
module.exports = { installCollaboration };
