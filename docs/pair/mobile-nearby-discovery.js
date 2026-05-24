import { $ } from "../dom.js";
import { discover } from "../signal-sdk/v1/discover.js";
import { getMyPubkeyB64 } from "../signal-sdk/v1/peer-key.js";
import { pairRequestClient } from "../signal-sdk/v1/pair-request.js";

// LAN discovery — request/accept flow.
//
// We publish a "better-robotics-phone" presence ad always-on while in
// showReconnect, so dashboards on the wifi see us (and may auto-accept
// us if they've trusted us). We subscribe for "better-robotics-mac"
// presence ads to populate the tappable list. Tapping a Mac publishes a
// signed pair-request targeted at its pubkey; the Mac prompts its user
// (or auto-accepts), then publishes a pair-response with a fresh roomId.
// We navigate to that room and the WebRTC pair starts.
//
// No three-state UI on the phone — trust is decided in the prompt on the
// Mac side. Every nearby Mac is uniformly tappable.

let _lobby = null;
let _myPubkey = null;
let _wssPairClient = null;

export function deviceLabel() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  return "Phone";
}

function setNearbyStatus(text, kind) {
  const status = $("phone-nearby-status");
  if (!status) return;
  if (!text) { status.hidden = true; status.textContent = ""; status.className = "phone-nearby-status"; return; }
  status.hidden = false;
  status.textContent = text;
  status.className = "phone-nearby-status" + (kind ? " " + kind : "");
}

function getWssPairClient() {
  if (!_wssPairClient) _wssPairClient = pairRequestClient({ app: 'better-robotics-pair', sign: true, lobby: _lobby });
  return _wssPairClient;
}

async function requestPairWith(macAd) {
  if (!macAd.data._pubkey) return;
  const macLabel = macAd.data.label || 'this computer';
  setNearbyStatus(`Asking ${macLabel} to pair…`);
  const client = getWssPairClient();
  const result = await client.request({
    payload: { target: macAd.data._pubkey, label: deviceLabel() },
  });
  if (result.accepted && result.data && result.data.roomId) {
    setNearbyStatus('Accepted — connecting…');
    // Mac trusts us per its own "Trust this phone" checkbox decision;
    // we don't auto-trust back because the phone has no surface for
    // the reciprocal choice yet. Leave trust binding to the explicit
    // QR path (mobile.js init already calls _trust.trust when pk rides
    // in on the QR hash, and the pair-keys data-channel handshake
    // refreshes the label).
    location.replace(location.pathname + '#pair=' + result.data.roomId);
    location.reload();
    return;
  }
  // Distinguish the three failure paths so the user knows whether to
  // try again (network), check on the other device (timeout), or stop
  // trying (denied).
  if (result.reason === 'error') {
    setNearbyStatus(`Couldn't reach the lobby. Check your wifi and try again.`, 'alert');
    return;
  }
  if (result.reason === 'timeout') {
    setNearbyStatus(`No response from ${macLabel}. They may have missed the prompt — try again.`, 'alert');
    return;
  }
  setNearbyStatus('Pair declined.', 'alert');
}

export async function startNearbyDiscovery() {
  if (_lobby) return;  // idempotent — init might call us twice across reconnects
  _lobby = discover({ sign: true });
  _myPubkey = await getMyPubkeyB64();

  // Publish phone presence so the dashboard sees "iPhone on wifi" even
  // before we initiate anything. discover.js auto-republishes; the ad
  // TTLs out within 60s of tab close.
  const phoneAdId = "better-robotics-phone:" + _myPubkey;
  _lobby.publish(phoneAdId, {
    app: "better-robotics-phone",
    label: deviceLabel(),
  }, 60000);

  const wrap = $("phone-nearby");
  const list = $("phone-nearby-list");
  const emptyHint = $("phone-nearby-empty-hint");
  if (!wrap || !list) return;
  // Empty-lobby hint after 10s surfaces the common culprit (iCloud Private
  // Relay / VPN splits the phone onto a different public IP than the Mac,
  // and the Lobby groups by public IP). Cleared as soon as any mac appears.
  const hintTimer = setTimeout(() => {
    if (emptyHint && wrap.hidden) emptyHint.hidden = false;
  }, 10000);
  // Diff against the last-rendered pubkey set so 60s-TTL ad churn doesn't
  // tear down + rebuild the list (with fresh click listeners) on every
  // re-publish when nothing changed.
  let lastKey = "";
  _lobby.onChange((ads) => {
    const macs = ads.filter(a => a.data && a.data.app === "better-robotics-mac" && a.data._pubkey);
    // Multiple tabs in the same browser profile share an Ed25519 identity
    // (one IndexedDB-backed key per origin), so they're the same trust peer.
    // Collapse to one row per pubkey — distinct identities (incognito,
    // other profiles, other browsers) keep their own row.
    const byPubkey = new Map();
    for (const ad of macs) if (!byPubkey.has(ad.data._pubkey)) byPubkey.set(ad.data._pubkey, ad);
    const unique = [...byPubkey.values()];
    const key = unique.map(a => `${a.data._pubkey}|${a.data.label || ""}`).sort().join(";");
    if (key === lastKey) return;
    lastKey = key;
    list.innerHTML = "";
    if (!unique.length) { wrap.hidden = true; return; }
    clearTimeout(hintTimer);
    if (emptyHint) emptyHint.hidden = true;
    wrap.hidden = false;
    // Fingerprint suffix only when multiple identities are visible — single-
    // mac case stays clean. 4 chars of base64 ≈ 14M space, plenty to
    // disambiguate the handful a phone would ever see at once.
    const showFp = unique.length > 1;
    for (const ad of unique) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "phone-nearby-btn";
      const label = ad.data.label || "this computer";
      const fp = showFp ? ` · ${ad.data._pubkey.slice(0, 4)}` : "";
      btn.textContent = `Pair with ${label}${fp}`;
      btn.addEventListener("click", () => requestPairWith(ad));
      list.appendChild(btn);
    }
  });
}
