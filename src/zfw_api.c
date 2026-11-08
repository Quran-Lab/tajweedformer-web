/* The C surface the WebAssembly module exports to JavaScript.
 *
 * Thin wrappers over zf/stream.h so the ABI is stable and JS-friendly: a handle is an opaque pointer,
 * options are plain ints, and phonemes are written into a caller-owned array of ZfwToken records
 * (zfw_token_bytes() gives the record size, so the JS side lays out its view without hard-coding it).
 * Nothing here touches a bit of the engine's arithmetic.
 *
 * The handle keeps what the SDK's zf_stream_check keeps: a running FNV-1a of every chunk's
 * log-probs since the last reset, so a run can be compared with the conformance set bit for bit
 * (zfw_logp_fnv) without copying the log-probs out.
 *
 * Evidence (zfw_create2): a stream made with ZFW_EV_QUEUE queues a copy of every chunk's evidence
 * (zf/stream.h, ZfEvidence: the log-probs, the logit energy, the CTC head's input, stacks 0 and 1,
 * the chunk's 16 kHz samples and its capture statistics) until the caller takes it
 * (zfw_evidence_records and zfw_evidence_data, then zfw_evidence_clear); ZFW_EV_FINGERPRINT keeps
 * the FNV-1a of it all that zf_stream_check --evidence prints, with the same rule checks. A stream
 * made without either sets no evidence callback, so the engine keeps no samples and copies nothing. */
#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "zf/libm.h"
#include "zf/stream.h"
#include "zf/vfs.h"

#if !defined(ZF_STREAM_HAS_EVIDENCE)
#error "zipformer-sdk ac5ce4d or later is needed: zf/stream.h without ZfEvidence"
#endif

/* The record the JS wrapper reads. The first eight fields keep this package's original layout
 * (token2 and prob2, the runner-up, at bytes 24 and 28); the run's peak follows. */
typedef struct {
  int token;
  int frame;
  float prob;
  float margin;
  float blank;
  int run;
  int token2;        /* the runner-up id at the emitting frame (may be the blank), -1 if none */
  float prob2;       /* its posterior, the value the engine's margin was taken against */
  float peak_prob;   /* the run's most confident frame (final when complete is 1) */
  float peak_margin;
  int end_frame;
  int complete;
} ZfwToken;

/* One queued chunk's evidence as the JS wrapper reads it: 4-byte fields only. The six offsets are in
 * floats into zfw_evidence_data(), -1 for a value the graph does not carry (tools/zftaps.py promotes
 * the taps) and for the samples of a chunk made from pushed frames. The last nine fields are
 * ZfCaptureStats, field for field. */
typedef struct {
  int chunk;         /* 0 for the first chunk after a reset */
  int frames, vocab; /* log-prob frames (25 a second) and classes */
  int enc_dim;       /* the CTC head's input: 512 */
  int stack0_frames, stack0_dim; /* stack 0 at 50 frames a second: 2 x frames, 192 */
  int stack1_dim;    /* stack 1 at 25 frames a second: 256 */
  int n_samples;     /* the chunk's advance x 160 samples at 16 kHz */
  int log_probs, logit_lse, enc, stack0, stack1, samples;
  int has_samples;
  float rms, peak, dc;
  int clipped, zero_runs, zero_samples;
  float noise_floor, bandwidth_hz;
} ZfwEvidence;

/* zfw_create2's `evidence`, a bit set */
#define ZFW_EV_QUEUE 1       /* queue copies for the caller */
#define ZFW_EV_FINGERPRINT 2 /* zf_stream_check --evidence's ev_fnv and ev_bad */

/* The last few chunks' log-probs, so a token's runner-up posterior can be read back exactly as the
 * decoder computed it (zf_libm_expf of the runner-up's log-prob at the emitting frame). */
#define ZFW_RING 32

#define FNV_START 1469598103934665603ull

