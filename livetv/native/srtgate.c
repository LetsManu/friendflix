// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// srtgate: livetv's SRT push listener (spec §3.5, plan ruling 2, Task 29). A standalone helper on the system libsrt, spawned once
// by livetv (src/srtingest.ts): a crash ends only this process, and livetv starts it again.
//
//   srtgate --ports 9000-9009 [--bind 0.0.0.0]   listen on every UDP port of the range (SRT listener, live mode)
//   srtgate --selftest                           in-process callers against two loopback listeners; exit 0 = ok
//
// stdin: JSON lines {"t":"feeds","feeds":[{"port":9000,"streamId":"ff-…","passphrase":"…"}]}; each replaces the whole set (a
// line that does not parse changes nothing). A port without a feed accepts nobody. New credentials for a port drop its sender.
// stdin EOF: srtgate exits.
// stdout: frames, written by the main thread only:
//   data  0x01 <u16 port BE> <u32 len BE> <payload>
//   event 0x02 <u32 len BE> <json>   {"t":"accepted","port"} {"t":"closed","port"} {"t":"rejected","port","reason"}
//   reason: "forbidden" (unknown stream id, another port's id, HSv4), "conflict" (a sender is connected), "passphrase" (the key
//   exchange failed after the stream id matched). No frame ever carries a stream id, a passphrase or a peer address.
// stderr: fixed texts only (livetv does not read it).
//
// The handshake (srt_listen_callback, libsrt's receive thread): the caller's stream id is compared in constant time with the
// feed of the port it called; a match gets that feed's passphrase (SRTO_PASSPHRASE, SRTO_PBKEYLEN 32) set on the new socket, and
// libsrt's key exchange (SRTO_ENFORCEDENCRYPTION) refuses a wrong passphrase. A handshake the callback let through that never
// reaches srt_accept within PENDING_TIMEOUT_S counts as a passphrase rejection. An address with 20 rejections within 1 min is
// ignored for 10 min (refused without an event).

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <syslog.h>
#include <srt/srt.h>
#if defined(__has_include)
#if __has_include(<srt/access_control.h>)
#include <srt/access_control.h>
#endif
#endif
#ifndef SRT_REJX_FORBIDDEN
#define SRT_REJX_FORBIDDEN 1403
#endif
#ifndef SRT_REJX_CONFLICT
#define SRT_REJX_CONFLICT 1409
#endif

#define MAX_PORTS 100
#define NFEED_MAX 128
#define SID_MAX 512
#define PASS_MIN 10
#define PASS_MAX 79
#define LINE_MAX_BYTES (256 * 1024)
#define PAYLOAD_MAX 1500
#define READS_PER_WAKE 1024
#define PENDING_MAX 256
#define PENDING_TIMEOUT_S 3.0
#define THROTTLE_MAX 1024
#define THROTTLE_HITS 20
#define THROTTLE_WINDOW_S 60.0
#define THROTTLE_BAN_S 600.0
#define EVENTS_MAX 1024

enum { R_NONE = 0, R_FORBIDDEN = 1, R_CONFLICT = 2, R_PASSPHRASE = 3 };
static const char *const REASON_NAME[] = { "", "forbidden", "conflict", "passphrase" };

typedef struct {
  int port;
  SRTSOCKET lsn;
  int has_feed;
  unsigned gen;
  char sid[SID_MAX + 1];
  size_t sid_len;
  char pass[PASS_MAX + 1];
  size_t pass_len;
  SRTSOCKET sender;
  int kick;
} slot_t;

typedef struct { unsigned char a[16]; int fam; } addrkey_t;
typedef struct { addrkey_t k; double first; double last; int hits; double banned_until; int used; } throttle_t;
typedef struct { SRTSOCKET ns; int idx; unsigned gen; addrkey_t k; double at; } pending_t;
typedef struct { int idx; int reason; } event_t;
typedef struct {
  long port;
  char sid[SID_MAX + 1];
  size_t sl;
  char pass[PASS_MAX + 1];
  size_t pl;
  int has_port, has_sid, has_pass;
} nfeed_t;

static slot_t g_slots[MAX_PORTS];
static int g_nslots;
// guards g_slots' feed fields and `sender`, the throttle, the pending handshakes, the event queue and g_seen
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static throttle_t g_thr[THROTTLE_MAX];
static pending_t g_pend[PENDING_MAX];
static int g_npend;
static event_t g_ev[EVENTS_MAX];
static int g_nev;
static atomic_int g_quit;
static int g_eid = -1;
static int g_selftest;
// selftest: what would have been written
static struct { long accepted[MAX_PORTS]; long closed[MAX_PORTS]; long data[MAX_PORTS]; long rejected[MAX_PORTS][4]; } g_seen;
static nfeed_t g_nf[NFEED_MAX];

