import selfsigned from 'selfsigned';

const extensions = (altNames, isCA = false) => [
  { name: 'basicConstraints', cA: isCA },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, ...(isCA ? { keyCertSign: true } : {}) },
  { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
  ...(altNames ? [{ name: 'subjectAltName', altNames }] : [])
];

export async function createTestCredentials(commonName, altNames, isCA = false) {
  const generated = await selfsigned.generate([{ name: 'commonName', value: commonName }], {
    keySize: 3072,
    days: 365,
    algorithm: 'sha256',
    extensions: extensions(altNames, isCA),
    ...(isCA ? { clientCertificate: true } : {})
  });
  return {
    certificate: generated.cert,
    key: generated.private,
    ...(isCA ? { child: { certificate: generated.clientcert, key: generated.clientprivate } } : {})
  };
}

export async function createExpiredCertificate() {
  const generated = await selfsigned.generate([{ name: 'commonName', value: 'EchoDrop TEST ONLY expired' }], {
    keySize: 3072,
    algorithm: 'sha256',
    notBeforeDate: new Date('2020-01-01T00:00:00Z'),
    notAfterDate: new Date('2020-01-02T00:00:00Z'),
    extensions: extensions()
  });
  return generated.cert;
}

export async function createSignedChildCredentials(ca) {
  return ca.child;
}
