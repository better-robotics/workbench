// ICE config for the robot↔desktop WebRTC paths (webrtc-robot.js,
// webrtc-installable.js) — flows that can cross NAT-hostile LANs (AP
// isolation, VPNs). Phone↔desktop pairing deliberately uses NO ice
// servers: it is LAN-only by design since signaling moved to the hub
// broker (pair/broker-signal.js).
//
// The TURN proxy mints short-lived Cloudflare Realtime creds. STUN stays
// in line as a zero-roundtrip fallback so a degraded proxy (offline,
// rate-limited, mis-deployed) still gives STUN-only instead of nothing.
import { TURN_URL } from "../endpoints.js";

const STUN_FALLBACK = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export async function fetchIceServers() {
  try {
    const r = await fetch(TURN_URL, { method: "POST" });
    if (!r.ok) throw new Error(`turn: ${r.status}`);
    const { iceServers } = await r.json();
    return [...STUN_FALLBACK, ...iceServers];
  } catch {
    return STUN_FALLBACK;
  }
}