static double mono(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

static void nap_ms(int ms) {
  struct timespec t = { ms / 1000, (long)(ms % 1000) * 1000000L };
  nanosleep(&t, NULL);
}

static void put32(unsigned char *p, uint32_t v) {
  p[0] = (unsigned char)(v >> 24);
  p[1] = (unsigned char)(v >> 16);
  p[2] = (unsigned char)(v >> 8);
  p[3] = (unsigned char)v;
}

static int printable(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c < 0x20 || c > 0x7e) return 0;
  }
  return 1;
}

// equal in time that does not depend on where the strings differ (always SID_MAX rounds)
static int ct_equal(const char *a, size_t alen, const char *b, size_t blen) {
  volatile unsigned char acc = (unsigned char)(alen != blen);
  for (size_t i = 0; i < SID_MAX; i++) {
    unsigned char x = i < alen ? (unsigned char)a[i] : 0;
    unsigned char y = i < blen ? (unsigned char)b[i] : 0;
    acc |= (unsigned char)(x ^ y);
  }
  return acc == 0;
}

// ---- output (main thread only) ----

static void write_all(const void *buf, size_t n) {
  const char *p = buf;
  while (n > 0) {
    ssize_t w = write(1, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      _exit(0); // livetv is gone
    }
    p += w;
    n -= (size_t)w;
  }
}

static void emit_json(const char *json, int len) {
  unsigned char h[5];
  if (len <= 0) return;
  h[0] = 0x02;
  put32(h + 1, (uint32_t)len);
  write_all(h, 5);
  write_all(json, (size_t)len);
}

static void emit_state(int accepted, int idx) {
  if (g_selftest) {
    pthread_mutex_lock(&g_mu);
    if (accepted) g_seen.accepted[idx]++;
    else g_seen.closed[idx]++;
    pthread_mutex_unlock(&g_mu);
    return;
  }
  char j[64];
  int n = snprintf(j, sizeof j, "{\"t\":\"%s\",\"port\":%d}", accepted ? "accepted" : "closed", g_slots[idx].port);
  emit_json(j, n);
}

static void emit_rejected(int idx, int reason) {
  if (reason <= R_NONE || reason > R_PASSPHRASE) return;
  if (g_selftest) {
    pthread_mutex_lock(&g_mu);
    g_seen.rejected[idx][reason]++;
    pthread_mutex_unlock(&g_mu);
    return;
  }
  char j[96];
  int n = snprintf(j, sizeof j, "{\"t\":\"rejected\",\"port\":%d,\"reason\":\"%s\"}", g_slots[idx].port, REASON_NAME[reason]);
  emit_json(j, n);
}

static void emit_data(int idx, const char *p, int n) {
  if (n <= 0) return;
  if (g_selftest) {
    pthread_mutex_lock(&g_mu);
    g_seen.data[idx] += n;
    pthread_mutex_unlock(&g_mu);
    return;
  }
  unsigned char b[7 + PAYLOAD_MAX];
  int port = g_slots[idx].port;
  b[0] = 0x01;
  b[1] = (unsigned char)(port >> 8);
  b[2] = (unsigned char)port;
  put32(b + 3, (uint32_t)n);
  memcpy(b + 7, p, (size_t)n);
  write_all(b, (size_t)n + 7);
}

// ---- throttle, pending handshakes, event queue (all under g_mu) ----

static void key_of(const struct sockaddr *sa, addrkey_t *k) {
  memset(k, 0, sizeof *k);
  if (!sa) return;
  if (sa->sa_family == AF_INET) {
    k->fam = 4;
    memcpy(k->a, &((const struct sockaddr_in *)sa)->sin_addr, 4);
  } else if (sa->sa_family == AF_INET6) {
    k->fam = 6;
    memcpy(k->a, &((const struct sockaddr_in6 *)sa)->sin6_addr, 16);
  }
}

static throttle_t *thr_find(const addrkey_t *k, int create, double now) {
  throttle_t *free_e = NULL, *oldest = NULL;
  for (int i = 0; i < THROTTLE_MAX; i++) {
    throttle_t *e = &g_thr[i];
    if (e->used && e->k.fam == k->fam && memcmp(e->k.a, k->a, sizeof k->a) == 0) return e;
    if (!e->used) {
      if (!free_e) free_e = e;
    } else if (e->banned_until <= now && (!oldest || e->last < oldest->last)) {
      oldest = e;
    }
  }
  if (!create) return NULL;
  throttle_t *e = free_e ? free_e : oldest;
  if (!e) return NULL; // every entry is a running ban
  memset(e, 0, sizeof *e);
  e->used = 1;
  e->k = *k;
  e->first = now;
  e->last = now;
  return e;
}

