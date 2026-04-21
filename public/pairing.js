// Two-browser WebRTC pairing against signal.neevs.io with catwatcher-style
// resilience — the signaling WebSocket stays open for the life of the
// session, carries ICE trickles both ways, and survives transient drops
// via ICE restart instead of a fresh pair flow. Only a hard failure
// (channel closed and ICE restart didn't recover within the grace window)
// counts as "disconnected, rescan QR".
//
// Signal protocol (~/Github/jonasneves/signal/src/server/room.js):
//   connect wss://signal.neevs.io/{room}/ws
//   send   { type: "signal", peer: myRole, data: { offer|answer|ice } }
//   recv   { type: "state",  peers: {...} }           // once, on connect
//          { type: "signal", peer: theirRole, data: {...} }
//
// Protocol roles: phone is OFFERER (joins second, has something to offer),
// desktop is ANSWERER. The signal server sends `state` only on connect and
// doesn't broadcast peer-joined events, so making the side-that-joins-last
// kick off the offer is the only natural ordering that works.
const SIGNAL_WS_URL = "wss://signal.neevs.io";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const HEARTBEAT_MS = 20000;   // Cloudflare closes idle WebSockets ~100s; ping well below that.
const DISCONNECT_GRACE_MS = 10000;  // Transient ICE `disconnected` can recover on its own.
// Backpressure: DataChannel.bufferedAmount grows unbounded if we outrun the
// peer. Text/joypad traffic is tiny so we rarely get near this; the queue is
// insurance for whoever later ships camera frames or audio chunks over the
// same channel. Queue drops oldest at QUEUE_MAX so a wedged receiver doesn't
// OOM the sender.
const BACKPRESSURE_HIGH = 1_000_000;
const BACKPRESSURE_LOW  =   200_000;
const QUEUE_MAX = 1000;

