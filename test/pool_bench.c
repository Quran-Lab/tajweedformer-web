/* Measures the int8 kernel's throughput single-thread and across the Emscripten-pthreads pool, so
 * the realtime factor can be estimated from a real workload rather than assumed. `run` times
 * zf_linear_s8_pool (which splits a layer's output panels across the pool) on a representative
 * shape; `chunk` times a MAC-weighted spread of the model's actual linear shapes for one 480 ms
 * chunk (369.3M int8 multiply-adds) and returns the milliseconds, from which the caller derives RTF. */
#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "zf/kernels.h"
#include "zf/pool.h"

static ZfPool *g_pool;

static uint64_t rng = 0x2545f4914f6cdd1dull;
static int rnd(int lo, int hi) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return lo + (int)(rng % (uint64_t)(hi - lo + 1)); }

typedef struct { int8_t *a, *packed; int32_t *rowsum, *out; ZfWeightsS8 w; int m, n, k, kpad; } Mat;

static void make(Mat *mt, int m, int n, int k) {
  mt->m = m; mt->n = n; mt->k = k; mt->kpad = (k + ZF_S8_K_GROUP - 1) / ZF_S8_K_GROUP * ZF_S8_K_GROUP;
  int8_t *wnk = (int8_t *)malloc((size_t)n * k);
  mt->a = (int8_t *)calloc((size_t)m * mt->kpad, 1);
  mt->packed = (int8_t *)malloc(zf_weights_s8_packed_bytes(n, k));
  mt->rowsum = (int32_t *)malloc((size_t)zf_weights_s8_row_sums_count(n) * 4);
  mt->out = (int32_t *)malloc((size_t)m * n * 4);
  for (int i = 0; i < n * k; ++i) wnk[i] = (int8_t)rnd(-127, 127);
  for (int i = 0; i < m; ++i) for (int c = 0; c < k; ++c) mt->a[(size_t)i * mt->kpad + c] = (int8_t)rnd(-128, 127);
  zf_weights_s8_pack(wnk, n, k, mt->packed, mt->rowsum, &mt->w);
  free(wnk);
}

EMSCRIPTEN_KEEPALIVE void setup(int threads) {
  if (g_pool) zf_pool_destroy(g_pool);
  g_pool = zf_pool_create(threads, 2000);
}
EMSCRIPTEN_KEEPALIVE int pool_threads(void) { return zf_pool_threads(g_pool); }

/* Aggregate GMAC/s on one shape driven through the pool. */
EMSCRIPTEN_KEEPALIVE double run(int m, int n, int k, int iters) {
  Mat mt; make(&mt, m, n, k);
  struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
  volatile int32_t sink = 0;
  for (int it = 0; it < iters; ++it) { zf_linear_s8_pool(g_pool, mt.a, m, mt.kpad, &mt.w, 100, mt.out, n); sink += mt.out[0]; }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  (void)sink;
  const double ns = (t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec);
  double g = (double)m * n * k * iters / ns;
  free(mt.a); free(mt.packed); free(mt.rowsum); free(mt.out);
  return g;
}

/* One chunk's int8 linears, as a MAC-weighted spread of the model's real shapes: six stacks of
 * dims (192,256,384,512,384,256) with layers (2,2,3,4,3,2), each layer's attention projections and
 * two feed-forwards. m is the stack's frame count (downsampled from 48). Rows chosen so the total
 * lands near the documented 369.3M MACs; the exact split is representative, not the graph's, which
 * is what makes this an estimate of chunk time rather than a claim of it. Returns milliseconds. */
EMSCRIPTEN_KEEPALIVE double chunk(int iters) {
  /* {m, n, k, count}: count linears of this shape in a chunk. */
  const int shapes[][4] = {
    {48, 192, 192, 8}, {48, 512, 192, 4}, {48, 192, 512, 4},   /* stack 0, 2 layers */
    {24, 256, 256, 8}, {24, 512, 256, 4}, {24, 256, 512, 4},   /* stack 1, 2 layers */
    {12, 384, 384, 18}, {12, 1024, 384, 6}, {12, 384, 1024, 6},/* stack 2, 3 layers */
    {6, 512, 512, 32}, {6, 2048, 512, 8}, {6, 512, 2048, 8},   /* stack 3, 4 layers */
    {12, 384, 384, 18}, {12, 1024, 384, 6}, {12, 384, 1024, 6},/* stack 4, 3 layers */
    {24, 256, 256, 8}, {24, 512, 256, 4}, {24, 256, 512, 4},   /* stack 5, 2 layers */
  };
  const int ns = (int)(sizeof shapes / sizeof shapes[0]);
  Mat *mats = (Mat *)malloc((size_t)ns * sizeof(Mat));
  for (int s = 0; s < ns; ++s) make(&mats[s], shapes[s][0], shapes[s][1], shapes[s][2]);
  struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
  volatile int32_t sink = 0;
  for (int it = 0; it < iters; ++it)
    for (int s = 0; s < ns; ++s)
      for (int c = 0; c < shapes[s][3]; ++c) {
        zf_linear_s8_pool(g_pool, mats[s].a, mats[s].m, mats[s].kpad, &mats[s].w, 100, mats[s].out, mats[s].n);
        sink += mats[s].out[0];
      }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  (void)sink;
  const double ns_total = (t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec);
  for (int s = 0; s < ns; ++s) { free(mats[s].a); free(mats[s].packed); free(mats[s].rowsum); free(mats[s].out); }
  free(mats);
  return ns_total / iters / 1e6; /* milliseconds per chunk's int8 linears */
}

EMSCRIPTEN_KEEPALIVE double chunk_macs(void) {
  const int shapes[][4] = {
    {48,192,192,8},{48,512,192,4},{48,192,512,4},{24,256,256,8},{24,512,256,4},{24,256,512,4},
    {12,384,384,18},{12,1024,384,6},{12,384,1024,6},{6,512,512,32},{6,2048,512,8},{6,512,2048,8},
    {12,384,384,18},{12,1024,384,6},{12,384,1024,6},{24,256,256,8},{24,512,256,4},{24,256,512,4},
  };
  double macs = 0; const int ns = (int)(sizeof shapes / sizeof shapes[0]);
  for (int s = 0; s < ns; ++s) macs += (double)shapes[s][0]*shapes[s][1]*shapes[s][2]*shapes[s][3];
  return macs;
}