static int thr_banned(const addrkey_t *k, double now) {
  throttle_t *e = thr_find(k, 0, now);
  return e && e->banned_until > now;
}

static void thr_hit(const addrkey_t *k, double now) {
  throttle_t *e = thr_find(k, 1, now);
  if (!e) return;
  if (now - e->first > THROTTLE_WINDOW_S) {
    e->first = now;
    e->hits = 0;
  }
  e->hits++;
  e->last = now;
  if (e->hits >= THROTTLE_HITS) {
    e->banned_until = now + THROTTLE_BAN_S;
    e->hits = 0;
    e->first = now;
  }
}

static void ev_push(int idx, int reason) {
  if (g_nev < EVENTS_MAX) {
    g_ev[g_nev].idx = idx;
    g_ev[g_nev].reason = reason;
    g_nev++;
  }
}

static void pend_add(SRTSOCKET ns, int idx, unsigned gen, const addrkey_t *k, double now) {
  if (g_npend == PENDING_MAX) {
    memmove(&g_pend[0], &g_pend[1], sizeof(pending_t) * (PENDING_MAX - 1));
    g_npend--;
  }
  pending_t *p = &g_pend[g_npend++];
  p->ns = ns;
  p->idx = idx;
  p->gen = gen;
  p->k = *k;
  p->at = now;
}

static int pend_take(SRTSOCKET ns, unsigned *gen) {
  for (int i = 0; i < g_npend; i++) {
    if (g_pend[i].ns != ns) continue;
    if (gen) *gen = g_pend[i].gen;
    memmove(&g_pend[i], &g_pend[i + 1], sizeof(pending_t) * (size_t)(g_npend - i - 1));
    g_npend--;
    return 1;
  }
  return 0;
}

// ---- the handshake (libsrt's thread) ----

static int listen_hook(void *opaq, SRTSOCKET ns, int hsversion, const struct sockaddr *peer, const char *streamid) {
  int idx = (int)(intptr_t)opaq;
  slot_t *s = &g_slots[idx];
  double now = mono();
  addrkey_t k;
  char pass[PASS_MAX + 1];
  size_t pass_len = 0;
  int reason = R_NONE;
  size_t sl = streamid ? strnlen(streamid, SID_MAX + 1) : 0;
  key_of(peer, &k);

  pthread_mutex_lock(&g_mu);
  if (thr_banned(&k, now)) {
    pthread_mutex_unlock(&g_mu);
    srt_setrejectreason(ns, SRT_REJX_FORBIDDEN);
    return -1;
  }
  int match = ct_equal(streamid ? streamid : "", sl > SID_MAX ? SID_MAX : sl, s->sid, s->sid_len);
  if (hsversion < 5 || !s->has_feed || sl == 0 || sl > SID_MAX || !match) reason = R_FORBIDDEN;
  else if (s->sender != SRT_INVALID_SOCK) reason = R_CONFLICT;
  if (reason != R_NONE) {
    thr_hit(&k, now);
    ev_push(idx, reason);
  } else {
    memcpy(pass, s->pass, s->pass_len);
    pass_len = s->pass_len;
    pend_add(ns, idx, s->gen, &k, now);
  }
  pthread_mutex_unlock(&g_mu);

  if (reason != R_NONE) {
    srt_setrejectreason(ns, reason == R_CONFLICT ? SRT_REJX_CONFLICT : SRT_REJX_FORBIDDEN);
    return -1;
  }
  int keylen = 32;
  int bad = srt_setsockflag(ns, SRTO_PASSPHRASE, pass, (int)pass_len) == SRT_ERROR
         || srt_setsockflag(ns, SRTO_PBKEYLEN, &keylen, sizeof keylen) == SRT_ERROR;
  explicit_bzero(pass, sizeof pass);
  if (bad) {
    pthread_mutex_lock(&g_mu);
    pend_take(ns, NULL);
    pthread_mutex_unlock(&g_mu);
    srt_setrejectreason(ns, SRT_REJX_FORBIDDEN);
    return -1;
  }
  return 0;
}

// ---- the feed set (stdin thread; the selftest's main thread) ----

typedef struct { const char *p; const char *e; } jcur;

static void jws(jcur *c) {
  while (c->p < c->e && (*c->p == ' ' || *c->p == '\t' || *c->p == '\r' || *c->p == '\n')) c->p++;
}

static int jch(jcur *c, char ch) {
  jws(c);
  if (c->p < c->e && *c->p == ch) { c->p++; return 1; }
  return 0;
}

static int jlit(jcur *c, const char *w) {
  size_t n = strlen(w);
  jws(c);
  if ((size_t)(c->e - c->p) >= n && memcmp(c->p, w, n) == 0) { c->p += n; return 1; }
  return 0;
}

