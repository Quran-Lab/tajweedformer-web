/* A mock of the engine's zf_tajweed.h for the binding test (test/tajweed_engine.test.mjs): built
 * freestanding for wasm32 with clang together with src/zft_api.c, so the JS glue
 * (web/tajweed/engine.js) runs against the real shim, the real header and wasm32's struct layout.
 * NOT the engine: heads are a deterministic pattern, the config knows only the calibration fixture's
 * c16_l64 thresholds and statuses (and ignores the remote block), and scoring makes two sites, one
 * madd and one qalqalah item from fixed positions of the heads it is given.
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

static const char *kClass[] = {"vowel_sub", "vowel_del", "vowel_ins", "short_to_long", "long_to_short",
                               "cons_sub", "cons_del", "insertion"};
static const char *kCheck[] = {"letters", "vowels", "length", "madd", "gemination", "qalqalah", "lazim"};
static const char *kPreset[] = {"strict", "balanced", "sensitive", "very_sensitive"};
/* the calibration fixture's c16_l64: statuses, and thresholds 0.25 * class + 1.5 - 0.5 * preset */
static const int kClassStatus[] = {2, 2, 1, 2, 2, 2, 1, 0};
static const int kClassCheck[] = {1, 1, 1, 2, 2, 0, 0, 0};
static const int kCheckStatus[] = {2, 2, 2, 2, 2, 1, 0};
static int find(const char *const *names, int n, const char *s) {
  for (int i = 0; i < n; ++i)
    if (streq(names[i], s)) return i;
  return -1;
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
  const char *ctx = o && o->context ? o->context : "c16_l64";
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
const char *zf_tajweed_model_id(const ZfTajweedModel *m) { return m ? "v4.0" : NULL; }
const char *zf_tajweed_model_context(const ZfTajweedModel *m) { return m ? m->context : NULL; }
int zf_tajweed_model_chunk_ms(const ZfTajweedModel *m) { return m && m->engine ? m->chunk_ms : 0; }
int zf_tajweed_ayah_count(const ZfTajweedModel *m, int surah) { return m && surah == 1 ? 7 : 0; }

static const int kExpTokens[] = {5, 31, 1, 6, 34};
static const int kExpWords[] = {0, 0, 0, 1, 1};
int zf_tajweed_expected_tokens(const ZfTajweedModel *m, int surah, int ayah, const int **tokens) {
  if (!m || surah != 1 || ayah != 1) return -1;
  *tokens = kExpTokens;
  return 5;
}
int zf_tajweed_expected_words(const ZfTajweedModel *m, int surah, int ayah, const int **w, int *n_words) {
  if (!m || surah != 1 || ayah != 1) return -1;
  *w = kExpWords;
  *n_words = 2;
  return 5;
}

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

/* ---- the config ---- */
struct ZfTajweedConfig {
  int preset, preset_app;
  int cls_mode[8]; /* 0 none, 1 preset, 2 threshold */
  int cls_preset[8];
  double cls_thr[8];
  int check[7]; /* -1 none */
  int debug;
  char context[16];
};
static struct ZfTajweedConfig g_cfg;

ZfTajweedConfig *zf_tajweed_config_create(const ZfTajweedModel *m) {
  if (!m) return NULL;
  zf_tajweed_config_clear_app(&g_cfg);
  g_cfg.debug = 0;
  return &g_cfg;
}
void zf_tajweed_config_destroy(ZfTajweedConfig *c) { (void)c; }
int zf_tajweed_config_set_remote(ZfTajweedConfig *c, const char *json, size_t len) {
  (void)c;
  if (!json) return 0;
  return len && json[0] == '{' ? 0 : -1; /* the mock ignores the remote layer */
}
int zf_tajweed_config_set_preset(ZfTajweedConfig *c, const char *p) {
  if (!p) return c->preset_app = 0, 0;
  const int i = find(kPreset, 4, p);
  if (i < 0) return -1;
  c->preset = i, c->preset_app = 1;
  return 0;
}
int zf_tajweed_config_set_class_preset(ZfTajweedConfig *c, const char *cls, const char *p) {
  const int k = find(kClass, 8, cls), i = find(kPreset, 4, p);
  if (k < 0 || i < 0) return -1;
  c->cls_mode[k] = 1, c->cls_preset[k] = i;
  return 0;
}
int zf_tajweed_config_set_class_threshold(ZfTajweedConfig *c, const char *cls, double t) {
  const int k = find(kClass, 8, cls);
  if (k < 0 || !(t >= -20 && t <= 20)) return -1;
  c->cls_mode[k] = 2, c->cls_thr[k] = t;
  return 0;
}
int zf_tajweed_config_clear_class(ZfTajweedConfig *c, const char *cls) {
  const int k = find(kClass, 8, cls);
  if (k < 0) return -1;
  c->cls_mode[k] = 0;
  return 0;
}
int zf_tajweed_config_set_check(ZfTajweedConfig *c, const char *check, int on) {
  const int k = find(kCheck, 7, check);
  if (k < 0 || on < -1 || on > 1) return -1;
  c->check[k] = on;
  return 0;
}
int zf_tajweed_config_set_context(ZfTajweedConfig *c, const char *ctx) {
  if (ctx && !streq(ctx, "c16_l64") && !streq(ctx, "c24_l72")) return -1;
  copy(c->context, ctx ? ctx : "", 16);
  return 0;
}
void zf_tajweed_config_clear_app(ZfTajweedConfig *c) {
  c->preset = 1, c->preset_app = 0;
  for (int k = 0; k < 8; ++k) c->cls_mode[k] = 0;
  for (int k = 0; k < 7; ++k) c->check[k] = -1;
  c->context[0] = 0;
}
void zf_tajweed_config_set_debug_build(ZfTajweedConfig *c, int d) { c->debug = d; }
int zf_tajweed_config_set_backend(ZfTajweedConfig *c, const char *b) {
  (void)c;
  return !b || streq(b, "int8") || streq(b, "fp32") ? 0 : -1;
}

static int on(const ZfTajweedConfig *c, int check, int status) {
  const int f = c->check[check];
  if (f < 0) return status == 2;
  if (!f) return 0;
  return status != 0 || c->debug;
}
int zf_tajweed_config_effective(const ZfTajweedConfig *c, ZfTajweedEffective *e) {
  if (!c || !e) return -1;
  e->preset = c->preset;
  e->preset_source = c->preset_app ? 2 : 0;
  for (int k = 0; k < 8; ++k) {
    const int p = c->cls_mode[k] == 1 ? c->cls_preset[k] : c->preset;
    e->class_threshold[k] = c->cls_mode[k] == 2 ? c->cls_thr[k] : 0.25 * k + 1.5 - 0.5 * p;
    e->class_status[k] = kClassStatus[k];
    e->class_enabled[k] = on(c, kClassCheck[k], kClassStatus[k]);
    e->class_source[k] = c->cls_mode[k] || c->preset_app ? 2 : 0;
  }
  for (int k = 0; k < 7; ++k) {
    e->check_status[k] = kCheckStatus[k];
    e->check_enabled[k] = on(c, k, kCheckStatus[k]);
    e->check_source[k] = c->check[k] >= 0 ? 2 : 0;
  }
  e->check_enabled[6] = e->check_enabled[6] && e->check_enabled[3];
  copy(e->context, c->context[0] ? c->context : g_model.context, 16);
  e->context_source = c->context[0] ? 2 : 0;
  return 0;
}
const char *zf_tajweed_config_json(ZfTajweedConfig *c) { return c ? "{\"mock\":true}" : NULL; }

/* ---- scoring ---- */
struct ZfTajweedResult {
  ZfTajweedSite sites[2];
  ZfTajweedMadd madd[1];
  ZfTajweedLetter qlq[1];
  ZfTajweedSummary summary;
};
static struct ZfTajweedResult g_result;

ZfTajweedResult *zf_tajweed_score(const ZfTajweedModel *m, const ZfTajweedConfig *c, const ZfTajweedHeads *h,
                                  int surah, int ayah, const char **error) {
  if (!m || !c || !h || !h->log_probs || !h->inter1_log_probs || h->n40 < 1) {
    if (error) *error = "mock: log_probs and inter1_log_probs are needed";
    return NULL;
  }
  if (surah != 1 || ayah != 1) {
    if (error) *error = "mock: no such ayah";
    return NULL;
  }
  ZfTajweedEffective e;
  zf_tajweed_config_effective(c, &e);
  struct ZfTajweedResult *r = &g_result;
  const int last = h->n40 * 38 - 1;
  /* site 0 reads the first values of the heads, site 1 the last: the whole arrays were copied */
  const double a[2] = {h->log_probs[0], h->log_probs[last]}, b[2] = {h->inter1_log_probs[1], h->inter1_log_probs[last]};
  const int cls[2] = {ZF_TJ_VOWEL_SUB, ZF_TJ_CONS_DEL};
  for (int i = 0; i < 2; ++i) {
    ZfTajweedSite *s = &r->sites[i];
    const double w = cls[i] == ZF_TJ_CONS_DEL ? 0.5 : 0.8;
    s->cls = cls[i];
    s->status = e.class_status[cls[i]];
    s->pos = i ? 3 : 1;
    s->word = i;
    s->expected = i ? 6 : 31;
    s->alt = i ? -1 : 32;
    s->llr_final = a[i] / 100000.0;
    s->llr_inter1 = b[i] / 100000.0;
    s->llr = w * s->llr_final + (1 - w) * s->llr_inter1;
    s->threshold = e.class_threshold[cls[i]];
    s->flagged = e.class_enabled[cls[i]] && s->llr > s->threshold;
    s->frame_lo = i, s->frame_hi = i + 2;
  }
  ZfTajweedMadd *md = &r->madd[0];
  md->pos = 4, md->word = 1, md->token = 34, md->madd_class = ZF_TJ_MADD_FIXED2, md->status = 2;
  md->ratio = h->n20 / 8.0, md->count = 2, md->display_count = 2.25, md->allowed_lo = 2, md->allowed_hi = 2;
  md->flagged = 0, md->frame_lo = 8, md->frame_hi = 12;
  ZfTajweedLetter *q = &r->qlq[0];
  q->pos = 3, q->word = 1, q->token = 6, q->status = 1;
  q->score = h->attr_qalqalah ? h->attr_qalqalah[1] : -1;
  q->threshold = 0.2556, q->flagged = q->score < q->threshold, q->frame_lo = 6, q->frame_hi = 18;
  ZfTajweedSummary *u = &r->summary;
  u->n_sites = 2, u->n_flagged = r->sites[0].flagged + r->sites[1].flagged;
  u->n_madd = 1, u->n_madd_flagged = 0, u->n_qalqalah = 1, u->n_qalqalah_flagged = q->flagged;
  u->n_gemination = 0, u->n_gemination_flagged = 0, u->short_vowel_frames = 4.5, u->madd_unit_ok = 1;
  return r;
}
void zf_tajweed_result_free(ZfTajweedResult *r) { (void)r; }
int zf_tajweed_result_sites(const ZfTajweedResult *r, const ZfTajweedSite **s) { return *s = r->sites, 2; }
int zf_tajweed_result_madd(const ZfTajweedResult *r, const ZfTajweedMadd **m) { return *m = r->madd, 1; }
int zf_tajweed_result_qalqalah(const ZfTajweedResult *r, const ZfTajweedLetter **q) { return *q = r->qlq, 1; }
int zf_tajweed_result_gemination(const ZfTajweedResult *r, const ZfTajweedLetter **g) { return *g = NULL, (void)r, 0; }
int zf_tajweed_result_summary(const ZfTajweedResult *r, ZfTajweedSummary *out) {
  if (!r || !out) return -1;
  *out = r->summary;
  return 0;
}
const char *zf_tajweed_result_json(ZfTajweedResult *r) {
  return r ? "{\"format\":\"mock\",\"sites\":[{\"class\":\"vowel_sub\"},{\"class\":\"cons_del\"}]}" : NULL;
}

/* API 3 in the mock: no word block, so no word settings available and no words scored; the path is the
 * mock's expected sequence */
int zf_tajweed_config_set_word_preset(ZfTajweedConfig *c, const char *p) { return c && (!p || p[0]) ? 0 : -1; }
int zf_tajweed_config_set_word_threshold(ZfTajweedConfig *c, double t) { return c && t == t ? 0 : -1; }
int zf_tajweed_config_clear_word(ZfTajweedConfig *c) { return c ? 0 : -1; }
int zf_tajweed_config_word(const ZfTajweedConfig *c, ZfTajweedWordSettings *out) {
  if (!c || !out) return -1;
  out->available = 0; out->status = 0; out->enabled = 0; out->enabled_source = 0; out->preset = 1; out->preset_source = 0;
  out->threshold = 0; out->floor = 0; out->custom_lo = 0; out->custom_hi = 0;
  return 0;
}
int zf_tajweed_result_words(const ZfTajweedResult *r, const ZfTajweedWord **w) { (void)r; *w = NULL; return 0; }
int zf_tajweed_result_path(const ZfTajweedResult *r, const int **t, const int **w) { (void)r; *t = NULL; *w = NULL; return 0; }

/* API 3 final in the mock: head selection is recorded (every head is still produced), top-2 by a plain scan */
static unsigned g_mock_heads = 0x0133u; /* ZF_TAJWEED_HEADS_SCORER */
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

/* P2.16 in the mock */
int zf_tajweed_topk(const float *v, int frames, int cols, int k, int *ids, float *vo, float *mg) {
  (void)v; (void)frames; (void)cols; (void)k; (void)ids; (void)vo; (void)mg; return -1;
}
int zf_tajweed_stream_topk(const ZfTajweedStream *s, unsigned head, int k, int *ids, float *vo, float *mg, int max) {
  (void)s; (void)head; (void)k; (void)ids; (void)vo; (void)mg; (void)max; return -1;
}