typedef struct {
  ZfStream *s;
  uint64_t fnv;
  int vocab;
  long long frames_done;           /* decoder frames so far, as ZfToken.frame counts them */
  float *ring;                     /* ZFW_RING chunks of [max_frames, vocab] */
  long long ring_first[ZFW_RING];  /* each slot's first frame, -1 when empty */
  int ring_frames[ZFW_RING];
  int ring_next, ring_cap_frames;
  ZfToken *scratch;
  int scratch_cap;
  char hex[17];
  /* evidence */
  int ev_flags;
  ZfwEvidence *ev;                 /* the queued chunks */
  int ev_n, ev_cap;
  float *ev_data;                  /* their arrays, one after another */
  size_t ev_len, ev_data_cap;
  int ev_failed;                   /* chunks that could not be queued (out of memory) since the reset */
  uint64_t ev_fnv, chunk_fnv;      /* every chunk's evidence; the last chunk's log-probs alone */
  long long ev_next;               /* the chunk index the next evidence must carry */
  int ev_bad;                      /* chunks whose evidence broke a rule */
  int audio;                       /* audio was pushed since the reset, so every chunk has samples */
  char ev_hex[17];
  char json[640];
} Zfw;

static uint64_t fnv1a(uint64_t h, const void *data, size_t n) {
  const unsigned char *p = (const unsigned char *)data;
  for (size_t i = 0; i < n; ++i) h = (h ^ p[i]) * 1099511628211ull;
  return h;
}

static void on_chunk(void *user, const float *lp, int frames, int vocab) {
  Zfw *h = (Zfw *)user;
  h->fnv = fnv1a(h->fnv, lp, (size_t)frames * vocab * sizeof(float));
  if (h->ev_flags & ZFW_EV_FINGERPRINT)
    h->chunk_fnv = fnv1a(FNV_START, lp, (size_t)frames * vocab * sizeof(float));
  if (!h->ring || h->vocab != vocab || frames > h->ring_cap_frames) {
    free(h->ring);
    h->ring_cap_frames = frames > 64 ? frames : 64;
    h->ring = (float *)malloc((size_t)ZFW_RING * h->ring_cap_frames * vocab * sizeof(float));
    h->vocab = vocab;
    for (int i = 0; i < ZFW_RING; ++i) h->ring_first[i] = -1;
  }
  if (h->ring) {
    const int slot = h->ring_next;
    memcpy(h->ring + (size_t)slot * h->ring_cap_frames * vocab, lp, (size_t)frames * vocab * sizeof(float));
    h->ring_first[slot] = h->frames_done;
    h->ring_frames[slot] = frames;
    h->ring_next = (slot + 1) % ZFW_RING;
  }
  h->frames_done += frames;
}

/* zf_stream_check --evidence's fingerprint and rule checks, byte for byte the same */
static void fingerprint(Zfw *h, const ZfEvidence *e) {
  const size_t lp = (size_t)e->frames * e->vocab;
  int bad = fnv1a(FNV_START, e->log_probs, lp * sizeof(float)) != h->chunk_fnv;
  bad |= e->chunk != h->ev_next++;
  bad |= e->stack0 && e->stack0_frames != 2 * e->frames;
  bad |= h->audio && (!e->samples || e->n_samples != zf_stream_advance(h->s) * 160 || !e->capture.has_samples);
  bad |= e->struct_size != sizeof(ZfEvidence);
  h->ev_bad += bad;
  uint64_t x = h->ev_fnv;
  x = fnv1a(x, e->log_probs, lp * sizeof(float));
  if (e->logit_lse) x = fnv1a(x, e->logit_lse, (size_t)e->frames * sizeof(float));
  if (e->enc) x = fnv1a(x, e->enc, (size_t)e->frames * e->enc_dim * sizeof(float));
  if (e->stack0) x = fnv1a(x, e->stack0, (size_t)e->stack0_frames * e->stack0_dim * sizeof(float));
  if (e->stack1) x = fnv1a(x, e->stack1, (size_t)e->frames * e->stack1_dim * sizeof(float));
  if (e->samples) x = fnv1a(x, e->samples, (size_t)e->n_samples * sizeof(float));
  h->ev_fnv = fnv1a(x, &e->capture, sizeof e->capture);
}

