// pi-robot-rtc — WebRTC peer + signaling endpoint for one Pi.
//
// Architecture: HTTP server on :82 receives a WebRTC SDP offer, hands it to
// libpeer, returns the answer in the same response (single round-trip,
// non-trickle ICE — host candidates are stable on LAN). Once the peer
// connection completes, libpeer fires datachannel callbacks. The "shell"
// channel forks bash with a PTY and bridges its stdin/stdout to channel
// bytes.
//
// Single-peer model: only one active PeerConnection. A new offer destroys
// the previous peer and starts fresh. Phase 1.A doesn't need fan-out.
//
// Threads:
//   main           — HTTP accept/handle loop on :82
//   loop_thread    — peer_connection_loop() polling at ~1 ms cadence
//   pty_thread     — spawned when "shell" opens, reads PTY master and
//                    forwards bytes to the channel; joined on close
//
// libpeer API used (sepfy/libpeer @ pinned SHA):
//   peer_init / peer_deinit
//   peer_connection_create / _destroy / _close
//   peer_connection_set_remote_description (offer)
//   peer_connection_create_answer (returns SDP including host candidates)
//   peer_connection_loop (polled in worker thread)
//   peer_connection_ondatachannel (onmessage / onopen / onclose)
//   peer_connection_oniceconnectionstatechange
//   peer_connection_datachannel_send (channel → browser)
//   peer_connection_lookup_sid (label → sid for multi-channel routing)

#define _GNU_SOURCE  // forkpty
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include "peer.h"

#define LISTEN_PORT 82
#define HTTP_BUF_SIZE 65536

// Single-peer state. New /webrtc/offer tears down + recreates.
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static PeerConnection* g_pc = NULL;
static pthread_t g_loop_thread;
static volatile int g_loop_running = 0;
static pthread_t g_pty_thread;
static volatile int g_pty_running = 0;
static int g_pty_master_fd = -1;
static pid_t g_shell_pid = -1;
static volatile int g_interrupted = 0;

// ── libpeer callbacks ───────────────────────────────────────────────────

static void on_state_change(PeerConnectionState state, void* user_data) {
  fprintf(stderr, "[rtc] peer state: %s\n", peer_connection_state_to_string(state));
  if (state == PEER_CONNECTION_FAILED ||
      state == PEER_CONNECTION_DISCONNECTED ||
      state == PEER_CONNECTION_CLOSED) {
    // The PTY pump and shell process get reaped from the channel close
    // path; nothing to do here besides logging.
  }
}

// Forward bytes from PTY master to the channel. Started when "shell" opens.
static void* pty_pump(void* user_data) {
  uint16_t sid;
  char label[] = "shell";
  // Resolve sid for the shell channel — peer_connection_datachannel_send
  // without sid uses whatever happens to be the first one; explicit is safer.
  if (peer_connection_lookup_sid(g_pc, label, &sid) < 0) {
    fprintf(stderr, "[rtc] lookup_sid failed for %s\n", label);
    return NULL;
  }
  uint8_t buf[4096];
  while (g_pty_running && !g_interrupted) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(g_pty_master_fd, &rfds);
    struct timeval tv = { .tv_sec = 0, .tv_usec = 100000 };  // 100 ms
    int r = select(g_pty_master_fd + 1, &rfds, NULL, NULL, &tv);
    if (r < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (r == 0) continue;
    ssize_t n = read(g_pty_master_fd, buf, sizeof(buf));
    if (n <= 0) break;  // PTY closed (shell exited)
    pthread_mutex_lock(&g_mu);
    if (g_pc) {
      peer_connection_datachannel_send_sid(g_pc, (char*)buf, (size_t)n, sid);
    }
    pthread_mutex_unlock(&g_mu);
  }
  fprintf(stderr, "[rtc] pty_pump exiting\n");
  return NULL;
}

