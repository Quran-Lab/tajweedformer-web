/* The C surface the TajweedFormer JS layer calls (web/tajweed/engine.js): thin wrappers over the
 * engine's zf_tajweed.h (API 1, and set_backend of API 2), shaped for JavaScript as zfw_api.c is for
 * zf/stream.h.
 *
 *   - strings in are NUL-terminated UTF-8 (JS stringToNewUTF8); NULL clears an app setting
 *   - no struct is passed or returned by value, and no C function pointer is taken from JS: the JS
 *     layer slices each chunk's heads out of the take's arrays after a push
 *   - zft_layout() gives sizeof and offsetof of every struct JS reads, so the JS side follows the
 *     compiler's layout instead of trusting constants
 *   - errors: functions returning a pointer return NULL (0) and set zft_error()
 *
 * Built into the wasm module only when the engine has the V4 sources (scripts/build.sh). No libc:
 * the same file builds freestanding for the glue test (test/tajweed/mock_engine.c). */
#include <stddef.h>

#include "zf_tajweed.h"

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define ZFT_EXPORT EMSCRIPTEN_KEEPALIVE
#elif defined(__wasm__)
#define ZFT_EXPORT __attribute__((visibility("default"), used))
#else
#define ZFT_EXPORT
#endif

static const char *g_error = "";
static void set_error(const char *e) { g_error = e ? e : "unknown error"; }

ZFT_EXPORT const char *zft_error(void) { return g_error; }
ZFT_EXPORT int zft_api_version(void) { return zf_tajweed_api_version(); }
ZFT_EXPORT const char *zft_version(void) { return zf_tajweed_version(); }

/* sizeof and offsetof of every struct the JS layer reads or writes, in the order engine.js names them.
 * [0] = the table's own version, [1] reserved (0); zft_layout_count() is its length. */