/* `n` floats of `src` appended to the queue's data (room already made); returns their offset, or -1
 * when there are none */
static int put(Zfw *h, const float *src, size_t n) {
  if (!src) return -1;
  memcpy(h->ev_data + h->ev_len, src, n * sizeof(float));
  const int at = (int)h->ev_len;
  h->ev_len += n;
  return at;
}

static void queue_evidence(Zfw *h, const ZfEvidence *e) {
  const size_t n_lp = (size_t)e->frames * e->vocab;
  const size_t n_lse = e->logit_lse ? (size_t)e->frames : 0;
  const size_t n_enc = e->enc ? (size_t)e->frames * e->enc_dim : 0;
  const size_t n_s0 = e->stack0 ? (size_t)e->stack0_frames * e->stack0_dim : 0;
  const size_t n_s1 = e->stack1 ? (size_t)e->frames * e->stack1_dim : 0;
  const size_t n_pcm = e->samples ? (size_t)e->n_samples : 0;
  const size_t need = h->ev_len + n_lp + n_lse + n_enc + n_s0 + n_s1 + n_pcm;
  if (need > 0x7fffffff) {
    ++h->ev_failed;
    return;
  }
  if (need > h->ev_data_cap) {
    size_t cap = h->ev_data_cap ? h->ev_data_cap * 2 : need * 4;
    while (cap < need) cap *= 2;
    float *p = (float *)realloc(h->ev_data, cap * sizeof(float));
    if (!p) {
      ++h->ev_failed;
      return;
    }
    h->ev_data = p;
    h->ev_data_cap = cap;
  }
  if (h->ev_n == h->ev_cap) {
    const int cap = h->ev_cap ? h->ev_cap * 2 : 8;
    ZfwEvidence *p = (ZfwEvidence *)realloc(h->ev, (size_t)cap * sizeof(ZfwEvidence));
    if (!p) {
      ++h->ev_failed;
      return;
    }
    h->ev = p;
    h->ev_cap = cap;
  }
  ZfwEvidence *r = &h->ev[h->ev_n++];
  r->chunk = (int)e->chunk;
  r->frames = e->frames;
  r->vocab = e->vocab;
  r->enc_dim = e->enc ? e->enc_dim : 0;
  r->stack0_frames = e->stack0 ? e->stack0_frames : 0;
  r->stack0_dim = e->stack0 ? e->stack0_dim : 0;
  r->stack1_dim = e->stack1 ? e->stack1_dim : 0;
  r->n_samples = e->samples ? e->n_samples : 0;
  r->log_probs = put(h, e->log_probs, n_lp);
  r->logit_lse = put(h, e->logit_lse, n_lse);
  r->enc = put(h, e->enc, n_enc);
  r->stack0 = put(h, e->stack0, n_s0);
  r->stack1 = put(h, e->stack1, n_s1);
  r->samples = put(h, e->samples, n_pcm);
  r->has_samples = e->capture.has_samples;
  r->rms = e->capture.rms;
  r->peak = e->capture.peak;
  r->dc = e->capture.dc;
  r->clipped = e->capture.clipped;
  r->zero_runs = e->capture.zero_runs;
  r->zero_samples = e->capture.zero_samples;
  r->noise_floor = e->capture.noise_floor;
  r->bandwidth_hz = e->capture.bandwidth_hz;
}

/* Called after on_chunk with the same chunk; every pointer in `e` is valid only during the call. */
static void on_evidence(void *user, const ZfEvidence *e) {
  Zfw *h = (Zfw *)user;
  if (h->ev_flags & ZFW_EV_FINGERPRINT) fingerprint(h, e);
  if (h->ev_flags & ZFW_EV_QUEUE) queue_evidence(h, e);
}

