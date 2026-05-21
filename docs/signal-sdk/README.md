# signal.neevs.io SDK

Client modules for signal.neevs.io — generic, project-agnostic.

- `v1/peer-key.js` — Ed25519 device key + sign/verify primitives
- `v1/discover.js` — same-NAT lobby client (signed ads, broadcast over wss)
- `v1/pair-request.js` — request/accept protocol layered on the lobby

## Why this lives here today

Long-term source-of-truth is `signal.neevs.io` itself. Browsers import directly from `https://signal.neevs.io/sdk/v1/<module>.js`, the service owns versioning, consumers don't fork the protocol client.

Intermediate state: this directory ships the same files as `signal.neevs.io`. Both copies are kept in sync by hand. Imports inside this repo go to the local path (`./signal-sdk/v1/...`).

## Migration steps

1. *(done)* Move the SDK files into this directory; update local imports.
2. Deploy `signal.neevs.io/sdk/v1/{peer-key,discover,pair-request}.js`
   serving the same content. Use immutable URLs + `Cache-Control:
   public, immutable, max-age=31536000` so consumers can cache freely.
3. Flip imports in this repo from `./signal-sdk/v1/X.js` to
   `https://signal.neevs.io/sdk/v1/X.js`. Verify the dashboard still
   loads cleanly (extra DNS+TLS to signal.neevs.io on first visit;
   cached after).
4. Once verified, delete `docs/signal-sdk/v1/` from this repo. The
   `README.md` (this file) can stay as a pointer.

## Versioning

`v1/` exists so signal.neevs.io can ship a `v2/` with breaking changes without a coordinated cutover. Existing consumers keep `v1/` URLs; new consumers opt into `v2/`.

- **Backward-compatible** (new exports, internal refactors): no URL change. Both this repo and signal.neevs.io update together.
- **Breaking**: publish a `v2/` directory; old consumers still hit `v1/` URLs.

## Sync discipline

Until step 4 of the migration completes, **edits here must also be applied to signal.neevs.io's copy** (and vice versa). The header on each file points at this README.
