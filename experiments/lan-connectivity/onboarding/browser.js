(function (root) {
  function mediaAvailable() {
    return root.isSecureContext && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
  }
  function drawQR(canvas, payload) {
    EchoDropBootstrap.parse(payload);
    const qr = qrcode(0, 'M');
    qr.addData(payload, 'Byte');
    qr.make();
    const count = qr.getModuleCount(), scale = 5, margin = 4;
    canvas.width = canvas.height = (count + margin * 2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black';
    for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
      if (qr.isDark(y, x)) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  }
  function scanImage(source, width, height) {
    if (!width || !height || width * height > 16000000) throw new Error('Image dimensions are unsupported.');
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(image.data, image.width, image.height);
    if (!result) return null;
    EchoDropBootstrap.parse(result.data);
    return result.data;
  }
  async function scanFile(file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      throw new Error('Choose a PNG, JPEG or WebP QR image under 8 MiB.');
    }
    const image = await createImageBitmap(file);
    try {
      const payload = scanImage(image, image.width, image.height);
      if (!payload) throw new Error('No invitation QR found. Use a clearer image or manual entry.');
      return payload;
    } finally { image.close(); }
  }
  async function camera(video, onPayload, onStatus, signal) {
    if (!mediaAvailable()) throw new Error('Live camera unavailable on this HTTP LAN page. Use a QR photo/file, the phone camera app, or manual entry.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    if (signal?.aborted) { stream.getTracks().forEach((track) => track.stop()); throw new Error('Capture stopped.'); }
    let stopped = false, frame, timer;
    function stop() {
      stopped = true; cancelAnimationFrame(frame); clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop()); video.srcObject = null;
    }
    signal?.addEventListener('abort', stop, { once: true });
    try {
      video.srcObject = stream; await video.play();
      const scan = () => {
        if (stopped) return;
        try {
          const payload = video.videoWidth && scanImage(video, video.videoWidth, video.videoHeight);
          if (payload) { stop(); onPayload(payload); return; }
        } catch (error) { onStatus(error.message); }
        frame = requestAnimationFrame(scan);
      };
      scan();
      timer = setTimeout(() => { stop(); onStatus('Camera stopped after 30 seconds. Use manual entry or try again.'); }, 30000);
      return stop;
    } catch (error) { stop(); throw error; }
  }
  function worker() {
    const instance = new Worker('/onboarding/acoustic-worker.js');
    const pending = new Map(); let next = 0;
    instance.onmessage = ({ data }) => {
      const entry = pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error)); else entry.resolve(data);
    };
    function close() {
      instance.terminate();
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Audio stopped.')); }
      pending.clear();
    }
    instance.onerror = close;
    return {
      close,
      call(type, values = {}) {
        return new Promise((resolve, reject) => {
          if (pending.size >= 16) { reject(new Error('Audio processing cannot keep up. Use QR/manual.')); return; }
          const id = ++next;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Acoustic codec unavailable or timed out. Use QR/manual.')); }, 10000);
          pending.set(id, { resolve, reject, timer });
          instance.postMessage({ id, type, ...values });
        });
      },
    };
  }
  function audioContext() {
    const Audio = root.AudioContext || root.webkitAudioContext;
    if (!Audio || !root.Worker || !root.WebAssembly) throw new Error('Experimental audio is unsupported. Use QR/manual.');
    return new Audio({ sampleRate: 48000 });
  }
  async function transmit(payload, onStatus, signal) {
    EchoDropBootstrap.parse(payload);
    const context = audioContext(), codec = worker();
    let source, stopped = false;
    const stop = () => { if (stopped) return; stopped = true; if (source) { try { source.stop(); } catch {} } codec.close(); context.close().catch(() => {}); };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await context.resume();
      await codec.call('init', { rate: context.sampleRate });
      const result = await codec.call('encode', { payload });
      if (signal?.aborted) throw new Error('Audio stopped.');
      const samples = new Float32Array(result.waveform);
      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.copyToChannel(samples, 0);
      source = context.createBufferSource(); source.buffer = buffer;
      const gain = context.createGain(); gain.gain.value = 0.5; // ggwave already encodes at 10% amplitude.
      source.connect(gain); gain.connect(context.destination);
      source.onended = () => { stop(); onStatus('Experimental audio sent; reception is not confirmed.'); };
      source.start();
      onStatus('Sending experimental invitation quietly. Stop is available.');
      return stop;
    } catch (error) { stop(); throw error; }
  }
  async function listen(onPayload, onStatus, signal) {
    if (!mediaAvailable()) throw new Error('Microphone unavailable on HTTP LAN (including Android). Use manual entry or QR.');
    const context = audioContext(), codec = worker();
    let stream, recorder, input, timer, stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true; clearTimeout(timer);
      if (recorder) { recorder.onaudioprocess = null; recorder.disconnect(); }
      if (input) input.disconnect();
      if (stream) stream.getTracks().forEach((track) => track.stop());
      codec.close(); context.close().catch(() => {});
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await context.resume();
      // Called only from an explicit microphone button, never on page load.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (signal?.aborted) { stream.getTracks().forEach((track) => track.stop()); throw new Error('Capture stopped.'); }
      if (!context.createScriptProcessor) throw new Error('This browser audio decoder is unsupported. Use QR/manual.');
      await codec.call('init', { rate: context.sampleRate });
      input = context.createMediaStreamSource(stream);
      recorder = context.createScriptProcessor(1024, 1, 1);
      recorder.onaudioprocess = (event) => {
        event.outputBuffer.getChannelData(0).fill(0); // Never play microphone feedback.
        if (stopped) return;
        const samples = new Float32Array(event.inputBuffer.getChannelData(0)).buffer;
        codec.call('decode', { samples }).then((result) => {
          if (result.payload && !stopped) { stop(); onPayload(result.payload); }
        }).catch((error) => { if (!stopped) { stop(); onStatus(error.message); } });
      };
      input.connect(recorder); recorder.connect(context.destination);
      timer = setTimeout(() => { stop(); onStatus('No acoustic invitation decoded in 30 seconds. Use QR/manual.'); }, 30000);
      onStatus('Experimental microphone listening (30 seconds maximum).');
      return stop;
    } catch (error) { stop(); throw error; }
  }
  root.EchoDropOnboarding = { mediaAvailable, drawQR, scanFile, camera, transmit, listen };
})(globalThis);
