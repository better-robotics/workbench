// Expected schema shape:
//   { name: "camera", type: "mjpeg-stream", port: 81, path: "/stream" }
// Unlike the Pi webrtc-installable cap, there's no BLE signaling — the
// dashboard just opens http://<ip>:<port><path> with a plain <img>. Works
// only when the dashboard's browser and the robot share a network.
import { escapeHtml } from "../../dom.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

function streamUrl(entry, schema) {
  const ip = entry.wifiStatus?.ip;
  if (!ip) return null;
  const port = schema.port || 81;
  const path = schema.path || "/stream";
  return `http://${ip}:${port}${path}`;
}

export function makeMjpegStreamCap(schema) {
  const { name } = schema;
  const runningField = `${name}Running`;
  const actionStart = `${name}-start`;
  const actionStop  = `${name}-stop`;
  const label = name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({ [runningField]: false }),
    async probe() { /* HTTP on LAN — no BLE char to probe. */ },
    cleanup(entry)  { entry[runningField] = false; },

    renderSection(entry) {
      if (entry.status !== "connected") return "";
      const url = streamUrl(entry, schema);
      const running = entry[runningField];
      let body = "";
      if (!url) {
        body = `<div class="meta">Waiting for the robot to join WiFi — stream needs a LAN IP.</div>`;
      } else if (running) {
        body = `<img class="robot-camera" data-cam-id="${entry.id}" src="${escapeHtml(url)}" alt="MJPEG stream">`;
      } else {
        body = `<div class="meta">${escapeHtml(url)}</div>`;
      }
      const action = !url
        ? `<button class="secondary sm" disabled>Start</button>`
        : running
          ? `<button class="secondary sm" data-action="${actionStop}">Stop</button>`
          : `<button class="secondary sm" data-action="${actionStart}">Start</button>`;
      return `
        <div class="robot-controls">
          <div class="row">
            <div><div class="label">${escapeHtml(label)}</div></div>
            ${action}
          </div>
          ${body}
        </div>
      `;
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click", () => {
        entry[runningField] = true;
        renderEntry(entry);
      });
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click", () => {
        entry[runningField] = false;
        renderEntry(entry);
      });
    },
  };
}
