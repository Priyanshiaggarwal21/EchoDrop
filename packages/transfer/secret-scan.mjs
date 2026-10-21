// Local heuristics only. Results contain categories, never matched values or excerpts.
export const SCAN_LIMIT = 1024 * 1024;
const READ_TIMEOUT = 3000;
const rules = [
  ['Private key material', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,200}\b/],
  ['Stripe secret key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,200}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{35}\b/],
];

export async function scanFile(file) {
  const categories = new Set();
  const limitations = [];
  let timer;
  try {
    const name = file.name.split(/[\\/]/).pop().toLowerCase();
    if (/^\.env(?:\.|$)/.test(name)) categories.add('Environment configuration');
    if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub$)(?:\..*)?|.*\.(?:key|pem|p12|pfx|jks|keystore))$/.test(name)) categories.add('Private key or keystore file');
    if (/^(?:credentials(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|config(?:\.json)?|(?:service[-_]?account|client[-_]?secret).*\.json|terraform\.tfstate(?:\.backup)?)$/.test(name)) categories.add('Credential or access configuration');
    if (file.size > SCAN_LIMIT) limitations.push('Only the first 1 MiB was scanned.');
    const buffer = await Promise.race([
      file.slice(0, SCAN_LIMIT).arrayBuffer(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('scan timeout')), READ_TIMEOUT); }),
    ]);
    // A UTF-8 streaming decode tolerates a final character cut by the size bound.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: file.size > SCAN_LIMIT });
    if (/[\x00-\x08\x0e-\x1f]/.test(text) || /\.(?:zip|7z|rar|gz|tar|pdf|docx?|xlsx?|png|jpe?g|gif|webp|mp[34]|exe|dll)$/i.test(name)) {
      limitations.push('Binary files and archives are not inspected for credentials.');
    } else {
      for (const [category, pattern] of rules) if (pattern.test(text)) categories.add(category);
    }
  } catch {
    limitations.push('The file could not be fully read as UTF-8 text. It may be unreadable, unsupported or the scan timed out.');
  } finally { clearTimeout(timer); }
  return { categories: [...categories], limitations, needsConfirmation: categories.size > 0 || limitations.length > 0 };
}

// The only continuation runs after scanning and, when needed, an explicit boolean yes.
// No consent is persisted or reused for another send/resume attempt.
export async function withSharingCheck(file, confirm, proceed) {
  const result = await scanFile(file);
  if (result.needsConfirmation && await confirm(result) !== true) return false;
  await proceed();
  return true;
}