static int hexval(char h) {
  if (h >= '0' && h <= '9') return h - '0';
  if (h >= 'a' && h <= 'f') return h - 'a' + 10;
  if (h >= 'A' && h <= 'F') return h - 'A' + 10;
  return -1;
}

// a JSON string into out (cap includes the NUL; out NULL = skip); \u escapes only for ASCII 1-127
static int jstr(jcur *c, char *out, size_t cap, size_t *outlen) {
  size_t n = 0;
  jws(c);
  if (c->p >= c->e || *c->p != '"') return 0;
  c->p++;
  while (c->p < c->e) {
    unsigned char ch = (unsigned char)*c->p++;
    if (ch == '"') {
      if (out) out[n] = 0;
      if (outlen) *outlen = n;
      return 1;
    }
    if (ch < 0x20) return 0;
    if (ch == '\\') {
      if (c->p >= c->e) return 0;
      char esc = *c->p++;
      switch (esc) {
        case '"': ch = '"'; break;
        case '\\': ch = '\\'; break;
        case '/': ch = '/'; break;
        case 'b': ch = '\b'; break;
        case 'f': ch = '\f'; break;
        case 'n': ch = '\n'; break;
        case 'r': ch = '\r'; break;
        case 't': ch = '\t'; break;
        case 'u': {
          unsigned v = 0;
          if (c->e - c->p < 4) return 0;
          for (int i = 0; i < 4; i++) {
            int h = hexval(c->p[i]);
            if (h < 0) return 0;
            v = v * 16 + (unsigned)h;
          }
          c->p += 4;
          if (v == 0 || v > 0x7f) return 0;
          ch = (unsigned char)v;
          break;
        }
        default: return 0;
      }
    }
    if (out) {
      if (n + 1 >= cap) return 0;
      out[n] = (char)ch;
    }
    n++;
  }
  return 0;
}

static int jint(jcur *c, long *v) {
  long x = 0;
  int digits = 0, neg = 0;
  jws(c);
  if (c->p < c->e && *c->p == '-') { neg = 1; c->p++; }
  while (c->p < c->e && *c->p >= '0' && *c->p <= '9') {
    if (digits >= 9) return 0;
    x = x * 10 + (*c->p - '0');
    c->p++;
    digits++;
  }
  if (!digits) return 0;
  if (c->p < c->e && (*c->p == '.' || *c->p == 'e' || *c->p == 'E')) return 0;
  *v = neg ? -x : x;
  return 1;
}

static int jskip(jcur *c, int depth) {
  if (depth > 16) return 0;
  jws(c);
  if (c->p >= c->e) return 0;
  char ch = *c->p;
  if (ch == '"') return jstr(c, NULL, 0, NULL);
  if (ch == '{') {
    c->p++;
    if (jch(c, '}')) return 1;
    do {
      if (!jstr(c, NULL, 0, NULL) || !jch(c, ':') || !jskip(c, depth + 1)) return 0;
    } while (jch(c, ','));
    return jch(c, '}');
  }
  if (ch == '[') {
    c->p++;
    if (jch(c, ']')) return 1;
    do {
      if (!jskip(c, depth + 1)) return 0;
    } while (jch(c, ','));
    return jch(c, ']');
  }
  if (ch == '-' || (ch >= '0' && ch <= '9')) {
    const char *s = c->p;
    while (c->p < c->e && *c->p && strchr("+-0123456789.eE", *c->p)) c->p++;
    return c->p > s;
  }
  return jlit(c, "true") || jlit(c, "false") || jlit(c, "null");
}

static int parse_feed(jcur *c, nfeed_t *f) {
  memset(f, 0, sizeof *f);
  if (!jch(c, '{') || jch(c, '}')) return 0;
  do {
    char key[64];
    if (!jstr(c, key, sizeof key, NULL) || !jch(c, ':')) return 0;
    if (strcmp(key, "port") == 0) {
      if (!jint(c, &f->port)) return 0;
      f->has_port = 1;
    } else if (strcmp(key, "streamId") == 0) {
      if (!jstr(c, f->sid, sizeof f->sid, &f->sl)) return 0;
      f->has_sid = 1;
    } else if (strcmp(key, "passphrase") == 0) {
      if (!jstr(c, f->pass, sizeof f->pass, &f->pl)) return 0;
      f->has_pass = 1;
    } else if (!jskip(c, 1)) {
      return 0;
    }
  } while (jch(c, ','));
  if (!jch(c, '}')) return 0;
  return f->has_port && f->has_sid && f->has_pass && f->port >= 1 && f->port <= 65535 && f->sl >= 1 && f->sl <= SID_MAX
      && f->pl >= PASS_MIN && f->pl <= PASS_MAX && printable(f->sid, f->sl) && printable(f->pass, f->pl);
}

