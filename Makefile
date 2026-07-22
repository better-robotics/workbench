.DEFAULT_GOAL := help

PORT        ?= $(shell ls /dev/cu.usbserial-* /dev/cu.usbmodem* 2>/dev/null | head -1)
IDF_DIR     := firmware/esp32_robot_idf
PUBLISH_DIR := docs/firmware/bins
# Every board env in firmware/esp32_robot_idf/platformio.ini —
# publish-firmware builds + stages all of them.
BOARDS      := aithinker_cam devkit s3_cam c3_supermini

.PHONY: help setup compile flash flash-all monitor monitor-noreset flash-monitor preview publish publish-firmware smoke gen-uuids gen-constants gen-partitions install-hooks push

help:
	@echo ""
	@echo "\033[2mSetup\033[0m"
	@echo "  \033[36msetup\033[0m          Install PlatformIO (once per machine; first build pulls the ESP-IDF toolchain)"
	@echo ""
	@echo "\033[2mFirmware (ESP32 local dev loop — wraps PlatformIO)\033[0m"
	@echo "  \033[36mcompile\033[0m        Build every board (or one: make compile BOARD=s3_cam)"
	@echo "  \033[36mflash\033[0m          Build + upload one board: make flash BOARD=s3_cam [PORT=…]"
	@echo "  \033[36mflash-all\033[0m      Upload one board to every matching ESP32 on USB: make flash-all BOARD=s3_cam"
	@echo "  \033[36mmonitor\033[0m        Open serial monitor at 115200 (pio — pulses DTR/RTS, resets chip)"
	@echo "  \033[36mmonitor-noreset\033[0m Live tail without resetting chip (safe alongside an active BLE session)"
	@echo "  \033[36mflash-monitor\033[0m  Flash one board then open monitor: make flash-monitor BOARD=s3_cam"
	@echo ""
	@echo "  \033[2mBoards:\033[0m aithinker_cam · devkit · s3_cam · c3_supermini"
	@echo ""
	@echo "\033[2mTesting\033[0m"
	@echo "  \033[36msmoke\033[0m              Run pure-function smoke tests (node --test). Hardware checks live in SMOKE.md."
	@echo "  \033[36minstall-hooks\033[0m      Wire .githooks/ as core.hooksPath (pre-commit runs gen-uuids/gen-constants drift + smoke)."
	@echo ""
	@echo "\033[2mDashboard & publishing (what the browser serves + OTA fetches)\033[0m"
	@echo "  \033[36mpreview\033[0m             Serve dashboard at http://localhost:8080 (local)"
	@echo "  \033[36mpublish-firmware\033[0m    Stage ESP32 bins in docs/firmware/bins/ for web flashing + ESP32 OTA"
	@echo "  \033[36mpublish\033[0m             Stage firmware bins — run before pushing to deploy"
	@echo "  \033[36mpush\033[0m                Pull-rebase then push — closes the local-vs-deployed gap (CI commits firmware bins back, so plain push tends to reject)"
	@echo ""

setup:
	@# PlatformIO drives the ESP-IDF build (platformio.ini pins
	@# espressif32@6.13.0 → IDF 5.5.3). No manual IDF clone: the first
	@# `pio run` downloads the platform + per-target toolchains into
	@# ~/.platformio automatically.
	@command -v pio >/dev/null 2>&1 || pip3 install --user platformio
	@echo "PlatformIO ready. First 'make compile' pulls the toolchain (~1 GB, once)."

gen-uuids:
	@# Single source of truth for BLE UUIDs lives in protocol/uuids.json.
	@# Codegen produces matching constants for the ESP32 firmware (#define
	@# header) and the dashboard (JS module) so a
	@# typo in one consumer can't silently desync the protocol. Cheap;
	@# rebuilds only what changed.
	@python3 tools/gen-uuids.py

