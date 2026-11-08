/* Bit-exactness and speed check for the int8 linear kernel across the scalar and WASM-SIMD paths.
 *
 * The kernel's contract: out[i][j] = sum_k a[i][k] * w[j][k] + (128 - a_zero_point) * sum_k w[j][k],
 * where `a` is the shifted int8 activation (row stride lda >= k rounded up to ZF_S8_K_GROUP, the
 * pad zeroed) and `w` the packed weights. This computes that sum independently with a plain triple
 * loop and asserts the kernel reproduces it exactly, over shapes that span the model's linears
 * (m in {3,6,12,24}) and its lowered convolutions (m in the hundreds), n both a multiple of the
 * four-unit block and not (251 is the vocabulary), and k both a multiple of the 16-byte group and
 * not. A mismatch prints the first offending element and fails; the whole point of the kernel is
 * that there is never one. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "zf/kernels.h"

static uint64_t rng = 0x9e3779b97f4a7c15ull;
static int rnd(int lo, int hi) { /* [lo, hi] */
  rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
  return lo + (int)(rng % (uint64_t)(hi - lo + 1));
}

/* fill: 0 random, 1 the extremes (activations -128, weights +-127: every int16 pair sum at +-32512,
 * the largest the pack allows) */
static int check_shape_fill(int m, int n, int k, int a_zp, int fill) {
  const int k_pad = (k + ZF_S8_K_GROUP - 1) / ZF_S8_K_GROUP * ZF_S8_K_GROUP;
  const int lda = k_pad;
  int8_t *w_nk = malloc((size_t)n * k);
  int8_t *a = calloc((size_t)m * lda, 1); /* pad columns [k, k_pad) stay zero */
  int32_t *out = malloc((size_t)m * n * sizeof(int32_t));
  int32_t *gold = malloc((size_t)m * n * sizeof(int32_t));
  int8_t *packed = malloc(zf_weights_s8_packed_bytes(n, k));
  int32_t *row_sums = malloc((size_t)zf_weights_s8_row_sums_count(n) * sizeof(int32_t));

  for (int j = 0; j < n; ++j)
    for (int c = 0; c < k; ++c)
      w_nk[(size_t)j * k + c] = fill ? (int8_t)((j & 1) ? 127 : -127) : (int8_t)rnd(-127, 127);
  for (int i = 0; i < m; ++i)
    for (int c = 0; c < k; ++c) a[(size_t)i * lda + c] = fill ? (int8_t)-128 : (int8_t)rnd(-128, 127);

  ZfWeightsS8 w;
  if (!zf_weights_s8_pack(w_nk, n, k, packed, row_sums, &w)) {
    fprintf(stderr, "pack rejected m=%d n=%d k=%d\n", m, n, k);
    return 1;
  }
  const int32_t corr = 128 - a_zp;
  for (int i = 0; i < m; ++i)
    for (int j = 0; j < n; ++j) {
      int64_t s = 0, rs = 0;
      for (int c = 0; c < k; ++c) {
        s += (int32_t)a[(size_t)i * lda + c] * (int32_t)w_nk[(size_t)j * k + c];
        rs += w_nk[(size_t)j * k + c];
      }
      gold[(size_t)i * n + j] = (int32_t)(s + (int64_t)corr * rs);
    }

  memset(out, 0xCD, (size_t)m * n * sizeof(int32_t));
  zf_linear_s8(a, m, lda, &w, a_zp, out, n);

  int bad = 0;
  for (int i = 0; i < m && !bad; ++i)
    for (int j = 0; j < n; ++j)
      if (out[(size_t)i * n + j] != gold[(size_t)i * n + j]) {
        fprintf(stderr, "MISMATCH m=%d n=%d k=%d zp=%d at [%d][%d]: kernel %d != gold %d\n", m, n, k,
                a_zp, i, j, out[(size_t)i * n + j], gold[(size_t)i * n + j]);
        bad = 1;
        break;
      }
  free(w_nk); free(a); free(out); free(gold); free(packed); free(row_sums);
  return bad;
}

static int check_shape(int m, int n, int k, int a_zp) { return check_shape_fill(m, n, k, a_zp, 0); }

int main(void) {
  const int ms[] = {1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 24, 32, 33, 100, 300};
  const int ns[] = {4, 5, 7, 8, 16, 192, 251, 256, 512};
  const int ks[] = {16, 31, 32, 48, 80, 100, 192, 384, 512};
  const int zps[] = {0, 1, 64, 128, 200, 255};
  int fails = 0, cases = 0;
  for (size_t im = 0; im < sizeof ms / sizeof *ms; ++im)
    for (size_t in = 0; in < sizeof ns / sizeof *ns; ++in)
      for (size_t ik = 0; ik < sizeof ks / sizeof *ks; ++ik) {
        const int zp = zps[(im + in + ik) % (sizeof zps / sizeof *zps)];
        fails += check_shape(ms[im], ns[in], ks[ik], zp);
        ++cases;
      }
  /* the extremes, and the pack's refusal of -128, which is what bounds every int16 lane */
  for (size_t ik = 0; ik < sizeof ks / sizeof *ks; ++ik) {
    fails += check_shape_fill(24, 8, ks[ik], 0, 1) + check_shape_fill(5, 7, ks[ik], 255, 1);
    cases += 2;
  }
  {
    int8_t w128[32];
    for (int c = 0; c < 32; ++c) w128[c] = (int8_t)(c == 17 ? -128 : 1);
    int8_t packed[4 * 32];
    int32_t sums[4];
    ZfWeightsS8 w;
    if (zf_weights_s8_pack(w128, 1, 32, packed, sums, &w)) {
      fprintf(stderr, "the pack accepted a weight of -128\n");
      ++fails;
    }
    ++cases;
  }
  printf("%s: %d shapes, %d failures  [variant: %s]\n", fails ? "FAIL" : "PASS", cases, fails,
         zf_kernels_asm_available() ? "asm" : "portable");

  /* Throughput on a model-representative shape: the encoder's widest linear, repeated. */
  const int m = 24, n = 512, k = 512;
  const int k_pad = (k + ZF_S8_K_GROUP - 1) / ZF_S8_K_GROUP * ZF_S8_K_GROUP;
  int8_t *a = calloc((size_t)m * k_pad, 1);
  int8_t *w_nk = malloc((size_t)n * k), *packed = malloc(zf_weights_s8_packed_bytes(n, k));
  int32_t *row_sums = malloc((size_t)zf_weights_s8_row_sums_count(n) * sizeof(int32_t));
  int32_t *out = malloc((size_t)m * n * sizeof(int32_t));
  for (int j = 0; j < n; ++j) for (int c = 0; c < k; ++c) w_nk[(size_t)j * k + c] = (int8_t)rnd(-127, 127);
  for (int i = 0; i < m; ++i) for (int c = 0; c < k; ++c) a[(size_t)i * k_pad + c] = (int8_t)rnd(-128, 127);
  ZfWeightsS8 w; zf_weights_s8_pack(w_nk, n, k, packed, row_sums, &w);
  const int iters = 20000;
  struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
  volatile int32_t sink = 0;
  for (int it = 0; it < iters; ++it) { zf_linear_s8(a, m, k_pad, &w, 100, out, n); sink += out[0]; }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  const double ns_total = (t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec);
  const double macs = (double)m * n * k;
  printf("gemm %dx%dx%d: %.2f us/call, %.2f GMAC/s\n", m, n, k, ns_total / iters / 1e3,
         macs * iters / ns_total);
  (void)sink;
  return fails ? 1 : 0;
}