static int parse_line(const char *line, size_t len, nfeed_t *out, int *nout) {
  jcur c = { line, line + len };
  int is_feeds = 0, have = 0;
  *nout = 0;
  if (!jch(&c, '{') || jch(&c, '}')) return 0;
  do {
    char key[64];
    if (!jstr(&c, key, sizeof key, NULL) || !jch(&c, ':')) return 0;
    if (strcmp(key, "t") == 0) {
      char t[16];
      if (!jstr(&c, t, sizeof t, NULL)) return 0;
      is_feeds = strcmp(t, "feeds") == 0;
    } else if (strcmp(key, "feeds") == 0) {
      if (!jch(&c, '[')) return 0;
      have = 1;
      if (!jch(&c, ']')) {
        do {
          if (*nout >= NFEED_MAX || !parse_feed(&c, &out[*nout])) return 0;
          (*nout)++;
        } while (jch(&c, ','));
        if (!jch(&c, ']')) return 0;
      }
    } else if (!jskip(&c, 1)) {
      return 0;
    }
  } while (jch(&c, ','));
  if (!jch(&c, '}')) return 0;
  jws(&c);
  return c.p == c.e && is_feeds && have;
}

static void apply_feeds(const nfeed_t *nf, int n) {
  pthread_mutex_lock(&g_mu);
  for (int i = 0; i < g_nslots; i++) {
    slot_t *s = &g_slots[i];
    const nfeed_t *f = NULL;
    for (int j = 0; j < n; j++) {
      if (nf[j].port == s->port) { f = &nf[j]; break; }
    }
    int same = s->has_feed && f && f->sl == s->sid_len && memcmp(f->sid, s->sid, f->sl) == 0 && f->pl == s->pass_len
            && memcmp(f->pass, s->pass, f->pl) == 0;
    if (same) continue;
    s->gen++;
    if (s->sender != SRT_INVALID_SOCK) s->kick = 1;
    explicit_bzero(s->sid, sizeof s->sid);
    explicit_bzero(s->pass, sizeof s->pass);
    if (f) {
      memcpy(s->sid, f->sid, f->sl);
      s->sid_len = f->sl;
      memcpy(s->pass, f->pass, f->pl);
      s->pass_len = f->pl;
      s->has_feed = 1;
    } else {
      s->sid_len = 0;
      s->pass_len = 0;
      s->has_feed = 0;
    }
  }
  pthread_mutex_unlock(&g_mu);
}

static int apply_line(const char *line, size_t len) {
  int n = 0;
  int ok = parse_line(line, len, g_nf, &n);
  if (ok) apply_feeds(g_nf, n);
  else fputs("srtgate: ignored a feeds line that does not parse\n", stderr);
  explicit_bzero(g_nf, sizeof g_nf);
  return ok;
}

static void *stdin_thread(void *arg) {
  static char line[LINE_MAX_BYTES];
  char buf[65536];
  size_t len = 0;
  int skipping = 0;
  (void)arg;
  for (;;) {
    ssize_t n = read(0, buf, sizeof buf);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    for (ssize_t i = 0; i < n; i++) {
      char ch = buf[i];
      if (ch == '\n') {
        if (!skipping && len > 0) apply_line(line, len);
        explicit_bzero(line, len);
        len = 0;
        skipping = 0;
        continue;
      }
      if (skipping) continue;
      if (len + 1 >= LINE_MAX_BYTES) {
        explicit_bzero(line, len);
        len = 0;
        skipping = 1;
        continue;
      }
      line[len++] = ch;
    }
  }
  atomic_store(&g_quit, 1);
  return NULL;
}

// ---- the gate (main thread) ----

static void flush_events(void) {
  static event_t ev[EVENTS_MAX];
  int n;
  pthread_mutex_lock(&g_mu);
  n = g_nev;
  memcpy(ev, g_ev, sizeof(event_t) * (size_t)n);
  g_nev = 0;
  pthread_mutex_unlock(&g_mu);
  for (int i = 0; i < n; i++) emit_rejected(ev[i].idx, ev[i].reason);
}

// let through by the callback, never accepted: the key exchange failed (a wrong or missing passphrase)
static void check_pending(double now) {
  pthread_mutex_lock(&g_mu);
  for (int i = 0; i < g_npend;) {
    if (now - g_pend[i].at > PENDING_TIMEOUT_S) {
      thr_hit(&g_pend[i].k, now);
      ev_push(g_pend[i].idx, R_PASSPHRASE);
      memmove(&g_pend[i], &g_pend[i + 1], sizeof(pending_t) * (size_t)(g_npend - i - 1));
      g_npend--;
    } else {
      i++;
    }
  }
  pthread_mutex_unlock(&g_mu);
}