gen-constants:
	@# Same pattern as gen-uuids, for numeric safety/framing constants
	@# (protocol/constants.json) that must agree across firmwares — e.g.
	@# the motor watchdog / LLM pulse-duration caps.
	@python3 tools/gen-constants.py

gen-partitions:
	@# Dashboard flash map (docs/ide/flash-map.js) generated from the firmware
	@# partition table so they can't drift — same pattern as gen-uuids. Edit
	@# partitions.csv, not the generated JS.
	@python3 tools/gen-partitions.py

# pio run builds every env in platformio.ini; scope to one with BOARD=.
compile: gen-uuids gen-constants gen-partitions
	cd $(IDF_DIR) && pio run $(if $(BOARD),-e $(BOARD),)

flash: gen-uuids gen-constants
	@test -n "$(BOARD)" || (echo "BOARD= required — one of: $(BOARDS)" && exit 1)
	cd $(IDF_DIR) && pio run -e $(BOARD) -t upload $(if $(PORT),--upload-port "$(PORT)",)

flash-all: gen-uuids gen-constants
	@test -n "$(BOARD)" || (echo "BOARD= required — one of: $(BOARDS)" && exit 1)
	cd $(IDF_DIR) && pio run -e $(BOARD)
	BOARD=$(BOARD) python3 tools/flash-all.py

monitor:
	cd $(IDF_DIR) && pio device monitor $(if $(PORT),-p "$(PORT)",) -b 115200

# Live serial tail that does NOT reset the chip on connect. idf.py monitor
# pulses DTR/RTS as part of opening the port, which the USB-UART chip
# translates into chip reset — that kills any active BLE session and
# breaks the very thing you wanted to debug. We open the port manually
# with DTR/RTS held low so the chip keeps running undisturbed.
# Ctrl+C to exit. Read-only (no input forwarded).
monitor-noreset:
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-* or /dev/cu.usbmodem*" && exit 1)
	@python3 -c "import serial,sys,time; s=serial.Serial('$(PORT)',115200,timeout=1); s.dtr=False; s.rts=False; time.sleep(0.3); \
	 [sys.stdout.write(s.read(4096).decode('utf-8','replace')) or sys.stdout.flush() for _ in iter(int,1)]"

flash-monitor: flash monitor

preview:
	@# Local HTTP server + cloudflared tunnel. Desktop uses localhost, phone
	@# uses the trycloudflare.com URL (HTTPS is required for getUserMedia /
	@# WebRTC on mobile). Connection: close on each response avoids Chrome's
	@# HTTP/1.1 keep-alive pool stall that leaves module fetches pending.
	@node scripts/serve.js

# Build + stage every board's bins to docs/firmware/bins/<board>/ for the
# dashboard's web-flasher (Recovery flow) + BLE-OTA paths. tools/pio-stage.py
# writes each board's manifest.json with the per-chip flash offsets; CI runs
# the same script per board.
publish-firmware: compile
	@for b in $(BOARDS); do python3 tools/pio-stage.py $$b; done
	@echo ""
	@echo "Firmware bins staged in $(PUBLISH_DIR). Commit and push to deploy."

publish: publish-firmware

# Pure-function smoke tests — fast, no hardware. Hardware/UI checks live in
# SMOKE.md (manual). New formatters / utilities in docs/format.js earn a
# row in tests/format.test.js.
smoke:
	node --test tests/*.test.js

# Per-clone, idempotent. CI is the binding layer; the hook is fast
# feedback so common mistakes (stale gen-uuids, format.test regressions)
# don't survive a 5-minute round-trip.
install-hooks:
	@git config core.hooksPath .githooks
	@echo "core.hooksPath = .githooks (pre-commit: gen-uuids/gen-constants drift + smoke)"

# CI auto-commits firmware bins back to main on every firmware/** push, so
# a local main almost always trails origin by one CI commit. Plain `git push`
# rejects; pull --rebase first puts local commits on top of CI's, then push.
# Conflicts from rebase fail loudly — fix and re-run.
push:
	git pull --rebase origin main
	git push origin main
