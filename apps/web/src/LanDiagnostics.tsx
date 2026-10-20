import React from 'react';

export function LanDiagnostics({ origin }: { origin?: string | undefined }) {
  return <details className="lan-diagnostics">
    <summary>Connection help and reachability check</summary>
    {origin && <p className="fine">On the phone, open <code>{origin}/health</code>. A server response confirms HTTP reachability from that phone only, not workspace authorization.</p>}
    <ul className="fine">
      <li>Use the laptop’s Wi-Fi IPv4 address and current port, not localhost, a VPN or a virtual adapter. Connect both devices to the same trusted Wi-Fi. Matching network names alone do not prove that clients can reach each other.</li>
      <li>If the phone times out but the laptop responds, check Windows Security’s firewall app permissions for the running Electron app (Node.js for the standalone server), on your trusted Private network. Do not disable the firewall. This app does not inspect firewall rules.</li>
      <li>Guest Wi-Fi and router AP/client isolation can block devices on the same Wi-Fi. Use a network that permits local client traffic, or ask its administrator. A timeout cannot distinguish this from a firewall or routing problem.</li>
      <li>Keep the host awake and EchoDrop open. After a network change, refresh host addresses and create a new invitation. After restarting the host, use its new port and rejoin; old sessions and invitations are invalid.</li>
      <li>Invalid, expired or already-used invitation: request a fresh code. Invitations last two minutes and can be used once. Rejected requests require a fresh invitation and host approval.</li>
      <li>Android plain-HTTP pages may block live camera/microphone access. Use the phone camera app, a QR image, or manual entry. Acoustic hardware support remains unverified.</li>
    </ul>
    <p className="fine">LAN transport is plain HTTP. Local service readiness does not prove phone reachability.</p>
  </details>;
}