static void close_sender(int idx) {
  SRTSOCKET a;
  pthread_mutex_lock(&g_mu);
  a = g_slots[idx].sender;
  g_slots[idx].sender = SRT_INVALID_SOCK;
  g_slots[idx].kick = 0;
  pthread_mutex_unlock(&g_mu);
  if (a == SRT_INVALID_SOCK) return;
  srt_epoll_remove_usock(g_eid, a);
  srt_close(a);
  emit_state(0, idx);
}

static void apply_kicks(void) {
  int kicked[MAX_PORTS];
  int n = 0;
  pthread_mutex_lock(&g_mu);
  for (int i = 0; i < g_nslots; i++) if (g_slots[i].kick) kicked[n++] = i;
  pthread_mutex_unlock(&g_mu);
  for (int i = 0; i < n; i++) close_sender(kicked[i]);
}

static void accept_on(int idx) {
  for (;;) {
    struct sockaddr_storage sa;
    int sl = (int)sizeof sa;
    SRTSOCKET a = srt_accept(g_slots[idx].lsn, (struct sockaddr *)&sa, &sl);
    if (a == SRT_INVALID_SOCK) return;
    addrkey_t k;
    unsigned gen = 0;
    int ok, busy;
    key_of((struct sockaddr *)&sa, &k);
    pthread_mutex_lock(&g_mu);
    slot_t *s = &g_slots[idx];
    int found = pend_take(a, &gen);
    // the set changed between the handshake and now: these credentials no longer hold
    ok = s->has_feed && (!found || gen == s->gen);
    busy = s->sender != SRT_INVALID_SOCK;
    if (ok && !busy) {
      s->sender = a;
      s->kick = 0;
    } else if (ok && busy) {
      thr_hit(&k, mono());
    }
    pthread_mutex_unlock(&g_mu);
    if (!ok || busy) {
      srt_close(a);
      if (ok) emit_rejected(idx, R_CONFLICT);
      continue;
    }
    int ev = SRT_EPOLL_IN | SRT_EPOLL_ERR;
    srt_epoll_add_usock(g_eid, a, &ev);
    emit_state(1, idx);
  }
}

static void read_from(int idx) {
  char buf[PAYLOAD_MAX];
  for (int i = 0; i < READS_PER_WAKE; i++) {
    SRTSOCKET a = g_slots[idx].sender;
    if (a == SRT_INVALID_SOCK) return;
    int n = srt_recvmsg(a, buf, (int)sizeof buf);
    if (n > 0) {
      emit_data(idx, buf, n);
      continue;
    }
    if (n == SRT_ERROR && srt_getlasterror(NULL) == SRT_EASYNCRCV) return;
    if (n == 0) return;
    close_sender(idx);
    return;
  }
}

static void gate_loop(void) {
  SRT_EPOLL_EVENT ev[64];
  while (!atomic_load(&g_quit)) {
    check_pending(mono());
    flush_events();
    apply_kicks();
    int n = srt_epoll_uwait(g_eid, ev, 64, 100);
    for (int i = 0; i < n; i++) {
      SRTSOCKET u = ev[i].fd;
      int done = 0;
      for (int j = 0; j < g_nslots && !done; j++) {
        if (g_slots[j].lsn == u) {
          accept_on(j);
          done = 1;
        } else if (g_slots[j].sender == u) {
          if (ev[i].events & SRT_EPOLL_IN) read_from(j);
          if (g_slots[j].sender == u && ((ev[i].events & SRT_EPOLL_ERR) || srt_getsockstate(u) >= SRTS_BROKEN)) close_sender(j);
          done = 1;
        }
      }
    }
  }
  flush_events();
}

static int open_listener(int idx, const char *addr, int port) {
  slot_t *s = &g_slots[idx];
  memset(s, 0, sizeof *s);
  s->port = port;
  s->sender = SRT_INVALID_SOCK;
  s->lsn = SRT_INVALID_SOCK;
  SRTSOCKET l = srt_create_socket();
  if (l == SRT_INVALID_SOCK) return -1;
  int no = 0, yes = 1, keylen = 32;
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons((uint16_t)port);
  if (inet_pton(AF_INET, addr, &sa.sin_addr) != 1
      || srt_setsockflag(l, SRTO_RCVSYN, &no, sizeof no) == SRT_ERROR
      || srt_setsockflag(l, SRTO_ENFORCEDENCRYPTION, &yes, sizeof yes) == SRT_ERROR
      || srt_setsockflag(l, SRTO_PBKEYLEN, &keylen, sizeof keylen) == SRT_ERROR
      || srt_bind(l, (struct sockaddr *)&sa, (int)sizeof sa) == SRT_ERROR) {
    srt_close(l);
    return -1;
  }
  if (port == 0) {
    struct sockaddr_in got;
    int gl = (int)sizeof got;
    if (srt_getsockname(l, (struct sockaddr *)&got, &gl) == SRT_ERROR) { srt_close(l); return -1; }
    s->port = ntohs(got.sin_port);
  }
  if (srt_listen_callback(l, listen_hook, (void *)(intptr_t)idx) == SRT_ERROR || srt_listen(l, 4) == SRT_ERROR) {
    srt_close(l);
    return -1;
  }
  int ev = SRT_EPOLL_IN | SRT_EPOLL_ERR;
  if (srt_epoll_add_usock(g_eid, l, &ev) == SRT_ERROR) { srt_close(l); return -1; }
  s->lsn = l;
  return 0;
}