#define ZFT_LAYOUT_VERSION 3 /* 2: API 3's ZfTajweedWordSettings and ZfTajweedWord; 3: ZfTajweedTop2, ZfTajweedOpenOptions */
static const int g_layout[] = {
    ZFT_LAYOUT_VERSION, 0,
    /* ZfTajweedHeads */
    (int)sizeof(ZfTajweedHeads), (int)offsetof(ZfTajweedHeads, n40), (int)offsetof(ZfTajweedHeads, n20),
    (int)offsetof(ZfTajweedHeads, vocab), (int)offsetof(ZfTajweedHeads, log_probs),
    (int)offsetof(ZfTajweedHeads, inter1_log_probs), (int)offsetof(ZfTajweedHeads, inter4_log_probs),
    (int)offsetof(ZfTajweedHeads, id_log_probs), (int)offsetof(ZfTajweedHeads, timing_log_probs),
    (int)offsetof(ZfTajweedHeads, gem), (int)offsetof(ZfTajweedHeads, attr_tafkheem),
    (int)offsetof(ZfTajweedHeads, attr_ghunna), (int)offsetof(ZfTajweedHeads, attr_qalqalah),
    (int)offsetof(ZfTajweedHeads, attr_face), (int)offsetof(ZfTajweedHeads, boundary),
    (int)offsetof(ZfTajweedHeads, conf),
    /* ZfTajweedSite */
    (int)sizeof(ZfTajweedSite), (int)offsetof(ZfTajweedSite, cls), (int)offsetof(ZfTajweedSite, status),
    (int)offsetof(ZfTajweedSite, pos), (int)offsetof(ZfTajweedSite, word), (int)offsetof(ZfTajweedSite, expected),
    (int)offsetof(ZfTajweedSite, alt), (int)offsetof(ZfTajweedSite, llr_final), (int)offsetof(ZfTajweedSite, llr_inter1),
    (int)offsetof(ZfTajweedSite, llr), (int)offsetof(ZfTajweedSite, threshold), (int)offsetof(ZfTajweedSite, flagged),
    (int)offsetof(ZfTajweedSite, frame_lo), (int)offsetof(ZfTajweedSite, frame_hi),
    /* ZfTajweedMadd */
    (int)sizeof(ZfTajweedMadd), (int)offsetof(ZfTajweedMadd, pos), (int)offsetof(ZfTajweedMadd, word),
    (int)offsetof(ZfTajweedMadd, token), (int)offsetof(ZfTajweedMadd, madd_class), (int)offsetof(ZfTajweedMadd, status),
    (int)offsetof(ZfTajweedMadd, ratio), (int)offsetof(ZfTajweedMadd, count), (int)offsetof(ZfTajweedMadd, display_count),
    (int)offsetof(ZfTajweedMadd, allowed_lo), (int)offsetof(ZfTajweedMadd, allowed_hi),
    (int)offsetof(ZfTajweedMadd, flagged), (int)offsetof(ZfTajweedMadd, frame_lo), (int)offsetof(ZfTajweedMadd, frame_hi),
    /* ZfTajweedLetter */
    (int)sizeof(ZfTajweedLetter), (int)offsetof(ZfTajweedLetter, pos), (int)offsetof(ZfTajweedLetter, word),
    (int)offsetof(ZfTajweedLetter, token), (int)offsetof(ZfTajweedLetter, status), (int)offsetof(ZfTajweedLetter, score),
    (int)offsetof(ZfTajweedLetter, threshold), (int)offsetof(ZfTajweedLetter, flagged),
    (int)offsetof(ZfTajweedLetter, frame_lo), (int)offsetof(ZfTajweedLetter, frame_hi),
    /* ZfTajweedSummary */
    (int)sizeof(ZfTajweedSummary), (int)offsetof(ZfTajweedSummary, n_sites), (int)offsetof(ZfTajweedSummary, n_flagged),
    (int)offsetof(ZfTajweedSummary, n_madd), (int)offsetof(ZfTajweedSummary, n_madd_flagged),
    (int)offsetof(ZfTajweedSummary, n_qalqalah), (int)offsetof(ZfTajweedSummary, n_qalqalah_flagged),
    (int)offsetof(ZfTajweedSummary, n_gemination), (int)offsetof(ZfTajweedSummary, n_gemination_flagged),
    (int)offsetof(ZfTajweedSummary, short_vowel_frames), (int)offsetof(ZfTajweedSummary, madd_unit_ok),
    /* ZfTajweedEffective */
    (int)sizeof(ZfTajweedEffective), (int)offsetof(ZfTajweedEffective, preset),
    (int)offsetof(ZfTajweedEffective, preset_source), (int)offsetof(ZfTajweedEffective, class_enabled),
    (int)offsetof(ZfTajweedEffective, class_status), (int)offsetof(ZfTajweedEffective, class_threshold),
    (int)offsetof(ZfTajweedEffective, class_source), (int)offsetof(ZfTajweedEffective, check_enabled),
    (int)offsetof(ZfTajweedEffective, check_status), (int)offsetof(ZfTajweedEffective, check_source),
    (int)offsetof(ZfTajweedEffective, context), (int)offsetof(ZfTajweedEffective, context_source),
    /* ZfTajweedWordSettings (API 3) */
    (int)sizeof(ZfTajweedWordSettings), (int)offsetof(ZfTajweedWordSettings, struct_size),
    (int)offsetof(ZfTajweedWordSettings, available), (int)offsetof(ZfTajweedWordSettings, status),
    (int)offsetof(ZfTajweedWordSettings, enabled), (int)offsetof(ZfTajweedWordSettings, enabled_source),
    (int)offsetof(ZfTajweedWordSettings, preset), (int)offsetof(ZfTajweedWordSettings, preset_source),
    (int)offsetof(ZfTajweedWordSettings, threshold), (int)offsetof(ZfTajweedWordSettings, floor),
    (int)offsetof(ZfTajweedWordSettings, custom_lo), (int)offsetof(ZfTajweedWordSettings, custom_hi),
    (int)offsetof(ZfTajweedWordSettings, preset_tau),
    /* ZfTajweedWord (API 3) */
    (int)sizeof(ZfTajweedWord), (int)offsetof(ZfTajweedWord, word), (int)offsetof(ZfTajweedWord, tok_lo),
    (int)offsetof(ZfTajweedWord, tok_hi), (int)offsetof(ZfTajweedWord, has_score), (int)offsetof(ZfTajweedWord, score),
    (int)offsetof(ZfTajweedWord, threshold), (int)offsetof(ZfTajweedWord, flagged), (int)offsetof(ZfTajweedWord, cls),
    (int)offsetof(ZfTajweedWord, edit), (int)offsetof(ZfTajweedWord, edit_pos), (int)offsetof(ZfTajweedWord, expected),
    (int)offsetof(ZfTajweedWord, alt), (int)offsetof(ZfTajweedWord, llr_final), (int)offsetof(ZfTajweedWord, llr_inter1),
    /* ZfTajweedTop2 (API 3 final) */
    (int)sizeof(ZfTajweedTop2), (int)offsetof(ZfTajweedTop2, token), (int)offsetof(ZfTajweedTop2, runner_up),
    (int)offsetof(ZfTajweedTop2, log_prob), (int)offsetof(ZfTajweedTop2, runner_up_log_prob), (int)offsetof(ZfTajweedTop2, margin),
    /* ZfTajweedOpenOptions (built here, never by JS; listed so a test pins the wasm32 layout with no_pin) */
    (int)sizeof(ZfTajweedOpenOptions), (int)offsetof(ZfTajweedOpenOptions, context), (int)offsetof(ZfTajweedOpenOptions, batch),
    (int)offsetof(ZfTajweedOpenOptions, no_pin),
};
ZFT_EXPORT const int *zft_layout(void) { return g_layout; }
ZFT_EXPORT int zft_layout_count(void) { return (int)(sizeof g_layout / sizeof g_layout[0]); }

