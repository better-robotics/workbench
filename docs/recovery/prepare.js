import { $, freshUrl, fetchWithTimeout } from "../dom.js";
import { createPassword } from "../passwords.js";

const FIRMWARE_URL    = "firmware/pi_robot";
const FIRMWARE_FILES  = [
  "pi_robot.py", "uuids.py", "protocol_constants.py", "requirements.txt", "pi-robot.service",
  "heartbeat.py", "pi-robot-heartbeat.service",
  "pi_robot_health.py", "pi-robot-health.service",
  "avahi-betterrobot.service",
  "usb-gadget-setup.sh", "usb-gadget.service",
  // pi-robot-rtc — Python aiortc daemon. firstrun.sh pip-installs aiortc
  // + aiohttp on first boot (online deps; not in the offline wheels).
  "pi_robot_rtc.py", "pi-robot-rtc.service",
];
// libcomposite is the generic USB-gadget driver; the actual composite
// (ECM ethernet + ACM serial) is configured via configfs at boot by
// usb-gadget.service. Replaces the old `g_ether` one-function gadget.
const CMDLINE_USB     = " modules-load=dwc2,libcomposite";
const CONFIG_USB_MARKER = "# Better Robotics: USB gadget mode + boot speedups";
// Boot speedups stacked alongside the dtoverlay so they share the marker:
//   disable_splash — skip the rainbow boot splash (~1 s saved)
//   boot_delay=0  — skip the firmware's 1 s post-rainbow delay
const CONFIG_USB_LINES  = `\n${CONFIG_USB_MARKER}\n[all]\ndtoverlay=dwc2\ndisable_splash=1\nboot_delay=0\n`;
// systemd.run_success_action=none — when firstrun.sh exits successfully,
// systemd does NOT reboot. firstrun itself triggers the transition into
// multi-user.target from inside the script, skipping the ~25-30 s
// firmware-POST + kernel-reload + service-restart cycle that the old
// reboot-on-success convention cost on every first boot.
const SYSTEMD_RUN =
  " systemd.run=/boot/firmware/firstrun.sh" +
  " systemd.run_success_action=none" +
  " systemd.unit=kernel-command-line.target";

let dirHandle = null;

function prepLog(msg, cls) {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  el.textContent = msg;
  $("prep-progress").prepend(el);
}

const shSingleQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const ensureDir = (parent, name) => parent.getDirectoryHandle(name, { create: true });

// `name` may be a relative path with `/` separators — directories are
// created on demand so the caller doesn't have to mkdir each segment.
async function writeFile(dir, name, contents) {
  const segments = name.split("/").filter(Boolean);
  let d = dir;
  for (let i = 0; i < segments.length - 1; i++) {
    d = await ensureDir(d, segments[i]);
  }
  const leaf = segments[segments.length - 1];
  const h = await d.getFileHandle(leaf, { create: true });
  const w = await h.createWritable();
  await w.write(contents);
  await w.close();
}

async function readTextFile(dir, name) {
  try {
    const h = await dir.getFileHandle(name);
    const f = await h.getFile();
    return await f.text();
  } catch { return null; }
}

async function fetchBlob(url) {
  // 60s — wheels / binaries can be a few MB each on slow connections.
  const r = await fetchWithTimeout(freshUrl(url), { cache: "no-cache" }, 60000);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.blob();
}

function patchCmdline(text) {
  let line = text.replace(/\n+$/, "").trim();
  line = line.replace(/\s+systemd\.run=\S+/g, "");
  line = line.replace(/\s+systemd\.run_success_action=\S+/g, "");
  line = line.replace(/\s+systemd\.unit=\S+/g, "");
  line = line.replace(/\s+modules-load=\S+/g, "");
  return line + CMDLINE_USB + SYSTEMD_RUN + "\n";
}

function patchConfig(text) {
  if (text.includes(CONFIG_USB_MARKER)) return text;
  return text.replace(/\n*$/, "") + CONFIG_USB_LINES;
}

function renderFirstrun(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`__REPLACE_${k}__`, shSingleQuote(v));
  }
  return out;
}