// Peer — JSON-framed data channel wrapper with a multi-state status channel
// so UI can show connecting / connected / reconnecting / failed accurately.
class Peer {
  constructor({ pc, channel, ws, myRole, roomId }) {
    this._pc = pc;
    this._channel = channel;
    this._ws = ws;
    this._myRole = myRole;
    // roomId lets us reopen the signaling WS when iOS backgrounds the tab
    // and silently kills it — we rejoin the same room instead of a fresh pair.
    this._roomId = roomId;
    this._onMessage = () => {};
    this._onStatus = () => {};
    this._onClose = () => {};
    this._status = "connected";
    this._graceTimer = null;
    this._heartbeatTimer = null;
    this._sendQueue = [];
    this._reopening = false;
    this._visibilityHandler = null;

    channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW;
    channel.addEventListener("bufferedamountlow", () => this._drainQueue());
    channel.addEventListener("message", (e) => {
      try { this._onMessage(JSON.parse(e.data)); } catch { /* drop malformed */ }
    });
    channel.addEventListener("close", () => {
      // Data channel gone is terminal — can't recover without rebuilding PC.
      this._setStatus("failed", "Data channel closed");
      this._finalClose();
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
        this._setStatus("connected");
      } else if (s === "disconnected") {
        // Often recovers on its own (e.g. phone tab re-foregrounded). Wait.
        this._setStatus("reconnecting", "Connection dropped, waiting…");
        if (!this._graceTimer) {
          this._graceTimer = setTimeout(() => {
            this._graceTimer = null;
            if (pc.iceConnectionState === "disconnected") {
              // Still stuck — ask WebRTC to rebuild the path.
              this._attemptIceRestart();
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (s === "failed") {
        this._setStatus("reconnecting", "Restarting connection…");
        this._attemptIceRestart();
      }
    });

    this._startHeartbeat();
    this._installSignalHandlers();
    this._installVisibilityRecovery();
  }

  _setStatus(status, detail) {
    if (this._status === status) return;
    this._status = status;
    try { this._onStatus(status, detail); } catch {}
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      if (this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send(JSON.stringify({ type: "ping" })); } catch {}
      }
    }, HEARTBEAT_MS);
  }

  // Only the phone (offerer) initiates an ICE restart. Desktop sits and waits
  // for the fresh offer — its existing signal handler will set the remote
  // description and answer, same as initial negotiation.
  async _attemptIceRestart() {
    if (this._myRole !== "phone") return;
    try {
      this._pc.restartIce();
      const offer = await this._pc.createOffer({ iceRestart: true });
      await this._pc.setLocalDescription(offer);
      this._ws.send(JSON.stringify({ type: "signal", peer: this._myRole, data: { offer } }));
    } catch (err) {
      // If restart itself fails, mark failed and let the caller rebuild.
      this._setStatus("failed", `Restart failed: ${err.message || err}`);
      this._finalClose();
    }
  }

  // Signals after data channel is up — subsequent offer/answer rounds for
  // ICE restart, and late-arriving ICE candidates.
  _installSignalHandlers() {
    this._ws.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== "signal" || msg.peer === this._myRole) return;
      try {
        if (msg.data?.offer) {
          await this._pc.setRemoteDescription(msg.data.offer);
          const answer = await this._pc.createAnswer();
          await this._pc.setLocalDescription(answer);
          this._ws.send(JSON.stringify({ type: "signal", peer: this._myRole, data: { answer } }));
        }
        if (msg.data?.answer) await this._pc.setRemoteDescription(msg.data.answer);
        if (msg.data?.ice)   { try { await this._pc.addIceCandidate(msg.data.ice); } catch {} }
      } catch (err) {
        console.warn("[pairing] signal handling error", err);
      }
    });
  }

  // iOS Safari kills idle WebSockets when the tab backgrounds; even a 20s
  // heartbeat can't save it. When the tab comes back, the data channel may
  // still negotiate but the signal WS is gone, so any ICE restart we try
  // sends into the void. Rejoin the same room first, rewire handlers, then
  // kick an ICE restart — gets us from "frozen" to recovered in ~1s instead
  // of waiting for the eventual ICE failure timeout.
  _installVisibilityRecovery() {
    if (typeof document === "undefined") return;
    this._visibilityHandler = () => {
      if (document.visibilityState !== "visible") return;
      const s = this._ws.readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
      if (this._reopening) return;
      this._reopenSignal();
    };
    document.addEventListener("visibilitychange", this._visibilityHandler);
  }

  _reopenSignal() {
    this._reopening = true;
    this._setStatus("reconnecting", "Signal channel dropped, reopening…");
    const newWs = openSignalWs(this._roomId);
    newWs.addEventListener("open", () => {
      const oldWs = this._ws;
      this._ws = newWs;
      this._installSignalHandlers();
      // ICE-trickle handler on the PC uses this._ws via the closure in
      // wireIceTrickle — old handler still exists but its captured ws is
      // closed, so its send() guard (readyState === OPEN) skips. Harmless
      // extra listener; avoids an awkward removeEventListener dance.
      wireIceTrickle(this._pc, this._ws, this._myRole);
      try { oldWs.close(); } catch {}
      this._reopening = false;
      this._attemptIceRestart();
    });
    newWs.addEventListener("error", () => {
      this._reopening = false;
      this._setStatus("failed", "Signal reconnect failed");
      this._finalClose();
    });
  }

  _drainQueue() {
    while (this._sendQueue.length > 0
           && this._channel.readyState === "open"
           && this._channel.bufferedAmount < BACKPRESSURE_HIGH) {
      try { this._channel.send(this._sendQueue.shift()); } catch { break; }
    }
  }

  _finalClose() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    try { this._ws.close(); } catch {}
    try { this._onClose(); } catch {}
  }

  send(obj) {
    if (this._channel.readyState !== "open") return;
    const payload = JSON.stringify(obj);
    // Queue if we're above the high-water mark OR the queue is already
    // draining — draining in order matters, so never jump the line.
    if (this._channel.bufferedAmount > BACKPRESSURE_HIGH || this._sendQueue.length > 0) {
      if (this._sendQueue.length >= QUEUE_MAX) this._sendQueue.shift();
      this._sendQueue.push(payload);
      return;
    }
    try { this._channel.send(payload); } catch {}
  }
  onMessage(cb) { this._onMessage = cb; }
  onStatus(cb)  { this._onStatus = cb; try { cb(this._status); } catch {} }  // fire initial
  onClose(cb)   { this._onClose = cb; }
  close() {
    this._setStatus("failed", "Closed by caller");
    this._finalClose();
    try { this._channel.close(); } catch {}
    try { this._pc.close(); } catch {}
  }
}