/* ---------------------------------------------------------------------------------------------
 * The model
 * ------------------------------------------------------------------------------------------- */

/* `dir` holds the verified folder's files (the JS layer stages only listed, checked files there).
 * context NULL: calibration's default. sample_rate 0: 16 kHz. */
ZFT_EXPORT ZfTajweedModel *zft_model_open(const char *dir, const char *context, int load_engine, int threads,
                                          int sample_rate) {
  ZfTajweedOpenOptions o = zf_tajweed_open_default_options();
  o.context = context;
  o.load_engine = load_engine ? 1 : 0;
  o.threads = threads;
  o.sample_rate = sample_rate;
  o.batch = 1;
  const char *err = NULL;
  ZfTajweedModel *m = zf_tajweed_model_open(dir, &o, &err);
  if (!m) set_error(err ? err : "zf_tajweed_model_open failed");
  return m;
}
ZFT_EXPORT void zft_model_close(ZfTajweedModel *m) { zf_tajweed_model_close(m); }
ZFT_EXPORT const char *zft_model_id(const ZfTajweedModel *m) { return zf_tajweed_model_id(m); }
ZFT_EXPORT const char *zft_model_context(const ZfTajweedModel *m) { return zf_tajweed_model_context(m); }
ZFT_EXPORT int zft_model_chunk_ms(const ZfTajweedModel *m) { return zf_tajweed_model_chunk_ms(m); }
ZFT_EXPORT int zft_ayah_count(const ZfTajweedModel *m, int surah) { return zf_tajweed_ayah_count(m, surah); }

/* An ayah's expected tokens and each token's word: the count (or -1), the pointers in the slots
 * zft_expected_tokens_ptr / zft_expected_words_ptr / zft_expected_n_words until the next call. */
static const int *g_exp_tokens, *g_exp_words;
static int g_exp_n_words;
ZFT_EXPORT int zft_expected(const ZfTajweedModel *m, int surah, int ayah) {
  g_exp_tokens = g_exp_words = NULL;
  g_exp_n_words = 0;
  const int n = zf_tajweed_expected_tokens(m, surah, ayah, &g_exp_tokens);
  if (n < 0) {
    set_error("no such ayah in the expected table");
    return -1;
  }
  if (zf_tajweed_expected_words(m, surah, ayah, &g_exp_words, &g_exp_n_words) != n) {
    set_error("the expected table's words do not match its tokens");
    return -1;
  }
  return n;
}
ZFT_EXPORT const int *zft_expected_tokens_ptr(void) { return g_exp_tokens; }
ZFT_EXPORT const int *zft_expected_words_ptr(void) { return g_exp_words; }
ZFT_EXPORT int zft_expected_n_words(void) { return g_exp_n_words; }

/* ---------------------------------------------------------------------------------------------
 * The stream
 * ------------------------------------------------------------------------------------------- */

ZFT_EXPORT ZfTajweedStream *zft_stream_create(ZfTajweedModel *m) {
  const char *err = NULL;
  ZfTajweedStream *s = zf_tajweed_stream_create(m, &err);
  if (!s) set_error(err ? err : "zf_tajweed_stream_create failed");
  return s;
}
ZFT_EXPORT void zft_stream_destroy(ZfTajweedStream *s) { zf_tajweed_stream_destroy(s); }
ZFT_EXPORT void zft_stream_reset(ZfTajweedStream *s) { zf_tajweed_stream_reset(s); }
ZFT_EXPORT int zft_stream_push_audio(ZfTajweedStream *s, const float *samples, int n) {
  return zf_tajweed_stream_push_audio(s, samples, n);
}
ZFT_EXPORT int zft_stream_finish(ZfTajweedStream *s) { return zf_tajweed_stream_finish(s); }
/* Fills *out (a ZfTajweedHeads the JS layer allocated, zft_layout's size); returns n40 or -1. */
ZFT_EXPORT int zft_stream_heads(const ZfTajweedStream *s, ZfTajweedHeads *out) { return zf_tajweed_stream_heads(s, out); }
ZFT_EXPORT int zft_stream_greedy(const ZfTajweedStream *s, int *ids, int max) { return zf_tajweed_stream_greedy(s, ids, max); }
ZFT_EXPORT const char *zft_stream_error(const ZfTajweedStream *s) {
  const char *e = zf_tajweed_stream_last_error(s);
  return e ? e : "";
}

