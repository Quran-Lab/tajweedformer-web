/* opusfile_check: an independent reader for the sharing stream tests. Opens an Ogg Opus file with libopusfile
 * (op_open_file), reports its links and op_pcm_total, then reads the whole stream with op_read_float, counting
 * the samples, any OP_HOLE (a gap in the page sequence or granules) and any read error. One line of key=value:
 *   open=<0 or the error> links=<n> pcm_total=<samples> read=<samples> holes=<n> errors=<n> channels=<n>
 * Built by scripts/build_opusfile_check.sh; test/sharing_ogg_append.test.mjs runs it when OPUSFILE_CHECK names it. */
#include <stdio.h>
#include <opusfile.h>

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: opusfile_check <file.ogg>\n"); return 2; }
  int err = 0;
  OggOpusFile *of = op_open_file(argv[1], &err);
  if (!of) {
    printf("open=%d links=0 pcm_total=-1 read=0 holes=0 errors=1 channels=0\n", err);
    return 1;
  }
  long long total = (long long)op_pcm_total(of, -1);
  int links = op_link_count(of);
  int channels = op_channel_count(of, -1);
  static float buf[5760 * 2];
  long long n = 0;
  int holes = 0, errors = 0;
  for (;;) {
    int r = op_read_float(of, buf, (int)(sizeof buf / sizeof buf[0]), NULL);
    if (r == OP_HOLE) { holes++; continue; }
    if (r < 0) { errors++; break; }
    if (r == 0) break;
    n += r;
  }
  printf("open=0 links=%d pcm_total=%lld read=%lld holes=%d errors=%d channels=%d\n", links, total, n, holes, errors, channels);
  op_free(of);
  return 0;
}