function openSignalWs(roomId) {
  return new WebSocket(`${SIGNAL_WS_URL}/${roomId}/ws`);
}

function wireIceTrickle(pc, ws, myRole) {
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { ice: e.candidate } }));
    }
  });
}

// Desktop: opens the room, waits for the phone's offer, answers.
// Returns { roomId, waitForPeer: () => Promise<Peer>, cancel() }.
// onStatus fires at pre-Peer stages ("phone connected, negotiating…",
// "establishing channel…") so the pair dialog can show distinct states
// instead of a frozen "waiting for phone" when something's silently wedged.
export function hostPairingRoom({ onStatus = () => {} } = {}) {
  const roomId = crypto.randomUUID();
  const myRole = "desktop";
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ws = openSignalWs(roomId);
  wireIceTrickle(pc, ws, myRole);
  let resolvePeer, rejectPeer;
  const peerPromise = new Promise((res, rej) => { resolvePeer = res; rejectPeer = rej; });
  let resolved = false;

  pc.addEventListener("datachannel", (e) => {
    try { onStatus("Phone connected, establishing channel…"); } catch {}
    e.channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      resolvePeer(new Peer({ pc, channel: e.channel, ws, myRole, roomId }));
    });
  });

  ws.addEventListener("message", async (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== "signal" || msg.peer === myRole) return;
    if (msg.data?.offer) {
      try { onStatus("Phone connected, negotiating…"); } catch {}
      await pc.setRemoteDescription(msg.data.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { answer } }));
    }
    if (msg.data?.ice) { try { await pc.addIceCandidate(msg.data.ice); } catch {} }
  });

  ws.addEventListener("error", () => {
    if (!resolved) { resolved = true; pc.close(); rejectPeer(new Error("signal socket failed")); }
  });

  return {
    roomId,
    waitForPeer: () => peerPromise,
    cancel: () => { ws.close(); pc.close(); },
  };
}

// Phone: joins the room, creates data channel + offer on WS open, processes answer.
export function joinPairingRoom(roomId) {
  const myRole = "phone";
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("pip");
  const ws = openSignalWs(roomId);
  wireIceTrickle(pc, ws, myRole);

  return new Promise((resolve, reject) => {
    let resolved = false;
    const fail = (err) => { if (!resolved) { resolved = true; try { ws.close(); } catch {} try { pc.close(); } catch {} reject(err); } };

    channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      resolve(new Peer({ pc, channel, ws, myRole, roomId }));
    });

    ws.addEventListener("open", async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { offer } }));
      } catch (err) { fail(err); }
    });

    ws.addEventListener("message", async (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== "signal" || msg.peer === myRole) return;
      if (msg.data?.answer) await pc.setRemoteDescription(msg.data.answer);
      if (msg.data?.ice)   { try { await pc.addIceCandidate(msg.data.ice); } catch {} }
    });

    ws.addEventListener("error", () => fail(new Error("signal socket failed")));
    pc.addEventListener("connectionstatechange", () => {
      // Only fail the INITIAL connect this way; once Peer is constructed,
      // its own iceconnectionstatechange handler owns lifecycle.
      if (!resolved && pc.connectionState === "failed") fail(new Error("WebRTC connection failed"));
    });
  });
}
