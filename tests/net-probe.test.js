// parseCandidate is a pure parser over SDP candidate lines — exactly the
// kind of thing that earns a smoke-test row. probeNetwork() itself needs an
// RTCPeerConnection so it lives in the manual SMOKE.md surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCandidate } from "../docs/net-probe.js";

test("parseCandidate: host candidate with IPv4 address", () => {
  const r = parseCandidate({ candidate: "candidate:1 1 udp 2113937151 192.168.1.5 51234 typ host generation 0" });
  assert.equal(r.type, "host");
  assert.equal(r.address, "192.168.1.5");
  assert.equal(r.port, 51234);
  assert.equal(r.protocol, "udp");
});

test("parseCandidate: srflx candidate exposes public IP", () => {
  const r = parseCandidate({ candidate: "candidate:842163049 1 udp 1677729535 1.2.3.4 51234 typ srflx raddr 192.168.1.5 rport 51234" });
  assert.equal(r.type, "srflx");
  assert.equal(r.address, "1.2.3.4");
});

test("parseCandidate: relay candidate (TURN)", () => {
  const r = parseCandidate({ candidate: "candidate:1 1 udp 41885951 relay.example.com 443 typ relay raddr 1.2.3.4 rport 51234" });
  assert.equal(r.type, "relay");
});

test("parseCandidate: mDNS-obfuscated host (Chrome default)", () => {
  const r = parseCandidate({ candidate: "candidate:1 1 udp 2113937151 abc-123.local 51234 typ host generation 0" });
  assert.equal(r.type, "host");
  assert.equal(r.address, "abc-123.local");
});

test("parseCandidate: prefers explicit object fields over SDP parse", () => {
  const r = parseCandidate({
    candidate: "candidate:1 1 udp 2113937151 1.2.3.4 51234 typ host",
    type: "srflx",
    address: "9.9.9.9",
    port: 1111,
  });
  assert.equal(r.type, "srflx");
  assert.equal(r.address, "9.9.9.9");
  assert.equal(r.port, 1111);
});

test("parseCandidate: returns null for empty/missing input", () => {
  assert.equal(parseCandidate(null), null);
  assert.equal(parseCandidate(undefined), null);
  assert.equal(parseCandidate({}), null);
  assert.equal(parseCandidate({ candidate: "" }), null);
});

test("parseCandidate: malformed SDP yields nulls but does not throw", () => {
  const r = parseCandidate({ candidate: "garbage" });
  assert.equal(r.type, null);
  assert.equal(r.address, null);
  assert.equal(r.port, null);
  assert.equal(r.sdp, "garbage");
});

test("parseCandidate: TCP candidate type detected", () => {
  const r = parseCandidate({ candidate: "candidate:1 1 tcp 1518214911 192.168.1.5 9 typ host tcptype active generation 0" });
  assert.equal(r.protocol, "tcp");
  assert.equal(r.type, "host");
});