// Spawn bash inside a PTY when the shell channel opens. forkpty handles the
// open + fork dance; we end up with the master fd here and the child runs
// bash with the slave as stdin/stdout/stderr.
static int spawn_shell(void) {
  int master_fd;
  pid_t pid = forkpty(&master_fd, NULL, NULL, NULL);
  if (pid < 0) {
    fprintf(stderr, "[rtc] forkpty failed: %s\n", strerror(errno));
    return -1;
  }
  if (pid == 0) {
    // Child: exec bash interactively. Inherits the controlling terminal
    // from forkpty's slave-side setup.
    execlp("bash", "bash", "-i", (char*)NULL);
    _exit(127);
  }
  g_pty_master_fd = master_fd;
  g_shell_pid = pid;
  g_pty_running = 1;
  if (pthread_create(&g_pty_thread, NULL, pty_pump, NULL) != 0) {
    fprintf(stderr, "[rtc] pthread_create(pty) failed\n");
    return -1;
  }
  return 0;
}

static void reap_shell(void) {
  if (g_pty_running) {
    g_pty_running = 0;
    pthread_join(g_pty_thread, NULL);
  }
  if (g_pty_master_fd >= 0) {
    close(g_pty_master_fd);
    g_pty_master_fd = -1;
  }
  if (g_shell_pid > 0) {
    kill(g_shell_pid, SIGHUP);
    waitpid(g_shell_pid, NULL, 0);
    g_shell_pid = -1;
  }
}

static void on_dc_open(void* user_data) {
  fprintf(stderr, "[rtc] datachannel opened\n");
  // Phase 1.A: any opened channel triggers a shell spawn. When more
  // labels land (ota, logs), inspect peer_connection_lookup_sid_label
  // here and route accordingly.
  if (spawn_shell() < 0) {
    fprintf(stderr, "[rtc] failed to spawn shell on channel open\n");
  }
}

static void on_dc_message(char* msg, size_t len, void* user_data, uint16_t sid) {
  // Browser keystrokes arriving on the shell channel — write straight to
  // the PTY master fd. The TextEncoder on the dashboard side sends UTF-8
  // bytes; the shell sees them as terminal input.
  if (g_pty_master_fd >= 0 && len > 0) {
    ssize_t off = 0;
    while (off < (ssize_t)len) {
      ssize_t n = write(g_pty_master_fd, msg + off, len - off);
      if (n < 0) {
        if (errno == EINTR) continue;
        break;
      }
      off += n;
    }
  }
}

static void on_dc_close(void* user_data) {
  fprintf(stderr, "[rtc] datachannel closed\n");
  reap_shell();
}

// libpeer's processing tick. Mirrors the example's polling pattern.
static void* loop_pump(void* user_data) {
  while (g_loop_running && !g_interrupted) {
    pthread_mutex_lock(&g_mu);
    if (g_pc) peer_connection_loop(g_pc);
    pthread_mutex_unlock(&g_mu);
    usleep(1000);
  }
  return NULL;
}

// Tear down current PC + shell + PTY. Caller must hold g_mu.
static void teardown_locked(void) {
  reap_shell();
  if (g_pc) {
    peer_connection_close(g_pc);
    peer_connection_destroy(g_pc);
    g_pc = NULL;
  }
}

// ── HTTP signaling ──────────────────────────────────────────────────────
//
// Trivial HTTP — single endpoint, single request type. Avoids dragging in a
// dependency for what's structurally a 30-line parser.

static const char PNA_HEADERS[] =
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: POST, OPTIONS\r\n"
    "Access-Control-Allow-Headers: Content-Type\r\n"
    "Access-Control-Allow-Private-Network: true\r\n"
    "Access-Control-Max-Age: 86400\r\n";

static void send_response(int fd, int status, const char* status_text,
                          const char* content_type, const char* body, size_t body_len) {
  char hdr[1024];
  int n = snprintf(hdr, sizeof(hdr),
      "HTTP/1.1 %d %s\r\n"
      "%s"
      "Content-Type: %s\r\n"
      "Content-Length: %zu\r\n"
      "Connection: close\r\n"
      "\r\n",
      status, status_text, PNA_HEADERS, content_type ? content_type : "text/plain", body_len);
  if (write(fd, hdr, n) != n) return;
  if (body && body_len > 0) {
    ssize_t off = 0;
    while (off < (ssize_t)body_len) {
      ssize_t w = write(fd, body + off, body_len - off);
      if (w <= 0) return;
      off += w;
    }
  }
}