static void shutdown_all(void) {
  for (int i = 0; i < g_nslots; i++) {
    if (g_slots[i].sender != SRT_INVALID_SOCK) srt_close(g_slots[i].sender);
    if (g_slots[i].lsn != SRT_INVALID_SOCK) srt_close(g_slots[i].lsn);
  }
  if (g_eid >= 0) srt_epoll_release(g_eid);
}

static int parse_ports(const char *s, int *a, int *b) {
  char *end;
  long x = strtol(s, &end, 10);
  if (end == s || x < 1 || x > 65535) return 0;
  long y = x;
  if (*end == '-') {
    const char *t = end + 1;
    y = strtol(t, &end, 10);
    if (end == t) return 0;
  }
  if (*end || y < x || y > 65535 || y - x + 1 > MAX_PORTS) return 0;
  *a = (int)x;
  *b = (int)y;
  return 1;
}

// ---- --selftest ----

#define ST_SID_A "ff-AAAAAAAAAAAAAAAA"
#define ST_SID_B "ff-BBBBBBBBBBBBBBBB"
#define ST_PASS_A "selftest-passphrase-A-0123456789"
#define ST_PASS_B "selftest-passphrase-B-0123456789"

static void *gate_thread(void *arg) {
  (void)arg;
  gate_loop();
  return NULL;
}

static long st_seen(const long *field) {
  pthread_mutex_lock(&g_mu);
  long v = *field;
  pthread_mutex_unlock(&g_mu);
  return v;
}

static int st_wait(const long *field, long atleast, double secs) {
  double end = mono() + secs;
  while (mono() < end) {
    if (st_seen(field) >= atleast) return 1;
    nap_ms(20);
  }
  return st_seen(field) >= atleast;
}

// a caller; SRT_INVALID_SOCK when refused (its reject reason in *reject)
static SRTSOCKET st_call(int port, const char *sid, const char *pass, int *reject) {
  SRTSOCKET c = srt_create_socket();
  if (c == SRT_INVALID_SOCK) return SRT_INVALID_SOCK;
  int yes = 1, keylen = 32, timeo = 3000;
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
  srt_setsockflag(c, SRTO_RCVSYN, &yes, sizeof yes);
  srt_setsockflag(c, SRTO_CONNTIMEO, &timeo, sizeof timeo);
  srt_setsockflag(c, SRTO_STREAMID, sid, (int)strlen(sid));
  srt_setsockflag(c, SRTO_PASSPHRASE, pass, (int)strlen(pass));
  srt_setsockflag(c, SRTO_PBKEYLEN, &keylen, sizeof keylen);
  if (srt_connect(c, (struct sockaddr *)&sa, (int)sizeof sa) == SRT_ERROR) {
    if (reject) *reject = srt_getrejectreason(c);
    srt_close(c);
    return SRT_INVALID_SOCK;
  }
  return c;
}

static int st_fail(const char *what) {
  fprintf(stderr, "srtgate selftest: FAILED: %s\n", what);
  return 1;
}