/* ---------------------------------------------------------------------------------------------
 * The config
 * ------------------------------------------------------------------------------------------- */

static size_t zft_strlen(const char *s) {
  size_t n = 0;
  if (s)
    while (s[n]) ++n;
  return n;
}

ZFT_EXPORT ZfTajweedConfig *zft_config_create(const ZfTajweedModel *m) {
  ZfTajweedConfig *c = zf_tajweed_config_create(m);
  if (!c) set_error("zf_tajweed_config_create failed");
  return c;
}
ZFT_EXPORT void zft_config_destroy(ZfTajweedConfig *c) { zf_tajweed_config_destroy(c); }
/* json NULL clears the remote layer. Returns the fields dropped, or -1 (not JSON). */
ZFT_EXPORT int zft_config_set_remote(ZfTajweedConfig *c, const char *json) {
  return zf_tajweed_config_set_remote(c, json, zft_strlen(json));
}
ZFT_EXPORT int zft_config_set_preset(ZfTajweedConfig *c, const char *preset) { return zf_tajweed_config_set_preset(c, preset); }
ZFT_EXPORT int zft_config_set_class_preset(ZfTajweedConfig *c, const char *cls, const char *preset) {
  return zf_tajweed_config_set_class_preset(c, cls, preset);
}
ZFT_EXPORT int zft_config_set_class_threshold(ZfTajweedConfig *c, const char *cls, double threshold) {
  return zf_tajweed_config_set_class_threshold(c, cls, threshold);
}
ZFT_EXPORT int zft_config_clear_class(ZfTajweedConfig *c, const char *cls) { return zf_tajweed_config_clear_class(c, cls); }
/* on: 1, 0, or -1 to remove the app's switch */
ZFT_EXPORT int zft_config_set_check(ZfTajweedConfig *c, const char *check, int on) {
  return zf_tajweed_config_set_check(c, check, on);
}
ZFT_EXPORT int zft_config_set_context(ZfTajweedConfig *c, const char *context) {
  return zf_tajweed_config_set_context(c, context);
}
ZFT_EXPORT void zft_config_clear_app(ZfTajweedConfig *c) { zf_tajweed_config_clear_app(c); }
/* API 2: "int8" (the exact engine's heads), "fp32" (heads from elsewhere), NULL for the default.
 * 0, or -1 for another name or an API 1 engine. */
ZFT_EXPORT int zft_config_set_backend(ZfTajweedConfig *c, const char *backend) {
#if ZF_TAJWEED_API_VERSION >= 2
  return zf_tajweed_config_set_backend(c, backend);
#else
  (void)c;
  (void)backend;
  return -1;
#endif
}
ZFT_EXPORT void zft_config_set_debug_build(ZfTajweedConfig *c, int debug_build) {
  zf_tajweed_config_set_debug_build(c, debug_build);
}
/* Fills *out (zft_layout's size of ZfTajweedEffective); 0 or -1. */
ZFT_EXPORT int zft_config_effective(const ZfTajweedConfig *c, ZfTajweedEffective *out) {
  return zf_tajweed_config_effective(c, out);
}
ZFT_EXPORT const char *zft_config_json(ZfTajweedConfig *c) {
  const char *j = zf_tajweed_config_json(c);
  return j ? j : "";
}

/* ---------------------------------------------------------------------------------------------
 * Scoring
 * ------------------------------------------------------------------------------------------- */

ZFT_EXPORT ZfTajweedResult *zft_score(const ZfTajweedModel *m, const ZfTajweedConfig *c, const ZfTajweedHeads *h,
                                      int surah, int ayah) {
  const char *err = NULL;
  ZfTajweedResult *r = zf_tajweed_score(m, c, h, surah, ayah, &err);
  if (!r) set_error(err ? err : "zf_tajweed_score failed");
  return r;
}
ZFT_EXPORT void zft_result_free(ZfTajweedResult *r) { zf_tajweed_result_free(r); }

