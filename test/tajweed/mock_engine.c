/* A mock of the engine's zf_tajweed.h (API 4, inference only) for the binding test
 * (test/engine_binding.test.mjs): built freestanding for wasm32 with clang together with src/zft_api.c, so
 * the JS glue (web/tajweed/engine.js) runs against the real shim, the real header and wasm32's struct layout.
 * NOT the engine: heads are a deterministic pattern, and the reference table knows one ayah.
 *
 *   value of head k (ZfTajweedHeads order), take row r, column c = k * 100000 + r * 100 + c
 */
#include <stddef.h>

#include "zf_tajweed.h"

#define EXPORT __attribute__((visibility("default"), used))

/* ---- memory: a bump arena (free is a no-op), exported as malloc/free for the JS side ---- */
static unsigned char arena[24 << 20];
static size_t arena_top;
EXPORT void *malloc(size_t n) {
  size_t at = (arena_top + 15) & ~(size_t)15;
  if (at + n > sizeof arena) return NULL;
  arena_top = at + n;
  return arena + at;
}
EXPORT void free(void *p) { (void)p; }
void *memcpy(void *d, const void *s, size_t n) {
  unsigned char *o = (unsigned char *)d;
  const unsigned char *i = (const unsigned char *)s;
  while (n--) *o++ = *i++;
  return d;
}
void *memset(void *d, int v, size_t n) {
  unsigned char *o = (unsigned char *)d;
  while (n--) *o++ = (unsigned char)v;
  return d;
}

static int streq(const char *a, const char *b) {
  if (!a || !b) return 0;
  while (*a && *a == *b) ++a, ++b;
  return *a == *b;
}
static int starts(const char *a, const char *p) {
  if (!a) return 0;
  while (*p)
    if (*a++ != *p++) return 0;
  return 1;
}
static void copy(char *dst, const char *src, int cap) {
  int i = 0;
  for (; src && src[i] && i < cap - 1; ++i) dst[i] = src[i];
  dst[i] = 0;
}

const char *zf_tajweed_version(void) { return "0.0.0-mock"; }
int zf_tajweed_api_version(void) { return ZF_TAJWEED_API_VERSION; }

ZfTajweedOpenOptions zf_tajweed_open_default_options(void) {
  ZfTajweedOpenOptions o = {sizeof(ZfTajweedOpenOptions), NULL, 1, 0, 0, 1, 0};
  return o;
}

struct ZfTajweedModel {
  char context[16];
  int chunk_ms, engine, sample_rate;
};
static struct ZfTajweedModel g_model;

ZfTajweedModel *zf_tajweed_model_open(const char *dir, const ZfTajweedOpenOptions *o, const char **error) {
  if (!dir || !starts(dir, "/tajweedformer/")) {
    if (error) *error = "mock: the folder was not staged under /tajweedformer/";
    return NULL;
  }
  /* API 4: the context is required when the engine is loaded */
  const char *ctx = o ? o->context : NULL;
  if (!ctx) {
    if (error) *error = "mock: options.context is required";
    return NULL;
  }
  if (!streq(ctx, "c16_l64") && !streq(ctx, "c24_l72")) {
    if (error) *error = "mock: no such context";
    return NULL;
  }
  copy(g_model.context, ctx, 16);
  g_model.chunk_ms = starts(ctx, "c24") ? 480 : 320;
  g_model.engine = o ? o->load_engine : 1;
  g_model.sample_rate = o ? o->sample_rate : 0;
  return &g_model;
}
void zf_tajweed_model_close(ZfTajweedModel *m) { (void)m; }
const char *zf_tajweed_model_context(const ZfTajweedModel *m) { return m ? m->context : NULL; }
int zf_tajweed_model_chunk_ms(const ZfTajweedModel *m) { return m && m->engine ? m->chunk_ms : 0; }
const char *zf_tajweed_token_name(const ZfTajweedModel *m, int id) { return m && id == 0 ? "<blk>" : NULL; }
const void *zf_tajweed_model_calibration(const ZfTajweedModel *m, size_t *size) {
  (void)m;
  if (size) *size = 0;
  return NULL;
}

/* ---- the reference table: bytes that start with "MOCKREF"; surah 1 has 7 ayahs and 1:1 has five units ---- */
struct ZfTajweedReference {
  int open;
};
static struct ZfTajweedReference g_ref;
static const int kRefUnits[] = {5, 31, 1, 6, 34};
static const int kRefWords[] = {0, 0, 0, 1, 1};
static const unsigned char kRefSha[32] = {0xab, 0xcd};
ZfTajweedReference *zf_tajweed_reference_open_memory(const void *bytes, size_t size, const char **error) {
  if (!bytes || size < 7 || !starts((const char *)bytes, "MOCKREF")) {
    if (error) *error = "mock: not a reference table";
    return NULL;
  }
  g_ref.open = 1;
  return &g_ref;
}
ZfTajweedReference *zf_tajweed_reference_open(const char *path, const char **error) {
  (void)path;
  if (error) *error = "mock: no files";
  return NULL;
}
void zf_tajweed_reference_close(ZfTajweedReference *r) {
  if (r) r->open = 0;
}
int zf_tajweed_reference_ayah_count(const ZfTajweedReference *r, int surah) { return r && r->open && surah == 1 ? 7 : 0; }
int zf_tajweed_reference_units(const ZfTajweedReference *r, int surah, int ayah, const int **units, const int **word_of_unit,
                               int *n_words) {
  if (!r || !r->open || surah != 1 || ayah != 1) return -1;
  if (units) *units = kRefUnits;
  if (word_of_unit) *word_of_unit = kRefWords;
  if (n_words) *n_words = 2;
  return 5;
}
const unsigned char *zf_tajweed_reference_tokens_sha256(const ZfTajweedReference *r) { return r ? kRefSha : NULL; }

