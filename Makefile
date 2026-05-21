.DEFAULT_GOAL := help

PORT        ?= $(shell ls /dev/cu.usbserial-* /dev/cu.usbmodem* 2>/dev/null | head -1)
IDF_DIR     := firmware/esp32_robot_idf
IDF_BUILD   := $(IDF_DIR)/build
PUBLISH_DIR := docs/firmware/bins

# Source the IDF environment only if idf.py isn't already on PATH. Lets a
# user who pre-sourced (`get_idf`) keep their warm shell without paying
# the ~1 s export-script tax on every make invocation; everyone else gets
# auto-sourcing so `make flash` works in a vanilla terminal.
IDF_EXPORT  := command -v idf.py >/dev/null 2>&1 || . ~/esp/esp-idf/export.sh >/dev/null

.PHONY: help setup compile flash monitor monitor-noreset flash-monitor install-pi-os preview publish publish-firmware publish-pi-firmware smoke gen-uuids install-hooks push

help:
	@echo ""
	@echo "\033[2mSetup\033[0m"
	@echo "  \033[36msetup\033[0m          Install ESP-IDF toolchain (once per machine)"
	@echo ""
	@echo "\033[2mFirmware (ESP32 local dev loop — wraps idf.py)\033[0m"
	@echo "  \033[36mcompile\033[0m        Compile firmware/esp32_robot_idf"
	@echo "  \033[36mflash\033[0m          Compile + upload over USB — fast dev iteration"
	@echo "  \033[36mmonitor\033[0m        Open serial monitor at 115200 (idf.py — pulses DTR/RTS, resets chip)"
	@echo "  \033[36mmonitor-noreset\033[0m Live tail without resetting chip (safe alongside an active BLE session)"
	@echo "  \033[36mflash-monitor\033[0m  Flash then open monitor"
	@echo ""
	@echo "\033[2mPi SD provisioning\033[0m"
	@echo "  \033[36minstall-pi-os\033[0m  Write Raspberry Pi OS Lite 64-bit to SD card (then use dashboard 'Customize card')"
	@echo ""
	@echo "\033[2mTesting\033[0m"
	@echo "  \033[36msmoke\033[0m              Run pure-function smoke tests (node --test). Hardware checks live in SMOKE.md."
	@echo "  \033[36minstall-hooks\033[0m      Wire .githooks/ as core.hooksPath (pre-commit runs gen-uuids drift + smoke)."
	@echo ""
	@echo "\033[2mDashboard & publishing (what the browser serves + OTA fetches)\033[0m"
	@echo "  \033[36mpreview\033[0m             Serve dashboard at http://localhost:8080 (local)"
	@echo "  \033[36mpublish-firmware\033[0m    Stage ESP32 bins in docs/firmware/bins/ for web flashing + ESP32 OTA"
	@echo "  \033[36mpublish-pi-firmware\033[0m Stage Pi firmware + wheels in docs/firmware/pi_robot/ for SD-prep + Pi OTA"
	@echo "  \033[36mpublish\033[0m             Both publish targets — run before pushing to deploy"
	@echo "  \033[36mpush\033[0m                Pull-rebase then push — closes the local-vs-deployed gap (CI commits firmware bins back, so plain push tends to reject)"
	@echo ""

setup:
	@# ESP-IDF v5.3+ install: clone the repo and run install.sh once. The
	@# IDF tools install ~1 GB into ~/.espressif (toolchain, openocd, python
	@# venv). After this, source ~/esp/esp-idf/export.sh in each new shell.
	@if [ ! -d ~/esp/esp-idf ]; then \
		mkdir -p ~/esp && \
		git clone --depth 1 --branch v5.3.1 --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf; \
	fi
	~/esp/esp-idf/install.sh esp32,esp32s3
	@echo ""
	@echo "make compile/flash/monitor auto-source IDF — you can stop here."
	@echo "Optional: 'alias get_idf=\". ~/esp/esp-idf/export.sh\"' in your shell rc"
	@echo "to run idf.py directly (faster than make's per-invocation source)."

gen-uuids:
	@# Single source of truth for BLE UUIDs lives in protocol/uuids.json.
	@# Codegen produces matching constants for the ESP32 firmware (#define
	@# header), Pi firmware (Python module), and dashboard (JS module) so a
	@# typo in one consumer can't silently desync the protocol. Cheap;
	@# rebuilds only what changed.
	@python3 tools/gen-uuids.py