// Find the JSON `"sdp": "..."` value in the request body. Single-key parse —
// the dashboard only ever sends `{"sdp": "<text>"}` so we don't need a real
// JSON parser. SDPs include \r\n which become escaped as `\r\n` in JSON
// strings; unescape minimally.
static char* extract_sdp(const char* body, size_t body_len) {
  const char* key = "\"sdp\"";
  const char* p = memmem(body, body_len, key, strlen(key));
  if (!p) return NULL;
  p += strlen(key);
  while (p < body + body_len && (*p == ' ' || *p == ':' || *p == '\t')) p++;
  if (p >= body + body_len || *p != '"') return NULL;
  p++;
  const char* start = p;
  // Find closing unescaped quote
  while (p < body + body_len) {
    if (*p == '\\' && p + 1 < body + body_len) { p += 2; continue; }
    if (*p == '"') break;
    p++;
  }
  if (p >= body + body_len) return NULL;
  size_t raw_len = p - start;
  char* out = malloc(raw_len + 1);
  if (!out) return NULL;
  size_t oi = 0;
  for (size_t i = 0; i < raw_len; i++) {
    if (start[i] == '\\' && i + 1 < raw_len) {
      char c = start[i + 1];
      if (c == 'n')      out[oi++] = '\n';
      else if (c == 'r') out[oi++] = '\r';
      else if (c == 't') out[oi++] = '\t';
      else if (c == '"') out[oi++] = '"';
      else if (c == '\\') out[oi++] = '\\';
      else { out[oi++] = start[i]; out[oi++] = c; }
      i++;
    } else {
      out[oi++] = start[i];
    }
  }
  out[oi] = '\0';
  return out;
}

// Wrap a raw SDP string into `{"sdp": "<escaped>"}`. Escapes only the chars
// JSON requires (\, ", \r, \n).
static char* json_wrap_sdp(const char* sdp) {
  size_t n = strlen(sdp);
  char* out = malloc(n * 2 + 32);
  if (!out) return NULL;
  size_t oi = 0;
  oi += sprintf(out, "{\"sdp\":\"");
  for (size_t i = 0; i < n; i++) {
    char c = sdp[i];
    if (c == '"' || c == '\\') { out[oi++] = '\\'; out[oi++] = c; }
    else if (c == '\r') { out[oi++] = '\\'; out[oi++] = 'r'; }
    else if (c == '\n') { out[oi++] = '\\'; out[oi++] = 'n'; }
    else out[oi++] = c;
  }
  oi += sprintf(out + oi, "\"}");
  return out;
}

static void handle_offer(int client_fd, const char* body, size_t body_len) {
  char* offer_sdp = extract_sdp(body, body_len);
  if (!offer_sdp) {
    const char* err = "{\"error\":\"missing sdp\"}";
    send_response(client_fd, 400, "Bad Request", "application/json", err, strlen(err));
    return;
  }

  pthread_mutex_lock(&g_mu);
  teardown_locked();

  PeerConfiguration cfg = {
      .ice_servers = {{ NULL, NULL, NULL }},  // LAN-direct, no STUN/TURN
      .audio_codec = CODEC_NONE,
      .video_codec = CODEC_NONE,
      .datachannel = DATA_CHANNEL_BINARY,
  };
  g_pc = peer_connection_create(&cfg);
  if (!g_pc) {
    pthread_mutex_unlock(&g_mu);
    free(offer_sdp);
    const char* err = "{\"error\":\"peer_connection_create failed\"}";
    send_response(client_fd, 500, "Internal Server Error", "application/json", err, strlen(err));
    return;
  }
  peer_connection_oniceconnectionstatechange(g_pc, on_state_change);
  peer_connection_ondatachannel(g_pc, on_dc_message, on_dc_open, on_dc_close);

  peer_connection_set_remote_description(g_pc, offer_sdp, SDP_TYPE_OFFER);
  free(offer_sdp);

  const char* answer_sdp = peer_connection_create_answer(g_pc);
  pthread_mutex_unlock(&g_mu);

  if (!answer_sdp) {
    const char* err = "{\"error\":\"create_answer returned null\"}";
    send_response(client_fd, 500, "Internal Server Error", "application/json", err, strlen(err));
    return;
  }
  char* response_json = json_wrap_sdp(answer_sdp);
  if (!response_json) {
    send_response(client_fd, 500, "Internal Server Error", "text/plain", "alloc fail", 10);
    return;
  }
  send_response(client_fd, 200, "OK", "application/json", response_json, strlen(response_json));
  free(response_json);
}

