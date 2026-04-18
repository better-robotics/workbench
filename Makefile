.DEFAULT_GOAL := help

FQBN        ?= esp32:esp32:esp32cam:PartitionScheme=min_spiffs
PORT        ?= $(shell ls /dev/cu.usbserial-* /dev/cu.usbmodem* 2>/dev/null | head -1)
SKETCH      ?= esp32_robot
BUILD_DIR   := /tmp/esp32-$(SKETCH)-build
PUBLISH_DIR := public/firmware/bins
BOOT_APP0   := $(shell find ~/Library/Arduino15/packages/esp32 -name boot_app0.bin 2>/dev/null | sort -V | tail -1)
MONITOR      = arduino-cli monitor --port "$(PORT)" --config baudrate=115200,dtr=off,rts=off

.PHONY: help setup compile flash monitor flash-monitor preview publish-firmware publish-pi-firmware

help:
	@echo ""
	@echo "\033[2mSetup\033[0m"
	@echo "  \033[36msetup\033[0m          Install host dependencies (once per machine)"
	@echo ""
	@echo "\033[2mFirmware\033[0m"
	@echo "  \033[36mcompile\033[0m        Compile $(SKETCH)"
	@echo "  \033[36mflash\033[0m          Compile + upload over USB"
	@echo "  \033[36mmonitor\033[0m        Open serial monitor at 115200"
	@echo "  \033[36mflash-monitor\033[0m  Flash then open monitor"
	@echo ""
	@echo "\033[2mDashboard\033[0m"
	@echo "  \033[36mpreview\033[0m             Serve dashboard at http://localhost:8080"
	@echo "  \033[36mpublish-firmware\033[0m    Package firmware bins into public/firmware/bins/ for web flashing"
	@echo "  \033[36mpublish-pi-firmware\033[0m Publish Pi firmware + wheels to public/firmware/pi_robot/ for the browser SD-prep tool"
	@echo ""

setup:
	@command -v brew >/dev/null || (echo "Install Homebrew first: https://brew.sh" && exit 1)
	@command -v arduino-cli >/dev/null || brew install arduino-cli
	arduino-cli core update-index --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
	arduino-cli core install esp32:esp32 --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
	@echo ""
	@echo "If no /dev/cu.* port appears when the board is plugged in:"
	@echo "  • ESP32-S3 (recommended) — native USB, no driver needed. Appears as /dev/cu.usbmodem*."
	@echo "  • CP210x (Silicon Labs) bridge — install https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers"
	@echo "    and allow in System Settings > Privacy & Security."
	@echo "  • FT232R (FTDI) bridge — Apple's built-in driver works, nothing to install."

compile:
	arduino-cli compile --fqbn "$(FQBN)" --build-path "$(BUILD_DIR)" firmware/$(SKETCH)

flash: compile
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-* or /dev/cu.usbmodem*. Is it plugged in?" && exit 1)
	arduino-cli upload --fqbn "$(FQBN)" --port "$(PORT)" --input-dir "$(BUILD_DIR)" firmware/$(SKETCH)

monitor:
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-* or /dev/cu.usbmodem*" && exit 1)
	$(MONITOR)

flash-monitor: flash monitor

preview:
	@echo "Serving dashboard at http://localhost:8080"
	@cd public && python3 -m http.server 8080

publish-firmware: compile
	@test -n "$(BOOT_APP0)" || (echo "Could not find boot_app0.bin — run 'make setup' first" && exit 1)
	@mkdir -p $(PUBLISH_DIR)
	cp "$(BUILD_DIR)/$(SKETCH).ino.bin"            "$(PUBLISH_DIR)/$(SKETCH).bin"
	cp "$(BUILD_DIR)/$(SKETCH).ino.bootloader.bin" "$(PUBLISH_DIR)/bootloader.bin"
	cp "$(BUILD_DIR)/$(SKETCH).ino.partitions.bin" "$(PUBLISH_DIR)/partitions.bin"
	cp "$(BOOT_APP0)"                              "$(PUBLISH_DIR)/boot_app0.bin"
	@echo ""
	@echo "Firmware bins copied to $(PUBLISH_DIR). Commit and push to deploy."

publish-pi-firmware:
	@mkdir -p public/firmware/pi_robot/wheels
	cp firmware/pi_robot/pi_robot.py           public/firmware/pi_robot/pi_robot.py
	cp firmware/pi_robot/requirements.txt      public/firmware/pi_robot/requirements.txt
	cp firmware/pi_robot/pi-robot.service      public/firmware/pi_robot/pi-robot.service
	cp firmware/pi_robot/firstrun.template.sh  public/firmware/pi_robot/firstrun.template.sh
	rm -f public/firmware/pi_robot/wheels/*.whl
	pip download --no-deps --platform manylinux2014_aarch64 --python-version 311 --implementation cp --only-binary=:all: -d public/firmware/pi_robot/wheels/ bless bleak dbus-fast dbus-next typing-extensions
	pip download --no-deps --platform manylinux2014_aarch64 --python-version 313 --implementation cp --only-binary=:all: -d public/firmware/pi_robot/wheels/ bless bleak dbus-fast dbus-next typing-extensions
	@python3 -c "import json, pathlib; d = pathlib.Path('public/firmware/pi_robot/wheels'); (d/'manifest.json').write_text(json.dumps({'wheels': sorted(p.name for p in d.glob('*.whl'))}, indent=2) + '\n')"
	@echo ""
	@echo "Pi firmware + wheels published. Commit and push to deploy. SD-card prep runs in the browser via prepare.html."