/* Each returns the count and leaves the array pointer in the matching slot below. */
static const ZfTajweedSite *g_sites;
static const ZfTajweedMadd *g_madd;
static const ZfTajweedLetter *g_qlq, *g_gem;
ZFT_EXPORT int zft_result_sites(const ZfTajweedResult *r) { return zf_tajweed_result_sites(r, &g_sites); }
ZFT_EXPORT const ZfTajweedSite *zft_result_sites_ptr(void) { return g_sites; }
ZFT_EXPORT int zft_result_madd(const ZfTajweedResult *r) { return zf_tajweed_result_madd(r, &g_madd); }
ZFT_EXPORT const ZfTajweedMadd *zft_result_madd_ptr(void) { return g_madd; }
ZFT_EXPORT int zft_result_qalqalah(const ZfTajweedResult *r) { return zf_tajweed_result_qalqalah(r, &g_qlq); }
ZFT_EXPORT const ZfTajweedLetter *zft_result_qalqalah_ptr(void) { return g_qlq; }
ZFT_EXPORT int zft_result_gemination(const ZfTajweedResult *r) { return zf_tajweed_result_gemination(r, &g_gem); }
ZFT_EXPORT const ZfTajweedLetter *zft_result_gemination_ptr(void) { return g_gem; }
/* Fills *out (zft_layout's size of ZfTajweedSummary); 0 or -1. */
ZFT_EXPORT int zft_result_summary(const ZfTajweedResult *r, ZfTajweedSummary *out) {
  return zf_tajweed_result_summary(r, out);
}
ZFT_EXPORT const char *zft_result_json(ZfTajweedResult *r) {
  const char *j = zf_tajweed_result_json(r);
  return j ? j : "";
}

/* API 3: the word level (per-word score and word settings) */
ZFT_EXPORT int zft_config_set_word_preset(ZfTajweedConfig *c, const char *preset) { return zf_tajweed_config_set_word_preset(c, preset); }
ZFT_EXPORT int zft_config_set_word_threshold(ZfTajweedConfig *c, double t) { return zf_tajweed_config_set_word_threshold(c, t); }
ZFT_EXPORT int zft_config_clear_word(ZfTajweedConfig *c) { return zf_tajweed_config_clear_word(c); }
/* out: a ZfTajweedWordSettings the caller allocated (zft_layout gives its size); struct_size is set here */
ZFT_EXPORT int zft_config_word(const ZfTajweedConfig *c, ZfTajweedWordSettings *out) {
  if (!out) return -1;
  out->struct_size = sizeof *out;
  return zf_tajweed_config_word(c, out);
}
static const ZfTajweedWord *g_words;
static const int *g_path, *g_path_words;
ZFT_EXPORT int zft_result_words(const ZfTajweedResult *r) { return zf_tajweed_result_words(r, &g_words); }
ZFT_EXPORT const ZfTajweedWord *zft_result_words_ptr(void) { return g_words; }
ZFT_EXPORT int zft_result_path(const ZfTajweedResult *r) { return zf_tajweed_result_path(r, &g_path, &g_path_words); }
ZFT_EXPORT const int *zft_result_path_ptr(void) { return g_path; }
ZFT_EXPORT const int *zft_result_path_words_ptr(void) { return g_path_words; }

/* API 3 final: the heads a stream computes (ZF_TAJWEED_HEAD_* bits; a new stream computes the scorer's),
 * and the decoded layer's per-frame top-1 and runner-up */
ZFT_EXPORT int zft_stream_set_heads(ZfTajweedStream *s, unsigned heads) { return zf_tajweed_stream_set_heads(s, heads); }
ZFT_EXPORT unsigned zft_stream_get_heads(const ZfTajweedStream *s) { return zf_tajweed_stream_get_heads(s); }
static const ZfTajweedTop2 *g_top2;
ZFT_EXPORT int zft_stream_top2(const ZfTajweedStream *s) { return zf_tajweed_stream_top2(s, &g_top2); }
ZFT_EXPORT const ZfTajweedTop2 *zft_stream_top2_ptr(void) { return g_top2; }
ZFT_EXPORT int zft_top2(const float *log_probs, int frames, int vocab, ZfTajweedTop2 *out) {
  return zf_tajweed_top2(log_probs, frames, vocab, out);
}

/* P2.16: top-K for any head with a distribution (ids and values [frames, k]; margins computed by the JS
 * layer as doubles, so NULL is passed for the engine's float margins) */
ZFT_EXPORT int zft_stream_topk(const ZfTajweedStream *s, unsigned head, int k, int *ids, float *values, float *margins,
                               int max_frames) {
  return zf_tajweed_stream_topk(s, head, k, ids, values, margins, max_frames);
}
ZFT_EXPORT int zft_topk(const float *values, int frames, int cols, int k, int *ids, float *values_out, float *margins) {
  return zf_tajweed_topk(values, frames, cols, k, ids, values_out, margins);
}