async function runPrepare() {
  $("prep-go-btn").disabled = true;
  $("prep-progress").hidden = false;
  $("prep-progress").innerHTML = "";

  const username = $("prep-username").value.trim() || "pi";
  let password   = $("prep-password").value;
  let passwordGenerated = false;
  if (!password) {
    password = createPassword();
    passwordGenerated = true;
  }

  try {
    prepLog("Validating SD card…");
    const cfg = await readTextFile(dirHandle, "config.txt");
    if (cfg === null || (!cfg.includes("[cm4]") && !cfg.includes("arm_64bit"))) {
      prepLog("Warning: picked directory doesn't look like a Pi boot partition.", "err");
    }

    prepLog("Fetching firstrun template…");
    const template = await (await fetchWithTimeout(freshUrl(`${FIRMWARE_URL}/firstrun.template.sh`), { cache: "no-cache" })).text();

    prepLog("Fetching firmware files…");
    const betterpi = await ensureDir(dirHandle, "betterpi");
    await Promise.all(FIRMWARE_FILES.map(async (f) => {
      await writeFile(betterpi, f, await fetchBlob(`${FIRMWARE_URL}/${f}`));
      prepLog(`  ✓ ${f}`, "ok");
    }));

    prepLog("Fetching wheels manifest…");
    const manifest = await (await fetchWithTimeout(freshUrl(`${FIRMWARE_URL}/wheels/manifest.json`), { cache: "no-cache" })).json();
    const wheels = await ensureDir(dirHandle, "wheels");
    for await (const entry of wheels.values()) {
      if (entry.kind === "file") await wheels.removeEntry(entry.name).catch(() => {});
    }
    await Promise.all(manifest.wheels.map(async (filename) => {
      await writeFile(wheels, filename, await fetchBlob(`${FIRMWARE_URL}/wheels/${filename}`));
      prepLog(`  ✓ ${filename}`, "ok");
    }));

    prepLog("Rendering firstrun.sh…");
    const firstrun = renderFirstrun(template, {
      USER_NAME: username,
      USER_PASS: password,
    });
    await writeFile(dirHandle, "firstrun.sh", firstrun);

    // Absent → firmware defaults all-on for backward compat with pre-config Pis.
    prepLog("Writing pi-robot.conf…");
    const piConfig = {
      led_enabled: $("prep-cap-led").checked,
      led_pin: parseInt($("prep-cap-led-pin").value, 10) || 17,
      motors_enabled: $("prep-cap-motors").checked,
      camera_enabled: $("prep-cap-camera").checked ? "auto" : false,
    };
    await writeFile(dirHandle, "pi-robot.conf", JSON.stringify(piConfig, null, 2));

    prepLog("Patching cmdline.txt…");
    const oldCmd = await readTextFile(dirHandle, "cmdline.txt");
    if (oldCmd === null) throw new Error("cmdline.txt not found on card");
    await writeFile(dirHandle, "cmdline.txt", patchCmdline(oldCmd));

    prepLog("Enabling USB gadget mode…");
    const oldCfg = await readTextFile(dirHandle, "config.txt");
    if (oldCfg === null) throw new Error("config.txt not found on card");
    await writeFile(dirHandle, "config.txt", patchConfig(oldCfg));

    if (passwordGenerated) {
      prepLog(`Generated a random sudo password — see Settings → Robot passwords.`, "ok");
    }
    // Browsers can't eject a volume — File System Access API is file-only and
    // mass-storage WebUSB is blocked. Best we can do: confirm writes are
    // flushed (every writable closed above) and tell the user how to eject.
    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const tip = isMac ? "⌘E in Finder" : "right-click the card → Eject";
    prepLog(`Safe to eject now (${tip}). Then boot the Pi.`, "ok");
  } catch (err) {
    prepLog(`Error: ${err.message}`, "err");
  } finally {
    $("prep-go-btn").disabled = false;
  }
}

function closeDialog() { $("prepare-dialog").close(); }

// Module is lazy-loaded by app.js on first "Set up a Pi robot" click, so
// one-time setup runs in initOnce() guarded by a flag. The "prepare-open-btn"
// handler itself is owned by app.js — it triggers the import, then calls
// openDialog() here. No outside-click dismiss on the dialog: SD prep is a
// multi-step write to the card, and accidental close mid-flight leaves a
// partially-prepped card. Users close via × or Cancel explicitly.
let _initialized = false;
function initOnce() {
  if (_initialized) return;
  _initialized = true;

  const supported = !!window.showDirectoryPicker;
  if (!supported) {
    $("prep-unsupported").hidden = false;
    $("prep-pick-btn").disabled = true;
  }

  $("prepare-close").addEventListener("click", closeDialog);
  $("prep-cancel-btn").addEventListener("click", closeDialog);

  $("prep-pick-btn").addEventListener("click", async () => {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      const pickMeta = $("prep-pick-meta");
      pickMeta.textContent = dirHandle.name;
      pickMeta.className = "meta";
      $("prep-go-btn").disabled = false;
    } catch { /* user cancelled */ }
  });

  $("prep-go-btn").addEventListener("click", runPrepare);
}

export function openDialog() {
  initOnce();
  $("prepare-dialog").showModal();
}