// Read the full HTTP request (request line + headers + body) up to
// HTTP_BUF_SIZE. Single-shot, no streaming — body must fit. SDPs from the
// dashboard are typically <8 KB, well under the buffer.
static void serve_one(int client_fd) {
  char* buf = malloc(HTTP_BUF_SIZE);
  if (!buf) { close(client_fd); return; }
  size_t total = 0;
  size_t header_end = 0;
  size_t content_length = 0;
  // Read until we have headers + content-length bytes of body.
  while (total < HTTP_BUF_SIZE - 1) {
    ssize_t n = read(client_fd, buf + total, HTTP_BUF_SIZE - 1 - total);
    if (n <= 0) break;
    total += (size_t)n;
    buf[total] = '\0';
    if (header_end == 0) {
      char* sep = strstr(buf, "\r\n\r\n");
      if (sep) {
        header_end = (size_t)(sep - buf) + 4;
        // Parse Content-Length
        char* cl = strcasestr(buf, "content-length:");
        if (cl && cl < sep) {
          cl += strlen("content-length:");
          while (*cl == ' ' || *cl == '\t') cl++;
          content_length = (size_t)atol(cl);
        }
      }
    }
    if (header_end > 0 && total >= header_end + content_length) break;
  }
  if (total == 0) { free(buf); close(client_fd); return; }
  buf[total] = '\0';

  // Method + path
  if (strncmp(buf, "OPTIONS ", 8) == 0) {
    // PNA preflight
    send_response(client_fd, 204, "No Content", NULL, NULL, 0);
  } else if (strncmp(buf, "POST /webrtc/offer", 18) == 0) {
    if (header_end == 0 || total < header_end + content_length) {
      const char* err = "{\"error\":\"truncated body\"}";
      send_response(client_fd, 400, "Bad Request", "application/json", err, strlen(err));
    } else {
      handle_offer(client_fd, buf + header_end, content_length);
    }
  } else {
    const char* err = "not found";
    send_response(client_fd, 404, "Not Found", "text/plain", err, strlen(err));
  }
  free(buf);
  close(client_fd);
}

// ── main / signals ──────────────────────────────────────────────────────

static void on_signal(int sig) { g_interrupted = 1; }

int main(int argc, char* argv[]) {
  signal(SIGINT, on_signal);
  signal(SIGTERM, on_signal);
  signal(SIGPIPE, SIG_IGN);  // never crash on broken-write to a closed peer

  peer_init();

  g_loop_running = 1;
  if (pthread_create(&g_loop_thread, NULL, loop_pump, NULL) != 0) {
    fprintf(stderr, "[rtc] failed to start loop thread\n");
    return 1;
  }

  int srv = socket(AF_INET, SOCK_STREAM, 0);
  if (srv < 0) { perror("socket"); return 1; }
  int one = 1;
  setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in addr = {
      .sin_family = AF_INET,
      .sin_addr.s_addr = htonl(INADDR_ANY),
      .sin_port = htons(LISTEN_PORT),
  };
  if (bind(srv, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    perror("bind"); return 1;
  }
  if (listen(srv, 4) < 0) { perror("listen"); return 1; }
  fprintf(stderr, "[rtc] listening on :%d\n", LISTEN_PORT);

  while (!g_interrupted) {
    struct sockaddr_in cli;
    socklen_t clilen = sizeof(cli);
    int c = accept(srv, (struct sockaddr*)&cli, &clilen);
    if (c < 0) { if (errno == EINTR) continue; perror("accept"); break; }
    serve_one(c);
  }

  fprintf(stderr, "[rtc] shutting down\n");
  close(srv);

  pthread_mutex_lock(&g_mu);
  teardown_locked();
  pthread_mutex_unlock(&g_mu);

  g_loop_running = 0;
  pthread_join(g_loop_thread, NULL);
  peer_deinit();
  return 0;
}
