import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from './WorkspaceApp';
import { PairingPage } from './Pairing';
const root = document.getElementById('omni-root')!;
createRoot(root).render(root.dataset.page === 'join' || root.dataset.page === 'host' ? <PairingPage host={root.dataset.page === 'host'}/> : <WorkspaceApp lan />);
