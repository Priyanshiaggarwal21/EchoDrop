import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Transport } from './transfer-api';
import type { PairAPI } from './pairing-api';
import type { PreviewBridge } from './LivePreview';
import { WorkspaceApp } from './WorkspaceApp';
type Snapshot = {
  health: { timestamp: string };
  state: import('./pairing-api').HostState;
  files: string;
};
declare global {
  interface Window {
    echoDesktop?: {
      secureContent: import('./ProjectTransfers').SecureContentBridge;
      remoteCollaboration: import('./RemoteCollaboration').RemoteBridge;
      collaboration: import('../../../packages/core/collaboration.mjs').CollaborationBridge;
      registry: import('../../../packages/core/projects.mjs').ProjectRegistryBridge;
      onNavigation(callback: (direction: 'back' | 'forward') => void): () => void;
      restore(): Promise<{ ready: boolean }>;
      start(): Promise<{ ready: boolean }>;
      state(): Promise<Snapshot>;
      open(area: 'files' | 'devices' | 'preview'): Promise<void>;
      transfer: Transport;
      download(path: string): Promise<void>;
      pairing: PairAPI;
      preview: PreviewBridge;
      project: import('./ProjectShare').ProjectBridge;
    };
  }
}

createRoot(document.getElementById('root')!).render(<WorkspaceApp />);
