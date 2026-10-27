const path = require('node:path');
function installSecureContent({ ipcMain, trusted, getStore, service, contentStore, directory, parent, dialog, safeStorage, getIntentionClient, getContractClient, getEnvironmentClient, getPulseClient, getProjects, runtimeStore, dnaStore, guardianStore, inventoryStore, recovery, setGuardianQueue }) {
  let receiver, saving = false, queue, running = false, capturingEnvironment = false;
  const protection = () => import('./participant-identity.mjs').then(m => m.osIdentityProtection(safeStorage));
  const executeFor = async (localProjectId, target, command) => {
    await (await getStore()).snapshot(localProjectId);
    (await import('./delivery-queue.mjs')).validateTarget(target, localProjectId);
    const request = { ...command, version: 1, projectId: target.projectId, ...(target.contextId ? { contextId: target.contextId } : {}) };
    const value = target.mode === 'local' ? await (await contentStore()).handle(null, request) : await (await service()).query(target.fingerprint, target.host, target.port, request);
    return (await import('./secure-content-reply.mjs')).contentReply(request, value);
  };
  const getQueue = () => queue ||= Promise.all([import('./delivery-queue.mjs'), protection()]).then(([m, protector]) => m.createDeliveryQueue(path.join(directory(), 'queue'), { protection: protector, authorize: async id => (await getStore()).snapshot(id), execute: executeFor }));
  setGuardianQueue?.(getQueue);
  // One chunk per tick; no app-closed or always-on delivery promise.
  const timer = setInterval(async () => { if (running) return; running = true; try { await (await getQueue()).tick(); } catch { /* Queue UI surfaces fail-closed storage errors. */ } finally { running = false; } }, 2000);
  timer.unref();
  const getReceiver = () => receiver ||= import('./secure-content-receiver.mjs').then(({ createContentReceiver }) => protection().then(protector => createContentReceiver(path.join(directory(), 'received'), protector)));
  ipcMain.handle('workspace:secure-content', async (event, localProjectId, action, payload = {}) => {
    trusted(event);
    const collaboration = await getStore(); await collaboration.snapshot(localProjectId);
    if(['inventory-list','inventory-publish'].includes(action)){
      if(Object.keys(payload).some(k=>k!=='target'))throw Error('Inventory accepts a scope only, never client-supplied evidence.');
      const target=payload.target;(await import('./delivery-queue.mjs')).validateTarget(target,localProjectId);
      if(action==='inventory-list'){
        const query={version:1,action:'inventory-list',projectId:target.projectId,...(target.contextId?{contextId:target.contextId}:{})};
        const result=target.mode==='local'?await(await inventoryStore()).handle(null,query):await(await service()).query(target.fingerprint,target.host,target.port,query);
        return(await import('../../packages/core/dependency-inventory.mjs')).validateInventoryView(result,target);
      }
      return(await import('./dependency-inventory.mjs')).publishDependencyInventory({localProjectId,target,collaboration,queue:await getQueue(),receiver:await getReceiver(),query:async(t,q)=>(await service()).query(t.fingerprint,t.host,t.port,q)});
    }
    if(['recovery-list','recovery-create','recovery-preview','recovery-forget','recovery-restore'].includes(action))return recovery.run(localProjectId,action,payload);
    if(['guardian-list','guardian-create','guardian-update','guardian-review','guardian-cancel','guardian-request-approval','guardian-approve','guardian-reject','guardian-accept','guardian-decline'].includes(action)){
      const target=payload?.target;(await import('./delivery-queue.mjs')).validateTarget(target,localProjectId);
      const query={version:1,action,projectId:target.projectId,...(target.contextId?{contextId:target.contextId}:{}),since:payload.since??0,...(payload.operation?{operation:payload.operation}:{})};
      const reply=target.mode==='local'?await(await guardianStore()).handle(null,query):await(await service()).query(target.fingerprint,target.host,target.port,query);
      return (await import('../../packages/core/guardian.mjs')).validateGuardianReply(reply,target);
    }
    if(['dna-read','dna-detail'].includes(action)){
      const target=payload?.target;const {validateTarget}=await import('./delivery-queue.mjs');validateTarget(target,localProjectId);
      const query={version:1,action,...(action==='dna-detail'?{id:payload.id}:{}),projectId:target.projectId,...(target.contextId?{contextId:target.contextId}:{}),since:payload.since??0,...(payload.epoch?{epoch:payload.epoch}:{}),...(payload.type?{type:payload.type}:{}),limit:25};
      const reply=target.mode==='local'?await(await dnaStore()).handle(null,query):await(await service()).query(target.fingerprint,target.host,target.port,query);
      return action==='dna-detail'?(await import('../../packages/core/dna-relationships.mjs')).validateDnaDetail(reply,target,payload.id):(await import('../../packages/core/project-dna.mjs')).validateDnaReply(reply,target);
    }
    if(typeof action==='string'&&action.startsWith('runtime-')){
      const target=payload?.target;
      if(!runtimeStore||target?.mode!=='local'||target.projectId!==localProjectId||Object.keys(target).some(k=>!['mode','projectId','contextId'].includes(k)))throw Error('Runtime execution is available only for this desktop’s hosted project/context.');
      return (await runtimeStore()).run(localProjectId,target.contextId,action.slice(8),payload);
    }
    if (typeof action === 'string' && action.startsWith('pulse-') && getPulseClient) {
      const client = await getPulseClient();
      const value = await client.local(localProjectId, action.slice(6), payload);
      if (['pulse-attach','pulse-refresh','pulse-submit','pulse-rebase'].includes(action)) { await client.tick(value.id); return client.local(localProjectId, 'view', {id:value.id}); }
      return value;
    }
    if (action === 'environment-capture') {
      if (capturingEnvironment) throw Error('An environment capture is already running.');
      capturingEnvironment = true;
      try {
        const projects = await getProjects();
        const project = projects.projects.find(item => item.id === localProjectId);
        if (!project) throw Error('Project is unavailable.');
        return await (await import('./environment-capture.mjs')).captureEnvironment(project.localRoot, payload);
      } finally { capturingEnvironment = false; }
    }
    if (typeof action === 'string' && action.startsWith('environment-') && getEnvironmentClient) return (await getEnvironmentClient()).local(localProjectId, action.slice(12), payload);
    if (typeof action === 'string' && action.startsWith('contract-') && getContractClient) return (await getContractClient()).local(localProjectId, action.slice(9), payload);
    if (typeof action === 'string' && action.startsWith('intent-') && getIntentionClient) return (await getIntentionClient()).local(localProjectId, action.slice(7), payload);
    if (action.startsWith('queue-')) {
      const queue = await getQueue();
      if (action === 'queue-retention') return queue.retention(localProjectId,payload.days);
      if (action === 'queue-cleanup') return queue.cleanup(localProjectId);
      if (action === 'queue-list') return queue.list(localProjectId);
      if (action === 'queue-create') return queue.create(localProjectId, payload.target, payload.meta);
      if (action === 'queue-stage') {
        if (!(payload.bytes instanceof ArrayBuffer) || payload.bytes.byteLength > 1024 * 1024) throw Error('Invalid staged chunk.');
        return queue.stage(localProjectId, payload.id, payload.index, Buffer.from(payload.bytes));
      }
      if (['queue-commit','queue-pause','queue-resume','queue-cancel','queue-archive'].includes(action)) return queue.control(localProjectId, payload.id, action.slice(6));
      throw Error('Unsupported queue action.');
    }
    if (action === 'setup') {
      const snapshot = await collaboration.snapshot(localProjectId), remote = await collaboration.remoteStatus();
      return { scopes: [{ projectId: localProjectId, projectName: 'Project files', role: snapshot.role === 'guest' ? 'guest' : 'member' }, ...snapshot.contexts.map(context => ({ projectId: localProjectId, projectName: 'Project files', contextId: context.id, contextName: context.name, role: context.access.canContribute ? 'member' : 'guest' }))], peers: remote.peers.filter(peer => peer.status === 'active').map(peer => ({ fingerprint: peer.fingerprint, displayName: peer.displayName })), ...(await service()).state() };
    }
    const target = payload?.target;
    if (!target || !['local','remote'].includes(target.mode) || Object.keys(target).some(key => !['mode','projectId','contextId','fingerprint','host','port'].includes(key)) || (target.mode === 'local' && (target.projectId !== localProjectId || target.fingerprint !== undefined || target.host !== undefined || target.port !== undefined))) throw Error('Invalid secure content destination.');
    const transport = await service();
    if (action === 'scopes') {
      if (target.mode !== 'remote') throw Error('Choose a verified remote host.');
      const result = await transport.query(target.fingerprint, target.host, target.port, { version: 1, action: 'access' });
      return (await import('./remote-reply.mjs')).validateRemoteReply(result);
    }
    const execute = command => executeFor(localProjectId, target, command);
    if (action === 'operate') {
      const command = payload.command;
      if (!command || !['content-info','content-list','content-create','content-status','content-chunk','content-complete','content-cancel','content-archive'].includes(command.action) || 'projectId' in command || 'contextId' in command || 'version' in command) throw Error('Unsupported content action.');
      if (command.action === 'content-chunk') {
        if (!(payload.bytes instanceof ArrayBuffer) || payload.bytes.byteLength > 1024 * 1024 || 'data' in command) throw Error('Invalid chunk payload.');
        return execute({ ...command, data: Buffer.from(payload.bytes).toString('base64') });
      }
      return execute(command);
    }
    if (!['receive-start','receive-chunk','receive-finish','receive-cleanup'].includes(action)) throw Error('Unsupported secure content action.');
    const { contentId } = await import('../../packages/transfer/secure-content.mjs');
    if (!contentId(payload.id)) throw Error('Invalid shared file.');
    const request = { id: payload.id };
    const cache = await getReceiver();
    if (action === 'receive-cleanup') return cache.cleanup(target,request,execute);
    if (action === 'receive-start') return cache.start(target, request, execute);
    if (action === 'receive-chunk') return cache.chunk(target, { ...request, index: payload.index }, execute);
    if (saving || !dialog) throw Error('A destination dialog is unavailable or already open.');
    saving = true;
    try { return await cache.finish(target, request, execute, async () => {
      const result = await dialog.showOpenDialog(parent(), { title: 'Save verified content in a new EchoDrop folder', properties: ['openDirectory','createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    }); } finally { saving = false; }
  });
}
module.exports = { installSecureContent };
