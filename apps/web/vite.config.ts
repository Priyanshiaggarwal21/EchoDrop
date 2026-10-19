import { defineConfig } from 'vite';
import { transferHash } from './transfer-build';
export default defineConfig({ base: './', plugins: [transferHash] });
