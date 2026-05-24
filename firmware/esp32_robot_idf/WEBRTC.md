# ESP32 WebRTC: chip is the DTLS client, not the server

Classic ESP32 streams WebRTC video to current Chrome via four coordinated
patches that don't independently make sense — anyone debugging this stack
needs to see them as one shape:

1. **DTLS role: chip is CLIENT** (forced in `dtls_srtp_init` regardless of
   what libpeer's binary blob passes). libpeer always passes ROLE_SERVER,
   but mbedTLS's `ssl_parse_client_hello` can't reassemble Chrome's ~1413-
   byte fragmented ClientHello — bails immediately with `FEATURE_UNAVAILABLE`.
   As CLIENT, chip sends the (small, never-fragmented) ClientHello and
   Chrome handles whatever it receives. Chrome 124+ enforces this strictly.
2. **DTLS cert is dashboard-supplied**, ECDSA P-256. The browser generates
   the keypair (WebCrypto) and self-signs an X.509 cert (@peculiar/x509),
   then pushes both PEMs over the SIGNAL char (opcodes 0x07/0x08/0x09) BEFORE
   the offer. Chip's `dtls_srtp_init` refuses to open WebRTC if nothing was
   supplied — chip-gen path was removed for ~9 KB flash saved (linker gc on
   mbedtls x509write_crt_* + ecp_gen_key). WebRTC standardized on ECDSA;
   current Chrome rejects RSA in DTLS-SRTP, so the dashboard cert is built
   ECDSA-only too.
3. **All chip-quirk SDP rewriting lives in the dashboard** (webrtc-robot.js).
   The browser pre-strips TCP candidates from the offer (chip is UDP-only),
   pins offer MID to "0" so libpeer's hardcoded "0" in the answer matches,
   and flips `setup:passive`→`setup:active` on the incoming answer (libpeer
   always emits passive even though chip is actually CLIENT). Used to be
   three string-walking functions in webrtc_peer.c (`filter_sdp_for_chip`,
   `capture_offer_mid`, `rewrite_answer_mid`); centralizing made the chip
   an SDP-agnostic byte pipe.
4. **mbedTLS Kconfig** must enable the WebRTC cipher set explicitly
   (DTLS_SRTP, ECDHE_ECDSA, ECDH_C, ECDSA_C, SECP256R1, GCM_C, SHA1_C,
   HKDF_C). IDF defaults are tuned for HTTPS-client and lack what DTLS-SRTP
   needs. X509_CREATE_C: not needed on v5 (dashboard does the cert
   creation, chip only parses); v6 path of esp_peer re-enables it for
   upstream cert helpers even though our flow stays dashboard-side.
5. **PSRAM-default malloc** with `RESERVE_INTERNAL=32768` — mbedTLS context
   + libpeer SCTP/SRTP buffers go to PSRAM so the camera DMA's 32 KB
   contiguous internal block is always available mid-session.

Removing any one of these reverts the chip to "DTLS handshake never
completes" or "camera_acquire fails after WebRTC opens." Firmware-side
constraints (DTLS role, mbedTLS Kconfig, PSRAM malloc) are documented in
`components/espressif__esp_peer/src/dtls_srtp.c` and `sdkconfig.defaults.esp32`;
dashboard-side constraints (cert push, SDP rewriting) in
`docs/webrtc/webrtc-cert.js` and `docs/webrtc/webrtc-robot.js`.

## Sunset path

mbedTLS PR #10623 (3.6 backport of the fragmented DTLS-ClientHello reassembly
fix, first released in 3.6.6 / 4.1.0, March 2026) collapses Patch 1 and the
half of Patch 3 that exists because of it. ESP-IDF v5.5.4 (current pin) ships
3.6.5, v6.0.1 ships 4.0.0 — both pre-fix. espressif/esp-idf release/v5.5 (now
on 3.6.6-idf) and release/v6.0 (now on 4.1.0-idf) have the fix on their HEAD
branches; the next tagged release in either line is the trigger.

Prefer v6.0.x. `components/espressif__esp_peer/src/dtls_srtp_v6.c` is
pre-staged (CMake selects it on `IDF_VERSION_MAJOR >= 6`) and already encodes
the post-sunset shape: role honored from cfg (no CLIENT override),
HelloVerifyRequest cookies enabled, PSA crypto path. The cleanup on a v6.0.2
bump collapses to "delete the v5 dtls_srtp.c sibling and the IDF
major-version CMake selector" rather than reverting patches in-place. The
rest of the firmware migrates clean — NimBLE / WiFi / esp_netif /
esp_http_server / LEDC / GPIO / NVS / esp_timer call sites all survive v6.0;
exposure is `-Werror` flip + gnu23 default surfacing latent warnings.

v5.5.5 is the fallback if v6.0.2 is slow. On v5.5.5, the manual cleanup is:
revert chip-as-CLIENT in dtls_srtp.c (lines 75 and 161), restore
HelloVerifyRequest cookies (line 95). In either case, drop the
`setup:passive`→`setup:active` flip from `docs/webrtc/webrtc-robot.js`.
Patches 2 (dashboard ECDSA cert), 4 (mbedTLS Kconfig) and 5 (PSRAM malloc)
stay — those are WebRTC-spec or chip-shape, not mbedTLS-bug workarounds.

## Opt-in via `CONFIG_BR_WEBRTC_ESP_PEER`

`main/Kconfig.projbuild`, default y. Set =n to drop all WebRTC code — `select`
chain removes the WebRTC-only mbedTLS bits, all call sites in webrtc_peer /
app_main / gatt_svr / telemetry guard out with `#ifdef`, and the linker's
`--gc-sections` strips libpeer.a from the image (~215 KB smaller binary).
Useful for forks that only need HTTP MJPEG video. esp_peer always *registers*
as a component (Kconfig values aren't visible to IDF's component-registration
phase), but produces no live references when off, so the linker drops it.