static void forget(Zfw *h) {
  h->fnv = 1469598103934665603ull;
  h->frames_done = 0;
  h->ring_next = 0;
  for (int i = 0; i < ZFW_RING; ++i) h->ring_first[i] = -1;
  h->ev_n = 0;
  h->ev_len = 0;
  h->ev_failed = 0;
  h->ev_fnv = FNV_START;
  h->ev_next = 0;
  h->ev_bad = 0;
  h->audio = 0;
}

/* The runner-up's posterior at `frame`, bit for bit as the decoder took it, or prob - margin when
 * that chunk has left the ring (only possible if tokens were left queued for 32 chunks). */
static float runner_up_prob(const Zfw *h, const ZfToken *t) {
  if (t->runner_up < 0) return 0.0f;
  for (int i = 0; i < ZFW_RING; ++i) {
    const long long f0 = h->ring_first[i];
    if (f0 >= 0 && t->frame >= f0 && t->frame < f0 + h->ring_frames[i]) {
      const float *row = h->ring + ((size_t)i * h->ring_cap_frames + (size_t)(t->frame - f0)) * h->vocab;
      return zf_libm_expf(row[t->runner_up]);
    }
  }
  return t->prob - t->margin;
}

static int convert(Zfw *h, int n, ZfwToken *out) {
  for (int i = 0; i < n; ++i) {
    const ZfToken *t = &h->scratch[i];
    ZfwToken *o = &out[i];
    o->token = t->token;
    o->frame = t->frame;
    o->prob = t->prob;
    o->margin = t->margin;
    o->blank = t->blank;
    o->run = t->run;
    o->token2 = t->runner_up;
    o->prob2 = runner_up_prob(h, t);
    o->peak_prob = t->peak_prob;
    o->peak_margin = t->peak_margin;
    o->end_frame = t->end_frame;
    o->complete = t->complete;
  }
  return n;
}

static ZfToken *scratch(Zfw *h, int n) {
  if (n <= h->scratch_cap) return h->scratch;
  ZfToken *p = (ZfToken *)realloc(h->scratch, (size_t)n * sizeof(ZfToken));
  if (!p) return NULL;
  h->scratch = p;
  h->scratch_cap = n;
  return p;
}

#define ZFW_CALL(expr, max_out)                        \
  do {                                                 \
    if ((max_out) < 0) return -1;                      \
    if (!scratch(h, (max_out) > 0 ? (max_out) : 1)) return -1; \
    const int got_ = (expr);                           \
    return got_ < 0 ? got_ : convert(h, got_, out);    \
  } while (0)

/* A model file, in memory, under the path the engine would open (zf/vfs.h): the engine takes its
 * own copy when a stream is created, so the caller can drop it afterwards. `data` must come from
 * malloc; the table owns it from here on. Files in the module's MEMFS work too. */
EMSCRIPTEN_KEEPALIVE int zfw_file_put(const char *path, unsigned char *data, int size) {
  return zf_vfs_put(path, data, (size_t)size);
}
EMSCRIPTEN_KEEPALIVE void zfw_files_drop(const char *prefix) { zf_vfs_remove_prefix(prefix); }

static const char *g_error = "";
EMSCRIPTEN_KEEPALIVE const char *zfw_error(void) { return g_error; }

/* threads: 0 lets the engine pick. prefetch_lead: front-end lead in frames (1 is best).
 * complete_runs: hold each phoneme until its run ends. sample_rate: what zfw_push_audio takes, 0 or
 * 16000 for 16 kHz, or 8000/11025/22050/24000/32000/44100/48000 through the engine's resampler.
 * chunk_ms: the step, 160, 320 or 480 ms (0 is the model's own), from MODEL.c<ms>.onnx's .zfg and
 * .zfg.bin beside the model and the .zfw overlay they name; anything else fails, as does a length
 * the model has no graph for. evidence: 0, or ZFW_EV_QUEUE and/or ZFW_EV_FINGERPRINT. */
