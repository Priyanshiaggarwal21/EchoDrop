// Shared strict bootstrap parser. The payload contains only a LAN URL and an invitation token.
(function (root) {
  const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/;
  function token(value) {
    if (typeof value !== 'string' || !tokenPattern.test(value)) throw new Error('Invalid invitation token.');
    return value;
  }
  function origin(value) {
    if (typeof value !== 'string' || value.length > 64) throw new Error('Invalid host LAN URL.');
    const url = new URL(value);
    const parts = url.hostname.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) {
      throw new Error('Use the host private IPv4 LAN URL.');
    }
    const [a, b] = parts.map(Number);
    if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254))
      || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || (value !== url.origin && value !== url.origin + '/')) {
      throw new Error('Use a plain HTTP private IPv4 LAN origin without paths or credentials.');
    }
    return url.origin;
  }
  function create(host, invitationToken) {
    return origin(host) + '/join#' + token(invitationToken);
  }
  function parse(value) {
    if (typeof value !== 'string' || value.length > 160) throw new Error('Invalid invitation payload.');
    const url = new URL(value);
    const host = origin(url.origin);
    const invitationToken = token(url.hash.slice(1));
    if (value !== create(host, invitationToken)) throw new Error('Unexpected invitation fields or encoding.');
    return { host, token: invitationToken };
  }
  const api = { token, origin, create, parse };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EchoDropBootstrap = api;
})(globalThis);
