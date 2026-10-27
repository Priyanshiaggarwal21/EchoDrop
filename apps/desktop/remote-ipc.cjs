const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

function installRemoteCollaboration({ ipcMain, trusted, getStore, getProjects, restoreProjectMetadata, parent, dialog, contentDirectory, safeStorage }) {
  const browserEnrollment = require('./browser-enrollment-ipc.cjs').createBrowserEnrollmentController({getStore,directory:contentDirectory,safeStorage,parent,dialog});
  const recovery = require('./recovery-ipc.cjs').createRecoveryController({getStore,getProjects,restoreProjectMetadata,directory:contentDirectory,safeStorage,parent,dialog});
  let content, intentions, intentionClient, contracts, contractClient, environments, environmentClient, pulse, pulseClient, devices, transport, runtime, dna, guardian, inventory, guardianQueue, picking = false, candidate;
  const dnaHooks = import('./dna-capture-hooks.mjs').then(m=>m.createDnaCaptureHooks(()=>dnaStore()));
  const withDnaCapture = async store => (await dnaHooks).wrap(store);
  const contentStore = () => content ||= Promise.all([getStore(), import('./secure-content-store.mjs')]).then(([store, { createSecureContentStore }]) => createSecureContentStore(contentDirectory(), store)).then(withDnaCapture);
  const intentionStore = () => intentions ||= Promise.all([getStore(), import('./intention-store.mjs')]).then(([store, m]) => m.createIntentionStore(require('node:path').join(contentDirectory(), 'intentions.json'), store));
  const contractStore = () => contracts ||= Promise.all([getStore(), import('./contract-store.mjs')]).then(([store, m]) => m.createContractStore(require('node:path').join(contentDirectory(), 'contracts.json'), store, { validateLink: async (fingerprint, projectId, contextId, id) => {
    let since = 0, epoch; do { const reply = await (await intentionStore()).handle(fingerprint, { version: 1, action: 'intent-sync', projectId, ...(contextId ? { contextId } : {}), since, ...(epoch ? { epoch } : {}) }); if (reply.records.some(record => record.id === id)) return; if (!reply.more) break; since = reply.revision; epoch = reply.epoch; } while (true);
    throw Error('Linked intention is not in this authorized project/context.');
  } })).then(withDnaCapture);
  const environmentStore = () => environments ||= Promise.all([getStore(), import('./environment-store.mjs'), import('./participant-identity.mjs')]).then(([store, m, security]) => m.createEnvironmentStore(require('node:path').join(contentDirectory(), 'environments.json'), store, { protection: security.osIdentityProtection(safeStorage) })).then(withDnaCapture);
  const runtimeStore = () => runtime ||= Promise.all([getStore(), import('./runtime-api.mjs'), import('./participant-identity.mjs')]).then(([store,m,security]) => m.createRuntimeApi(require('node:path').join(contentDirectory(),'runtime-api.json'), {
    protection: security.osIdentityProtection(safeStorage),
    authorize: (projectId,contextId,fingerprint=null) => store.withContentAuthority(fingerprint,projectId,contextId,auth=>auth),
    getContract: async (projectId,contextId,id) => {let since=0,epoch;do{const reply=await (await contractStore()).handle(null,{version:1,action:'contract-sync',projectId,...(contextId?{contextId}:{}),since,...(epoch?{epoch}:{})});const record=reply.records.find(r=>r.id===id);if(record)return record;if(!reply.more)break;since=reply.revision;epoch=reply.epoch;}while(true);throw Error('Approved contract unavailable in this scope.');},
    confirm: async (title,message) => (await dialog.showMessageBox(parent(),{type:'warning',title,message,buttons:['Cancel','Authorize'],defaultId:0,cancelId:0,noLink:true})).response===1
  }));
  const pulseStore = () => pulse ||= Promise.all([getStore(), import('./pulse-store.mjs'), import('./participant-identity.mjs')]).then(([store, m, security]) => m.createPulseStore(require('node:path').join(contentDirectory(), 'pulse.json'), store, { protection: security.osIdentityProtection(safeStorage), collect: async (fingerprint, scope) => {
    const all = async (get, prefix) => { let since = 0, epoch; const records = []; do { const reply = await (await get()).handle(fingerprint, {version:1, action:prefix+'-sync',projectId:scope.projectId,...(scope.contextId?{contextId:scope.contextId}:{}),since,...(epoch?{epoch}:{})}); records.push(...reply.records); if(!reply.more) return records; since=reply.revision; epoch=reply.epoch; if(records.length>100) throw Error('Source capacity exceeded.'); } while(true); };
    const intentions = await all(intentionStore, 'intent'), contracts = await all(contractStore, 'contract'), environments = await all(environmentStore, 'environment');
    const transfers = await (await contentStore()).handle(fingerprint,{version:1,action:'content-list',projectId:scope.projectId,...(scope.contextId?{contextId:scope.contextId}:{})});
    const runtime = await (await runtimeStore()).reports(scope.projectId,scope.contextId,fingerprint);
    return {intentions, contracts, environments, transfers, runtime, guardian:await(await guardianStore()).observations(fingerprint,scope)};
  }})).then(withDnaCapture);
  const inventoryStore = () => inventory ||= Promise.all([getStore(),import('./dependency-inventory.mjs'),import('./participant-identity.mjs')]).then(([store,m,security])=>m.createDependencyInventory(require('node:path').join(contentDirectory(),'dependency-inventory.json'),store,{protection:security.osIdentityProtection(safeStorage)}));
  const guardianStore = () => guardian ||= Promise.all([getStore(),import('./guardian-store.mjs'),import('./participant-identity.mjs')]).then(([store,m,security])=>m.createGuardianStore(require('node:path').join(contentDirectory(),'guardian.json'),store,{protection:security.osIdentityProtection(safeStorage),collect:async(fp,q,auth)=>{const request={version:1,action:'content-list',projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{})};const hosted=await(await contentStore()).handle(null,request),queue=guardianQueue?await(await guardianQueue()).continuity(q.projectId,q.contextId):[];let inventory;try{inventory=await(await inventoryStore()).list(null,q);}catch{/* Missing identity or corrupt inventory is UNKNOWN; never readiness PASS. */}return{inventory:auth.canPlan?inventory:undefined,recoveryEvidence:await recovery.evidence(fp,q),transfers:fp===null?hosted:await(await contentStore()).handle(fp,request),queue:auth.local?queue:[],queueKnown:Boolean(auth.local&&guardianQueue),bindingSources:{inventory,transfers:hosted,queue,queueKnown:Boolean(guardianQueue)}};}})).then(withDnaCapture);
  const dnaStore = () => dna ||= Promise.all([getStore(),import('./project-dna-store.mjs'),import('./participant-identity.mjs')]).then(([store,m,security])=>m.createDnaStore(require('node:path').join(contentDirectory(),'project-dna.json'),store,{protection:security.osIdentityProtection(safeStorage),collect:async(fingerprint,q)=>{
    const auth=await store.withContentAuthority(fingerprint,q.projectId,q.contextId,a=>a);
    const snapshot=await store.snapshotAs(q.projectId,auth.principalId);
    const all=async(get,prefix)=>{let since=0,epoch;const records=[];for(let page=0;page<101;page++){const reply=await(await get()).handle(fingerprint,{version:1,action:prefix+'-sync',projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),since,...(epoch?{epoch}:{})});records.push(...reply.records);if(!reply.more)return records;if(reply.revision<=since)throw Error('Source cursor did not advance.');since=reply.revision;epoch=reply.epoch;}throw Error('DNA source pagination limit reached.');};
    const projects=await getProjects(),project=q.contextId?undefined:projects.projects.find(p=>p.id===q.projectId);
    return{project,members:q.contextId?snapshot.contexts.find(c=>c.id===q.contextId)?.members??[]:snapshot.members,teams:q.contextId?[]:snapshot.teams,contracts:await all(contractStore,'contract'),environments:await all(environmentStore,'environment'),pulse:await all(pulseStore,'pulse'),guardian:await(await guardianStore()).observations(fingerprint,q),transfers:await(await contentStore()).handle(fingerprint,{version:1,action:'content-list',projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{})})};
  }})).then(store=>({...store,handle:async(fp,q)=>({...await store.handle(fp,q),captureIncomplete:Boolean((await dnaHooks).warning(q))})}));
  const deviceStore = () => devices ||= Promise.all([getStore(), import('./device-pairing.mjs'), import('./participant-identity.mjs')]).then(([store,m,security]) => m.createDevicePairing(require('node:path').join(contentDirectory(),'devices.json'),store,{protection:security.osIdentityProtection(safeStorage)}));
  const service = () => transport ||= Promise.all([getStore(), import('./remote-transport.mjs')]).then(([store, { createRemoteTransport }]) => createRemoteTransport(store, contentDirectory ? async (fingerprint, request) => (await contentStore()).handle(fingerprint, request) : undefined, contentDirectory ? async (fingerprint, request) => (await intentionStore()).handle(fingerprint, request) : undefined, contentDirectory ? async (fingerprint, request) => (await contractStore()).handle(fingerprint, request) : undefined, contentDirectory ? async (fingerprint, request) => (await environmentStore()).handle(fingerprint, request) : undefined, contentDirectory ? async (fingerprint, request) => (await pulseStore()).handle(fingerprint, request) : undefined, contentDirectory ? async (fingerprint, request) => (await deviceStore()).handle(fingerprint, request) : undefined, contentDirectory ? async (fingerprint,request)=>(await dnaStore()).handle(fingerprint,request) : undefined, contentDirectory ? async(fingerprint,request)=>(await guardianStore()).handle(fingerprint,request) : undefined, contentDirectory ? async(fingerprint,request)=>(await inventoryStore()).handle(fingerprint,request) : undefined));
  const getIntentionClient = () => intentionClient ||= Promise.all([import('./intention-client.mjs'), import('./participant-identity.mjs')]).then(([m, security]) => m.createIntentionClient(require('node:path').join(contentDirectory(), 'intention-cache.json'), {
    protection: security.osIdentityProtection(safeStorage), authorize: async (id, target) => { const store = await getStore(); await store.snapshot(id); if (target?.mode === 'local') await store.withContentAuthority(null, target.projectId, target.contextId, () => {}); },
    execute: async (localProjectId, target, command) => {
      await (await getStore()).snapshot(localProjectId);
      (await import('./delivery-queue.mjs')).validateTarget(target, localProjectId);
      const request = { ...command, version: 1, projectId: target.projectId, ...(target.contextId ? { contextId: target.contextId } : {}) };
      return target.mode === 'local' ? (await intentionStore()).handle(null, request) : (await service()).query(target.fingerprint, target.host, target.port, request);
    },
  }));
  const getContractClient = () => contractClient ||= Promise.all([import('./intention-client.mjs'), import('./participant-identity.mjs'), import('../../packages/core/contracts.mjs')]).then(([m, security, contracts]) => m.createIntentionClient(require('node:path').join(contentDirectory(), 'contract-cache.json'), {
    model: contracts.contractClientModel,
    protection: security.osIdentityProtection(safeStorage), authorize: async (id, target) => { const store = await getStore(); await store.snapshot(id); if (target?.mode === 'local') await store.withContentAuthority(null, target.projectId, target.contextId, () => {}); },
    execute: async (localProjectId, target, command) => {
      await (await getStore()).snapshot(localProjectId);
      (await import('./delivery-queue.mjs')).validateTarget(target, localProjectId);
      const request = { ...command, version: 1, projectId: target.projectId, ...(target.contextId ? { contextId: target.contextId } : {}) };
      return target.mode === 'local' ? (await contractStore()).handle(null, request) : (await service()).query(target.fingerprint, target.host, target.port, request);
    },
  }));
  const getEnvironmentClient = () => environmentClient ||= Promise.all([import('./intention-client.mjs'), import('./participant-identity.mjs'), import('../../packages/core/environments.mjs')]).then(([m, security, environments]) => m.createIntentionClient(require('node:path').join(contentDirectory(), 'environment-cache.json'), {
    model: environments.environmentClientModel,
    protection: security.osIdentityProtection(safeStorage), authorize: async (id, target) => { const store = await getStore(); await store.snapshot(id); if (target?.mode === 'local') await store.withContentAuthority(null, target.projectId, target.contextId, () => {}); },
    execute: async (localProjectId, target, command) => {
      await (await getStore()).snapshot(localProjectId);
      (await import('./delivery-queue.mjs')).validateTarget(target, localProjectId);
      const request = { ...command, version: 1, projectId: target.projectId, ...(target.contextId ? { contextId: target.contextId } : {}) };
      return target.mode === 'local' ? (await environmentStore()).handle(null, request) : (await service()).query(target.fingerprint, target.host, target.port, request);
    },
  }));
  const getPulseClient = () => pulseClient ||= Promise.all([import('./intention-client.mjs'), import('./participant-identity.mjs'), import('../../packages/core/pulse.mjs')]).then(([m, security, pulse]) => m.createIntentionClient(require('node:path').join(contentDirectory(), 'pulse-cache.json'), {
    model: pulse.pulseClientModel,
    protection: security.osIdentityProtection(safeStorage), authorize: async (id, target) => { const store = await getStore(); await store.snapshot(id); if (target?.mode === 'local') await store.withContentAuthority(null, target.projectId, target.contextId, () => {}); },
    execute: async (localProjectId, target, command) => {
      await (await getStore()).snapshot(localProjectId);
      (await import('./delivery-queue.mjs')).validateTarget(target, localProjectId);
      const request = { ...command, version: 1, projectId: target.projectId, ...(target.contextId ? { contextId: target.contextId } : {}) };
      return target.mode === 'local' ? (await pulseStore()).handle(null, request) : (await service()).query(target.fingerprint, target.host, target.port, request);
    },
  }));
  if (contentDirectory) { let running = false; const timer = setInterval(async () => { if (running) return; running = true; try { await (await getIntentionClient()).tick(); } catch { /* Fail closed; the scope UI reports cache errors. */ } finally { running = false; } }, 1000); timer.unref(); }
  if (contentDirectory) { let running = false; const timer = setInterval(async () => { if (running) return; running = true; try { await (await getContractClient()).tick(); } catch { /* UI surfaces protected-cache failures. */ } finally { running = false; } }, 1000); timer.unref(); }
  if (contentDirectory) { let running = false; const timer = setInterval(async () => { if (running) return; running = true; try { await (await getEnvironmentClient()).tick(); } catch { /* Protected cache failures are surfaced in the workspace. */ } finally { running = false; } }, 1000); timer.unref(); }
  if (contentDirectory) require('./secure-content-ipc.cjs').installSecureContent({ ipcMain, trusted, getStore, service, contentStore, directory: contentDirectory, parent, dialog, safeStorage, getIntentionClient, getContractClient, getEnvironmentClient, getPulseClient, getProjects, runtimeStore, dnaStore, guardianStore, inventoryStore, recovery, setGuardianQueue:get=>{guardianQueue=get;} });
  async function pick(title, max) {
    const selection = await dialog.showOpenDialog(parent(), { title, properties: ['openFile'], filters: [{ name: 'PEM certificate or key', extensions: ['pem', 'crt', 'key'] }] });
    if (selection.canceled || !selection.filePaths[0]) throw Error('Selection cancelled.');
    const handle = await fs.open(selection.filePaths[0], 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > max) throw Error('Selected file is not a supported PEM file.');
      const buffer = Buffer.alloc(max + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > max) throw Error('Selected file is too large.');
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  }
  ipcMain.handle('workspace:remote-collaboration', async (event, projectId, action, value) => {
    trusted(event);
    const store = await getStore();
    // Existing project authorization runs before dialogs, networking or registry access.
    await store.snapshot(projectId);
    if (typeof action==='string' && action.startsWith('browser-')) return browserEnrollment(projectId, action.slice(8), value);
    const remote = await service();
    if (action === 'device-query') {
      const invitation=(await import('../../packages/core/device-pairing.mjs')).parseDeviceInvitation(value?.payload);
      const identity=(await store.remoteStatus()).identity;
      if (!identity || identity.fingerprint!==invitation.recipient || value.confirmedFingerprint!==invitation.fingerprint) throw Error('Verify the host fingerprint and use the invited device identity.');
      if (!['device-request','device-status','device-accept','device-decline','device-reconnect'].includes(value.action)) throw Error('Unsupported device request.');
      if (['device-request','device-accept'].includes(value.action)&&invitation.expiresAt<=Date.now()) throw Error('Invitation expired.');
      const reply=await remote.query(invitation.fingerprint,invitation.host,invitation.port,{version:1,action:value.action,id:invitation.id,...(value.action==='device-request'?{deviceName:value.deviceName}:{})});
      if(reply?.version!==1||reply.id!==invitation.id||reply.fingerprint!==identity.fingerprint||reply.projectId!==invitation.projectId||reply.contextId!==invitation.contextId) throw Error('Pairing reply identity or scope mismatch.');
      return reply;
    }
    if (typeof action==='string'&&action.startsWith('device-')) {
      const result=await (await deviceStore()).local(projectId,action.slice(7),value);
      if(action==='device-revoke') await remote.stop();
      return result;
    }
    if (action === 'status') return { ...(await store.remoteStatus()), ...remote.state() };
    if (action === 'start') return remote.start();
    if (action === 'stop') return remote.stop();
    if (action === 'import-identity' || action === 'select-peer') {
      if (!dialog || picking) throw Error('A native certificate selection is unavailable or already open.');
      picking = true;
      try {
        const { readCertificate } = await import('./remote-identity.mjs');
        const cert = readCertificate(await pick('Choose a participant public certificate (PEM)', 16384));
        if (action === 'select-peer') {
          candidate = { token: randomUUID(), projectId, certificate: cert.certificate, expires: Date.now() + 300000 };
          return { token: candidate.token, fingerprint: cert.fingerprint, expiresAt: cert.expiresAt };
        }
        const key = await pick('Choose your matching private key (PEM). Never choose another personâ€™s key.', 32768);
        try { await store.remoteLocal(projectId, 'import-identity', { certificate: cert.certificate, key }); }
        catch { throw Error('Could not import identity. Check matching unencrypted PEM key, supported certificate and OS protection. Existing identity is never replaced.'); }
        return { ...(await store.remoteStatus()), ...remote.state() };
      } finally { picking = false; }
    }
    if (action === 'trust-peer') {
      if (!value || Object.keys(value).some(key => !['token', 'principalId', 'fingerprint'].includes(key)) || !candidate || candidate.token !== value.token || candidate.projectId !== projectId || candidate.expires <= Date.now()) throw Error('Select the peer certificate again.');
      await store.remoteLocal(projectId, action, { certificate: candidate.certificate, principalId: value.principalId, fingerprint: value.fingerprint });
      candidate = undefined; await remote.stop();
    } else if (['create-invitee', 'offer', 'revoke', 'revoke-peer'].includes(action)) {
      await store.remoteLocal(projectId, action, value);
      if (action === 'revoke-peer') await remote.stop();
    } else if (action === 'query') {
      if (!value || Object.keys(value).some(key => !['fingerprint', 'host', 'port', 'request'].includes(key))) throw Error('Invalid peer request.');
      const result = await remote.query(value.fingerprint, value.host, value.port, value.request);
      const { validateRemoteReply } = await import('./remote-reply.mjs');
      return validateRemoteReply(result);
    } else throw Error('Unsupported remote collaboration action.');
    return { ...(await store.remoteStatus()), ...remote.state() };
  });
}
module.exports = { installRemoteCollaboration };