EMSCRIPTEN_KEEPALIVE
Zfw *zfw_create2(const char *model_path, int threads, int prefetch_lead, int complete_runs,
                 int sample_rate, int chunk_ms, int evidence) {
  Zfw *h = (Zfw *)calloc(1, sizeof *h);
  if (!h) {
    g_error = "out of memory";
    return NULL;
  }
  ZfStreamOptions o = zf_stream_default_options();
  o.threads = threads;
  o.prefetch_lead = prefetch_lead;
  o.complete_runs = complete_runs;
  o.sample_rate = sample_rate;
  o.chunk_ms = chunk_ms;
  o.on_chunk = on_chunk;
  h->ev_flags = evidence & (ZFW_EV_QUEUE | ZFW_EV_FINGERPRINT);
  if (h->ev_flags) o.on_evidence = on_evidence;
  o.user = h;
  const char *error = NULL;
  h->s = zf_stream_create(model_path, &o, &error);
  if (!h->s) {
    g_error = error ? error : "cannot create the stream";
    free(h);
    return NULL;
  }
  forget(h);
  return h;
}

/* zfw_create2 at the model's own chunk length, without evidence. */
EMSCRIPTEN_KEEPALIVE
Zfw *zfw_create(const char *model_path, int threads, int prefetch_lead, int complete_runs,
                int sample_rate) {
  return zfw_create2(model_path, threads, prefetch_lead, complete_runs, sample_rate, 0, 0);
}

EMSCRIPTEN_KEEPALIVE void zfw_destroy(Zfw *h) {
  if (!h) return;
  zf_stream_destroy(h->s);
  free(h->ring);
  free(h->scratch);
  free(h->ev);
  free(h->ev_data);
  free(h);
}
EMSCRIPTEN_KEEPALIVE void zfw_reset(Zfw *h) {
  zf_stream_reset(h->s);
  forget(h);
}
EMSCRIPTEN_KEEPALIVE int zfw_window(Zfw *h) { return zf_stream_window(h->s); }
EMSCRIPTEN_KEEPALIVE int zfw_advance(Zfw *h) { return zf_stream_advance(h->s); }
EMSCRIPTEN_KEEPALIVE double zfw_chunks(Zfw *h) { return (double)zf_stream_chunks(h->s); }
EMSCRIPTEN_KEEPALIVE int zfw_token_bytes(void) { return (int)sizeof(ZfwToken); }

/* Audio at the stream's sample rate, float in [-1, 1]; phonemes appended to `out`, at most
 * `max_out` (the rest stay queued for zfw_read). Returns the count written, or -1. */
EMSCRIPTEN_KEEPALIVE
int zfw_push_audio(Zfw *h, const float *samples, int n, ZfwToken *out, int max_out) {
  h->audio = 1;
  ZFW_CALL(zf_stream_push_audio(h->s, samples, n, h->scratch, max_out), max_out);
}

/* Pre-computed 80-bin fbank frames, for a caller that runs its own front end. */
EMSCRIPTEN_KEEPALIVE
int zfw_push_frames(Zfw *h, const float *frames, int n, ZfwToken *out, int max_out) {
  ZFW_CALL(zf_stream_push(h->s, frames, n, h->scratch, max_out), max_out);
}

/* End of an utterance pushed as audio: the reference flush, then every chunk it completes. */
EMSCRIPTEN_KEEPALIVE int zfw_finish_audio(Zfw *h, ZfwToken *out, int max_out) {
  h->audio = 1;
  ZFW_CALL(zf_stream_finish_audio(h->s, h->scratch, max_out), max_out);
}

/* End of an utterance pushed as frames: hands over a phoneme still held for its run. */
EMSCRIPTEN_KEEPALIVE int zfw_finish_frames(Zfw *h, ZfwToken *out, int max_out) {
  ZFW_CALL(zf_stream_finish(h->s, h->scratch, max_out), max_out);
}

/* Phonemes still queued (a push with too little room), oldest first. */
EMSCRIPTEN_KEEPALIVE int zfw_read(Zfw *h, ZfwToken *out, int max_out) {
  ZFW_CALL(zf_stream_read(h->s, h->scratch, max_out), max_out);
}
EMSCRIPTEN_KEEPALIVE int zfw_pending(Zfw *h) { return zf_stream_pending(h->s); }

