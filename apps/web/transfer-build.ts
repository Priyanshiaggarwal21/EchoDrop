// Bundle the existing incremental implementation unchanged, including HTTP LAN support.
export const transferHash = { name: 'echodrop-transfer-hash', transform(code: string, id: string) {
  if (id.replaceAll('\\', '/').endsWith('/packages/transfer/browser-sha256.js')) return code + '\nexport { sha256File };';
} };
