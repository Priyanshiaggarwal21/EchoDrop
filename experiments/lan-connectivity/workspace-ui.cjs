const fs = require('node:fs/promises');
const path = require('node:path');
// Presentation only: called after the existing workspace authentication gate.
async function workspaceUI(nonce, fileLinks) {
  const root = path.join(__dirname, '../../apps/web/dist/lan');
  let script, css;
  try { [script, css] = await Promise.all([fs.readFile(path.join(root, 'omnidrop.js'), 'utf8'), fs.readFile(path.join(root, 'omnidrop.css'), 'utf8')]); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EchoDrop workspace</title><style nonce="${nonce}">${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><ul id="files" hidden>${fileLinks}</ul><div id="omni-root"></div><script nonce="${nonce}">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
module.exports = { workspaceUI };