compile: gen-uuids
	$(IDF_EXPORT); cd $(IDF_DIR) && idf.py build

flash: compile
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-* or /dev/cu.usbmodem*. Is it plugged in?" && exit 1)
	$(IDF_EXPORT); cd $(IDF_DIR) && idf.py -p "$(PORT)" flash

monitor:
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-* or /dev/cu.usbmodem*" && exit 1)
	$(IDF_EXPORT); cd $(IDF_DIR) && idf.py -p "$(PORT)" monitor

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

install-pi-os:
	@bash scripts/install-pi-os.sh

preview:
	@# Local HTTP server + cloudflared tunnel. Desktop uses localhost, phone
	@# uses the trycloudflare.com URL (HTTPS is required for getUserMedia /
	@# WebRTC on mobile). Connection: close on each response avoids Chrome's
	@# HTTP/1.1 keep-alive pool stall that leaves module fetches pending.
	@node scripts/serve.js

# Stage ESP-IDF build artifacts for the dashboard's web-flasher (Recovery
# flow) + BLE-OTA paths. Filenames preserved from the Arduino layout so
# fielded units running the .ino can OTA into the IDF firmware without a
# dashboard / partition-table change.
publish-firmware: compile
	@mkdir -p $(PUBLISH_DIR)
	cp $(IDF_BUILD)/esp32_robot.bin                       $(PUBLISH_DIR)/esp32_robot.bin
	cp $(IDF_BUILD)/bootloader/bootloader.bin             $(PUBLISH_DIR)/bootloader.bin
	cp $(IDF_BUILD)/partition_table/partition-table.bin   $(PUBLISH_DIR)/partitions.bin
	cp $(IDF_BUILD)/ota_data_initial.bin                  $(PUBLISH_DIR)/boot_app0.bin
	@echo ""
	@echo "Firmware bins copied to $(PUBLISH_DIR). Commit and push to deploy."

publish-pi-firmware: gen-uuids
	@mkdir -p docs/firmware/pi_robot/wheels
	# Copy every regular file from firmware/pi_robot/ — avoids the trap of
	# adding a new helper (usb-gadget-setup.sh, ota-manifest.json, …) and
	# forgetting to update this list.
	find firmware/pi_robot/ -maxdepth 1 -type f \
		-not -name 'README.md' \
		-not -name 'SHELL.md' \
		-exec cp {} docs/firmware/pi_robot/ \;
	rm -f docs/firmware/pi_robot/wheels/*.whl
	pip download --no-deps --platform manylinux2014_aarch64 --python-version 311 --implementation cp --only-binary=:all: -d docs/firmware/pi_robot/wheels/ bless bleak dbus-fast dbus-next typing-extensions
	pip download --no-deps --platform manylinux2014_aarch64 --python-version 313 --implementation cp --only-binary=:all: -d docs/firmware/pi_robot/wheels/ bless bleak dbus-fast dbus-next typing-extensions
	@python3 -c "import json, pathlib; d = pathlib.Path('docs/firmware/pi_robot/wheels'); (d/'manifest.json').write_text(json.dumps({'wheels': sorted(p.name for p in d.glob('*.whl'))}, indent=2) + '\n')"
	@# Stamp commit SHA so fw-info.version and ota-manifest.commit can tell you
	@# what's running vs what you're about to flash.
	@SHA=$$(git rev-parse --short=7 HEAD 2>/dev/null || echo "dev"); \
		echo "SHA = \"$$SHA\"" > docs/firmware/pi_robot/version.py; \
		python3 -c "import json; p='docs/firmware/pi_robot/ota-manifest.json'; m=json.load(open(p)); m['commit']='$$SHA'; open(p,'w').write(json.dumps(m, indent=2) + '\n')"; \
		echo "Stamped version: $$SHA"
	@echo ""
	@echo "Pi firmware + wheels published. Commit and push to deploy."

publish: publish-firmware publish-pi-firmware

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
	@echo "core.hooksPath = .githooks (pre-commit: gen-uuids drift + smoke)"

# CI auto-commits firmware bins back to main on every firmware/** push, so
# a local main almost always trails origin by one CI commit. Plain `git push`
# rejects; pull --rebase first puts local commits on top of CI's, then push.
# Conflicts from rebase fail loudly — fix and re-run.
push:
	git pull --rebase origin main
	git push origin main
