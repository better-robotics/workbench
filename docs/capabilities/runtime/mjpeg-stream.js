// Schema: { name: "camera", type: "mjpeg-stream" }
// ESP32 path streams HTTP MJPEG on :81/stream — the only camera video
// transport. A non-ESP32 source is forwarded generically via mjpeg-restream.js.
import { logFor } from "../../log.js";
import { capSection } from "./cap-section.js";
import { startMjpegForward, stopMjpegForward } from "./mjpeg-restream.js";
import { persist } from "../../state.js";
import { startWatcher, stopWatcher } from "../../watcher.js";
import { isDetectorFailed } from "../../perception/detectors.js";

import { renderEntry } from "./render-bus.js";

// Camera streaming needs the chip on WiFi — MJPEG is fetched from its
// LAN IP.
function hasWifi(entry) { return !!entry.wifiStatus?.ip; }

export function makeMjpegStreamCap(schema) {
  const { name } = schema;
  const runningField = `${name}Running`;
  const actionStart = `${name}-start`;
  const actionStop  = `${name}-stop`;
  const actionFlip  = `${name}-flip`;
  const label = name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({ [runningField]: false }),
    cleanup(entry)  {
      entry[runningField] = false;
      stopMjpegForward(entry);
    },

    renderSection(entry, { childHtml = "" } = {}) {
      if (entry.status !== "connected") return "";
      const wifi = hasWifi(entry);
      const running = entry[runningField];
      // ESP32 only: the chip serves plain-HTTP MJPEG, and Chrome silently
      // autoupgrades an <img src="http://…"> to https:// on an HTTPS-served
      // dashboard — which the chip can't answer, so the image never loads.
      // Detect this up front and swap the whole action, not just add a
      // footnote: an inline "Start" that quietly never shows a frame is
      // worse than no Start button at all.
      const httpStreamUrl = (wifi && entry.fwType === "esp32" && entry.wifiStatus?.ip)
        ? `http://${entry.wifiStatus.ip}:81/stream` : null;
      const httpsBlocked = typeof location !== "undefined" && location.protocol === "https:";
      const inlineBlocked = httpsBlocked && !!httpStreamUrl;

      let body = "";
      if (!wifi) {
        body = `<div class="meta">Waiting for the robot to join WiFi — video needs a LAN IP.</div>`;
      } else if (running) {
        // crossOrigin lets camera-frame.js read pixels; the browser's
        // native multipart MJPEG parser is the cheapest decode path.
        const flipImgStyle = entry.cameraFlip ? ` style="transform: rotate(180deg)"` : "";
        body = `<img class="robot-camera" crossorigin="anonymous" data-cam-id="${entry.id}" alt="camera video"${flipImgStyle}>`;
      }
      // Flip toggle: same shape as the Pi camera card — persisted per-robot,
      // reachable whether running or stopped. Hidden when WiFi isn't joined
      // (the Start button is disabled anyway) or when inline video can't
      // play at all (nothing on-page to flip).
      const flipBtn = (wifi && !inlineBlocked)
        ? `<button class="icon sm" data-action="${actionFlip}" aria-pressed="${!!entry.cameraFlip}" aria-label="Flip camera 180°" title="Flip camera 180°"><svg class="icon-svg"><use href="icons.svg#icon-flip-vertical"/></svg></button>`
        : "";
      const action = !wifi
        ? `<button class="secondary sm" disabled>Start</button>`
        : inlineBlocked
          ? `<a class="secondary sm" href="${httpStreamUrl}" target="_blank" rel="noreferrer">Open in new tab ↗</a>`
          : running
            ? `${flipBtn}<button class="secondary sm" data-action="${actionStop}">Stop</button>`
            : `${flipBtn}<button class="secondary sm" data-action="${actionStart}">Start</button>`;
      // State string only when it adds info beyond the action verb. Action
      // says Start/Stop/Open already; "ready"/"streaming" would just echo it.
      // "Waiting for WiFi" earns its place — the button is disabled and the
      // user needs to know why.
      const stateText = !wifi ? "Waiting for WiFi" : "";
      return capSection({
        name,
        label,
        state: stateText,
        action,
        // Child caps (Flash, Snapshot — schema-flat, conceptually camera
        // sub-controls) render here so the operator sees one Camera section
        // hosting everything camera-shaped instead of three peers in a flat list.
        body: `${body}${childHtml}`,
        transport: "wifi",
      });
    },

    wireActions(entry, node) {
      const findEl = () => entry.node?.querySelector(
        `img.robot-camera[data-cam-id="${entry.id}"]`,
      );
      // Auto-arm the reflex watcher on camera start so the demo's stop-
      // sign gate is live the moment frames flow. Skipped if pre-armed
      // (operator custom config) or the active detector failed.
      // _watcherAutoArmed tracks the inverse on stop so a manually-armed
      // watcher survives a camera restart.
      const armWatcherIfAuto = () => {
        if (entry.watcher?.enabled) return;
        if (isDetectorFailed()) return;
        entry._watcherAutoArmed = true;
        startWatcher(entry);
      };
      const disarmWatcherIfAuto = () => {
        if (!entry._watcherAutoArmed) return;
        entry._watcherAutoArmed = false;
        stopWatcher(entry);
      };

      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click", () => {
        entry[runningField] = true;
        renderEntry(entry);
        const el = findEl();
        if (!el) return;

        if (entry.fwType === "esp32") {
          const ip = entry.wifiStatus?.ip;
          if (!ip) {
            logFor(entry, `video: chip has no IP yet`);
            entry[runningField] = false;
            renderEntry(entry);
            return;
          }
          el.src = `http://${ip}:81/stream`;
          startMjpegForward(entry, el);
          logFor(entry, `video: HTTP MJPEG ${el.src}`);
          armWatcherIfAuto();
          return;
        }
        startMjpegForward(entry, el);
        armWatcherIfAuto();
      });
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click", () => {
        stopMjpegForward(entry);
        entry[runningField] = false;
        disarmWatcherIfAuto();
        renderEntry(entry);
      });
      // Post-render rebind: when the card re-renders mid-stream, the
      // element we were drawing into is detached. Re-point the phone-
      // restream source at the fresh element. (app.js's transplant logic
      // preserves the live element across most re-renders, but rebind is
      // the belt-and-suspenders fallback.)
      if (entry[runningField]) {
        const el = findEl();
        if (el && entry._mjpegForward && el !== entry._mjpegForward.imgEl) {
          startMjpegForward(entry, el);
        }
      }
      node.querySelector(`[data-action="${actionFlip}"]`)?.addEventListener("click", () => {
        entry.cameraFlip = !entry.cameraFlip;
        persist();
        renderEntry(entry);
      });
    },
  };
}
