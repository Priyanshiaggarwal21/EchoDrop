export type PairAPI = <T>(path: string, body?: Record<string, string>) => Promise<T>;
export type HostState = { requests: { id: string; deviceName: string; expiresAt: number }[]; devices: { id: string; deviceName: string; expiresAt: number }[]; lanUrls: string[] };
export const pairingAPI: PairAPI = async (path, body) => {
  const response = await fetch(path, body === undefined ? { signal: AbortSignal.timeout(10000) } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status}).`);
  return response.json();
};
type Capture = (payload: string) => void;
type Status = (message: string) => void;
declare global {
  interface Window {
    EchoDropBootstrap: { parse(payload: string): { host: string; token: string }; create(host: string, token: string): string; token(value: string): string; origin(value: string): string };
    EchoDropOnboarding: {
      mediaAvailable(): boolean; drawQR(canvas: HTMLCanvasElement, payload: string): void; scanFile(file: File): Promise<string>;
      camera(video: HTMLVideoElement, payload: Capture, status: Status, signal: AbortSignal): Promise<() => void>;
      transmit(payload: string, status: Status, signal: AbortSignal, event?: Status): Promise<() => void>;
      listen(payload: Capture, status: Status, signal: AbortSignal, event?: Status): Promise<() => void>;
    };
  }
}