static int selftest_body(void) {
  int pa = g_slots[0].port, pb = g_slots[1].port, rej;
  char line[512];
  snprintf(line, sizeof line,
           "{\"t\":\"feeds\",\"feeds\":[{\"port\":%d,\"streamId\":\"" ST_SID_A "\",\"passphrase\":\"" ST_PASS_A "\"},"
           "{\"port\":%d,\"streamId\":\"" ST_SID_B "\",\"passphrase\":\"" ST_PASS_B "\"}]}", pa, pb);
  if (!apply_line(line, strlen(line))) return st_fail("the feeds line was not taken");

  // a wrong passphrase: refused in the key exchange, counted as a passphrase rejection
  if (st_call(pa, ST_SID_A, "a-wrong-passphrase-0123456789abc", NULL) != SRT_INVALID_SOCK) return st_fail("a wrong passphrase was accepted");
  if (!st_wait(&g_seen.rejected[0][R_PASSPHRASE], 1, PENDING_TIMEOUT_S + 3.0)) return st_fail("a wrong passphrase was not counted");
  if (st_seen(&g_seen.accepted[0]) != 0) return st_fail("a wrong passphrase reached accept");

  // another port's stream id: forbidden in the handshake
  rej = 0;
  if (st_call(pa, ST_SID_B, ST_PASS_B, &rej) != SRT_INVALID_SOCK) return st_fail("another port's stream id was accepted");
  if (rej != SRT_REJX_FORBIDDEN) return st_fail("another port's stream id was not refused as forbidden");
  if (!st_wait(&g_seen.rejected[0][R_FORBIDDEN], 1, 2.0)) return st_fail("a forbidden stream id was not counted");

  // the right pair: accepted, its data arrives
  SRTSOCKET ok = st_call(pa, ST_SID_A, ST_PASS_A, NULL);
  if (ok == SRT_INVALID_SOCK) return st_fail("the right pair was refused");
  if (!st_wait(&g_seen.accepted[0], 1, 3.0)) { srt_close(ok); return st_fail("the right pair was not reported accepted"); }
  char pkt[1316];
  memset(pkt, 0x47, sizeof pkt);
  if (srt_sendmsg(ok, pkt, (int)sizeof pkt, -1, 1) == SRT_ERROR) { srt_close(ok); return st_fail("the sender could not send"); }
  if (!st_wait(&g_seen.data[0], (long)sizeof pkt, 3.0)) { srt_close(ok); return st_fail("the sender's data did not arrive"); }

  // a second sender with valid credentials: conflict
  rej = 0;
  if (st_call(pa, ST_SID_A, ST_PASS_A, &rej) != SRT_INVALID_SOCK) { srt_close(ok); return st_fail("a second sender was accepted"); }
  if (rej != SRT_REJX_CONFLICT) { srt_close(ok); return st_fail("a second sender was not refused as conflict"); }

  // the sender goes: closed
  srt_close(ok);
  if (!st_wait(&g_seen.closed[0], 1, 10.0)) return st_fail("a closed sender was not reported");
  if (st_seen(&g_seen.accepted[1]) != 0 || st_seen(&g_seen.data[1]) != 0) return st_fail("the other port saw a sender");
  return 0;
}

static int selftest_run(void) {
  g_selftest = 1;
  if (srt_startup() < 0) return st_fail("libsrt did not start");
  srt_setloglevel(LOG_CRIT);
  g_eid = srt_epoll_create();
  if (g_eid < 0) return st_fail("epoll");
  if (open_listener(0, "127.0.0.1", 0) != 0 || open_listener(1, "127.0.0.1", 0) != 0) return st_fail("cannot listen on loopback");
  g_nslots = 2;
  pthread_t th;
  if (pthread_create(&th, NULL, gate_thread, NULL) != 0) return st_fail("thread");
  int r = selftest_body();
  atomic_store(&g_quit, 1);
  pthread_join(th, NULL);
  shutdown_all();
  srt_cleanup();
  if (r == 0) fputs("srtgate selftest: ok\n", stderr);
  return r;
}

static void usage(void) {
  fputs("usage: srtgate --ports A[-B] [--bind IPv4] | srtgate --selftest\n", stderr);
}

int main(int argc, char **argv) {
  const char *ports = NULL, *bind_addr = "0.0.0.0";
  int selftest = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--selftest") == 0) selftest = 1;
    else if (strcmp(argv[i], "--ports") == 0 && i + 1 < argc) ports = argv[++i];
    else if (strcmp(argv[i], "--bind") == 0 && i + 1 < argc) bind_addr = argv[++i];
    else { usage(); return 2; }
  }
  signal(SIGPIPE, SIG_IGN);
  if (selftest) return selftest_run();
  int a, b;
  if (!ports || !parse_ports(ports, &a, &b)) { usage(); return 2; }
  if (srt_startup() < 0) { fputs("srtgate: libsrt did not start\n", stderr); return 1; }
  srt_setloglevel(LOG_CRIT);
  g_eid = srt_epoll_create();
  if (g_eid < 0) { fputs("srtgate: epoll failed\n", stderr); return 1; }
  for (int p = a; p <= b; p++) {
    if (open_listener(g_nslots, bind_addr, p) != 0) {
      fprintf(stderr, "srtgate: cannot listen on UDP port %d\n", p);
      shutdown_all();
      srt_cleanup();
      return 1;
    }
    g_nslots++;
  }
  pthread_t th;
  if (pthread_create(&th, NULL, stdin_thread, NULL) != 0) { fputs("srtgate: thread failed\n", stderr); return 1; }
  pthread_detach(th);
  gate_loop();
  shutdown_all();
  srt_cleanup();
  return 0;
}
