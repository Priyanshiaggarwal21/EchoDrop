/* ggwave 0.4.0 runs only in this isolated worker; no credentials or file data are accepted. */
importScripts('/onboarding/bootstrap.js', '/onboarding/ggwave.js');
let codec, instance;
const ready = ggwave_factory({ wasmBinary: EchoDropGgWaveBinary, print() {}, printErr() {} }).then((value) => {
  codec = value;
  codec.disableLog();
});
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    await ready;
    if (type === 'init') {
      if (!Number.isInteger(data.rate) || data.rate < 8000 || data.rate > 96000) throw new Error('Unsupported audio sample rate.');
      if (instance !== undefined) codec.free(instance);
      const parameters = codec.getDefaultParameters();
      parameters.sampleRateInp = data.rate;
      parameters.sampleRateOut = data.rate;
      parameters.operatingMode |= codec.GGWAVE_OPERATING_MODE_USE_DSS;
      instance = codec.init(parameters);
      if (instance < 0) throw new Error('ggwave initialization failed.');
      self.postMessage({ id, ready: true });
    } else if (type === 'encode') {
      EchoDropBootstrap.parse(data.payload);
      if (instance === undefined || new TextEncoder().encode(data.payload).length > 140) throw new Error('Unsupported acoustic payload.');
      const waveform = codec.encode(instance, data.payload, codec.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 10);
      const copy = new Int8Array(waveform).buffer;
      self.postMessage({ id, waveform: copy }, [copy]);
    } else if (type === 'decode') {
      if (instance === undefined || !(data.samples instanceof ArrayBuffer) || data.samples.byteLength > 65536 || data.samples.byteLength % 4) {
        throw new Error('Invalid audio frame.');
      }
      const decoded = codec.decode(instance, new Int8Array(data.samples));
      let payload = '';
      if (decoded.length) {
        payload = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
        EchoDropBootstrap.parse(payload);
      }
      self.postMessage({ id, payload });
    } else throw new Error('Unsupported acoustic operation.');
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
