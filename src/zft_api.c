/* The C surface the TajweedFormer JS layer calls (web/tajweed/engine.js): thin wrappers over the
 * engine's zf_tajweed.h, shaped for JavaScript. Inference only: the model, a stream, its heads, top-2 and
 * top-K, and the reference table lookup.
 *
 *   - strings in are NUL-terminated UTF-8 (JS stringToNewUTF8)
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
#define ZFT_LAYOUT_VERSION 4 /* 4: SDK 3.0.0, inference only: ZfTajweedHeads, ZfTajweedTop2, ZfTajweedOpenOptions */
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
    /* ZfTajweedTop2 */
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
 * context NULL: the model's default. sample_rate 0: 16 kHz. */
ZFT_EXPORT ZfTajweedModel *zft_model_open(const char *dir, const char *context, int threads, int sample_rate) {
  ZfTajweedOpenOptions o = zf_tajweed_open_default_options();
  o.context = context;
  o.threads = threads;
  o.sample_rate = sample_rate;
  o.batch = 1;
  const char *err = NULL;
  ZfTajweedModel *m = zf_tajweed_model_open(dir, &o, &err);
  if (!m) set_error(err ? err : "zf_tajweed_model_open failed");
  return m;
}
ZFT_EXPORT void zft_model_close(ZfTajweedModel *m) { zf_tajweed_model_close(m); }
ZFT_EXPORT const char *zft_model_context(const ZfTajweedModel *m) { return zf_tajweed_model_context(m); }
ZFT_EXPORT int zft_model_chunk_ms(const ZfTajweedModel *m) { return zf_tajweed_model_chunk_ms(m); }
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

/* The heads a stream computes (ZF_TAJWEED_HEAD_* bits), and the decoded layer's per-frame top-1 and runner-up */
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

/* ---------------------------------------------------------------------------------------------
 * Reference data: the expected units of each ayah (a table of its own; no link to the model)
 * ------------------------------------------------------------------------------------------- */

static ZfTajweedReference *g_ref;
static const int *g_ref_units, *g_ref_words;
static int g_ref_n_words;

/* Opens the table from the file's verified bytes (the engine copies them), closing one opened before.
 * 0, or -1 with zft_error(). */
ZFT_EXPORT int zft_reference_open(const void *bytes, int size) {
  const char *err = NULL;
  if (g_ref) zf_tajweed_reference_close(g_ref);
  g_ref = size > 0 ? zf_tajweed_reference_open_memory(bytes, (size_t)size, &err) : NULL;
  if (!g_ref) {
    set_error(err ? err : "zf_tajweed_reference_open_memory failed");
    return -1;
  }
  return 0;
}
ZFT_EXPORT void zft_reference_close(void) {
  if (g_ref) zf_tajweed_reference_close(g_ref);
  g_ref = NULL;
}
/* The SHA-256 (32 bytes) of the tokens.txt the table's ids refer to, or NULL with no table open. */
ZFT_EXPORT const unsigned char *zft_reference_tokens_sha256(void) { return g_ref ? zf_tajweed_reference_tokens_sha256(g_ref) : NULL; }
ZFT_EXPORT int zft_reference_ayah_count(int surah) { return g_ref ? zf_tajweed_reference_ayah_count(g_ref, surah) : 0; }
/* An ayah's units: the count (or -1), the pointers in the slots below until the next call or close. */
ZFT_EXPORT int zft_reference_units(int surah, int ayah) {
  g_ref_units = g_ref_words = NULL;
  g_ref_n_words = 0;
  if (!g_ref) return -1;
  return zf_tajweed_reference_units(g_ref, surah, ayah, &g_ref_units, &g_ref_words, &g_ref_n_words);
}
ZFT_EXPORT const int *zft_reference_units_ptr(void) { return g_ref_units; }
ZFT_EXPORT const int *zft_reference_words_ptr(void) { return g_ref_words; }
ZFT_EXPORT int zft_reference_n_words(void) { return g_ref_n_words; }
