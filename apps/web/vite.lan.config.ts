import { defineConfig } from 'vite';
import { transferHash } from './transfer-build';
export default defineConfig({ plugins: [transferHash], define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: {
  outDir: 'dist/lan', lib: { entry: 'src/lan.tsx', name: 'EchoDropOmni', formats: ['iife'], fileName: () => 'omnidrop.js', cssFileName: 'omnidrop' },
} });