/* The last chunk's log-probs, [frames, vocab] row-major; valid until the next push. */
EMSCRIPTEN_KEEPALIVE
const float *zfw_last_log_probs(Zfw *h, int *frames, int *vocab) {
  return zf_stream_last_log_probs(h->s, frames, vocab);
}

/* The FNV-1a of every chunk's log-probs since the last reset, as 16 hex digits (the SDK's
 * zf_stream_check prints the same). */
EMSCRIPTEN_KEEPALIVE const char *zfw_logp_fnv(Zfw *h) {
  snprintf(h->hex, sizeof h->hex, "%016llx", (unsigned long long)h->fnv);
  return h->hex;
}
EMSCRIPTEN_KEEPALIVE double zfw_logp_fnv_lo(Zfw *h) { return (double)(uint32_t)h->fnv; }
EMSCRIPTEN_KEEPALIVE double zfw_logp_fnv_hi(Zfw *h) { return (double)(uint32_t)(h->fnv >> 32); }

/* What the stream runs, as JSON: the vocabulary and blank, the chunk geometry, the step in ms, the
 * backend (ZfBackend: 1 is the exact CPU engine), the graph's metadata and the weights' SHA-256. The
 * phoneme engine binds its model pack to weightsSha256, backend and chunkMs. "" on failure. */
EMSCRIPTEN_KEEPALIVE const char *zfw_model_info(Zfw *h) {
  ZfModelInfo i;
  if (zf_stream_model_info_sized(h->s, &i, sizeof i) != 0) return "";
  snprintf(h->json, sizeof h->json,
           "{\"vocab\":%d,\"blank\":%d,\"window\":%d,\"advance\":%d,\"layers\":%d,"
           "\"leftContext\":%d,\"sampleRate\":%d,\"modelType\":\"%s\",\"version\":\"%s\","
           "\"weightsSha256\":\"%s\",\"backend\":%d,\"chunkMs\":%d}",
           i.vocab, i.blank, i.window, i.advance, i.layers, i.left_context, i.sample_rate,
           i.model_type, i.version, i.weights_sha256, i.backend, i.chunk_ms);
  return h->json;
}

/* The evidence queued since the last zfw_evidence_clear (ZFW_EV_QUEUE), oldest first: `count`
 * records of zfw_evidence_record_bytes() each, and the floats their offsets point into. Both pointers
 * are valid until the next push, finish, clear or reset. */
EMSCRIPTEN_KEEPALIVE int zfw_evidence_count(Zfw *h) { return h->ev_n; }
EMSCRIPTEN_KEEPALIVE const ZfwEvidence *zfw_evidence_records(Zfw *h) { return h->ev; }
EMSCRIPTEN_KEEPALIVE const float *zfw_evidence_data(Zfw *h) { return h->ev_data; }
EMSCRIPTEN_KEEPALIVE int zfw_evidence_record_bytes(void) { return (int)sizeof(ZfwEvidence); }
/* Chunks whose evidence could not be queued (out of memory) since the last reset: 0 unless lost. */
EMSCRIPTEN_KEEPALIVE int zfw_evidence_failed(Zfw *h) { return h->ev_failed; }
/* Drop the queued evidence; the memory is kept for the next chunks. */
EMSCRIPTEN_KEEPALIVE void zfw_evidence_clear(Zfw *h) {
  h->ev_n = 0;
  h->ev_len = 0;
}

/* ZFW_EV_FINGERPRINT: the FNV-1a of every chunk's evidence since the last reset, as 16 hex digits,
 * and the chunks whose evidence broke a rule, as zf_stream_check --evidence prints them (ev_fnv,
 * ev_bad). */
EMSCRIPTEN_KEEPALIVE const char *zfw_evidence_fnv(Zfw *h) {
  snprintf(h->ev_hex, sizeof h->ev_hex, "%016llx", (unsigned long long)h->ev_fnv);
  return h->ev_hex;
}
EMSCRIPTEN_KEEPALIVE int zfw_evidence_bad(Zfw *h) { return h->ev_bad; }