/* ---- the stream ---- */
#define MAX40 1024
static const int kCols[] = {38, 38, 38, 38, 38, 2, 3, 5, 3, 4, 1, 1};
static const int kFine[] = {0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1};
static float g_buf[12][2 * MAX40 * 38];
struct ZfTajweedStream {
  ZfTajweedModel *m;
  long long pending;
  int rows40, chunks;
};
static struct ZfTajweedStream g_stream;

ZfTajweedStream *zf_tajweed_stream_create(ZfTajweedModel *m, const char **error) {
  if (!m || !m->engine) {
    if (error) *error = "mock: no engine";
    return NULL;
  }
  g_stream.m = m;
  g_stream.pending = 0;
  g_stream.rows40 = g_stream.chunks = 0;
  return &g_stream;
}
void zf_tajweed_stream_destroy(ZfTajweedStream *s) { (void)s; }
void zf_tajweed_stream_set_callback(ZfTajweedStream *s, ZfTajweedChunkCallback cb, void *u) { (void)s, (void)cb, (void)u; }
void zf_tajweed_stream_reset(ZfTajweedStream *s) { s->pending = 0, s->rows40 = s->chunks = 0; }

static int run(ZfTajweedStream *s) {
  const int per40 = s->m->chunk_ms / 40;
  const long long cs = (long long)s->m->chunk_ms * 16;
  int n = 0;
  while (s->pending >= cs && s->rows40 + per40 <= MAX40) {
    for (int k = 0; k < 12; ++k) {
      const int rows = kFine[k] ? 2 * per40 : per40, at = kFine[k] ? 2 * s->rows40 : s->rows40;
      for (int r = 0; r < rows; ++r)
        for (int c = 0; c < kCols[k]; ++c)
          g_buf[k][(at + r) * kCols[k] + c] = (float)(k * 100000 + (at + r) * 100 + c);
    }
    s->rows40 += per40;
    s->pending -= cs;
    ++s->chunks;
    ++n;
  }
  return n;
}
int zf_tajweed_stream_push_audio(ZfTajweedStream *s, const float *samples, int n) {
  if (!s || n < 0 || (n && !samples)) return -1;
  if (n && samples[0] != samples[0]) return -1; /* a NaN first sample: the mock's error path */
  s->pending += n;
  return run(s);
}
int zf_tajweed_stream_finish(ZfTajweedStream *s) {
  s->pending += 16800;
  const int n = run(s);
  s->pending = 0;
  return n;
}
int zf_tajweed_stream_heads(const ZfTajweedStream *s, ZfTajweedHeads *h) {
  if (!s || !h) return -1;
  h->n40 = s->rows40;
  h->n20 = 2 * s->rows40;
  h->vocab = 38;
  const float **slot[12] = {&h->log_probs, &h->inter1_log_probs, &h->inter4_log_probs, &h->id_log_probs,
                            &h->timing_log_probs, &h->gem, &h->attr_tafkheem, &h->attr_ghunna,
                            &h->attr_qalqalah, &h->attr_face, &h->boundary, &h->conf};
  for (int k = 0; k < 12; ++k) *slot[k] = k == 2 ? NULL : g_buf[k]; /* inter4 missing: a head a source lacks */
  return s->rows40;
}
static const int kGreedy[] = {5, 31};
int zf_tajweed_stream_greedy(const ZfTajweedStream *s, int *ids, int max) {
  const int n = s && s->chunks ? 2 : 0;
  for (int i = 0; ids && i < n && i < max; ++i) ids[i] = kGreedy[i];
  return n;
}
const char *zf_tajweed_stream_last_error(const ZfTajweedStream *s) { return s ? "mock: bad audio" : NULL; }

/* head selection is recorded (every head is still produced), top-2 by a plain scan */
static unsigned g_mock_heads = ZF_TAJWEED_HEADS_DEFAULT;
int zf_tajweed_stream_set_heads(ZfTajweedStream *s, unsigned heads) { if (!s) return -1; g_mock_heads = heads | 1u; return 0; }
unsigned zf_tajweed_stream_get_heads(const ZfTajweedStream *s) { return s ? g_mock_heads : 0; }
int zf_tajweed_top2(const float *lp, int frames, int vocab, ZfTajweedTop2 *out) {
  if (!lp || !out || vocab < 2 || frames < 0) return -1;
  for (int t = 0; t < frames; ++t) {
    const float *r = lp + t * vocab;
    int a = 0;
    for (int i = 1; i < vocab; ++i) if (r[i] > r[a]) a = i;
    int b = a == 0 ? 1 : 0;
    for (int i = 0; i < vocab; ++i) if (i != a && r[i] > r[b]) b = i;
    out[t].token = a; out[t].runner_up = b; out[t].log_prob = r[a]; out[t].runner_up_log_prob = r[b];
    out[t].margin = r[a] - r[b];
  }
  return frames;
}
int zf_tajweed_stream_top2(const ZfTajweedStream *s, const ZfTajweedTop2 **out) { (void)s; *out = 0; return 0; }
const char *zf_tajweed_head_info(unsigned head, int *frame_ms, int *cols) { (void)head; (void)frame_ms; (void)cols; return 0; }

/* top-K is not in the mock */
int zf_tajweed_topk(const float *v, int frames, int cols, int k, int *ids, float *vo, float *mg) {
  (void)v; (void)frames; (void)cols; (void)k; (void)ids; (void)vo; (void)mg; return -1;
}
int zf_tajweed_stream_topk(const ZfTajweedStream *s, unsigned head, int k, int *ids, float *vo, float *mg, int max) {
  (void)s; (void)head; (void)k; (void)ids; (void)vo; (void)mg; (void)max; return -1;
}
