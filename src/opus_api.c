/* opus_api.c: the libopus calls the web sharing pipeline makes (web/sharing/encoder.js), as plain
 * one-argument exports for JavaScript (opus_encoder_ctl is variadic). Built by scripts/build_opus.sh
 * into dist/tajweedformer-opus.mjs, a separate module loaded only when sharing is on.
 *
 * Settings are the Swift SDK's OpusSettings (tajweedformer-sdk-swift Sharing/OpusEncoder.swift):
 * the caller passes each value; requests are applied in the same order. The decoder is exported for
 * the tests (RFC 7845 decode of what the encoder wrote). */
#include <stdint.h>
#include <stdlib.h>
#include <opus.h>

#define OW_EXPORT __attribute__((used, visibility("default")))

/* Create an encoder and apply the settings; returns NULL and sets *err (libopus error, or the
 * 1-based index of the refused request as -(100 + i)) on failure. */
OW_EXPORT OpusEncoder *ow_enc_create(int rate, int channels, int application, int bitrate, int complexity, int vbr,
                                     int cvbr, int bandwidth, int signal, int lsb_depth, int *err) {
  int e = 0;
  OpusEncoder *enc = opus_encoder_create(rate, channels, application, &e);
  if (!enc || e != OPUS_OK) { if (err) *err = e ? e : OPUS_ALLOC_FAIL; return NULL; }
  const int req[9][2] = {
    {OPUS_SET_BITRATE_REQUEST, bitrate}, {OPUS_SET_COMPLEXITY_REQUEST, complexity}, {OPUS_SET_VBR_REQUEST, vbr},
    {OPUS_SET_VBR_CONSTRAINT_REQUEST, cvbr}, {OPUS_SET_BANDWIDTH_REQUEST, bandwidth}, {OPUS_SET_SIGNAL_REQUEST, signal},
    {OPUS_SET_LSB_DEPTH_REQUEST, lsb_depth}, {OPUS_SET_INBAND_FEC_REQUEST, 0}, {OPUS_SET_DTX_REQUEST, 0},
  };
  for (int i = 0; i < 9; ++i) {
    if (opus_encoder_ctl(enc, req[i][0], (opus_int32)req[i][1]) != OPUS_OK) {
      opus_encoder_destroy(enc);
      if (err) *err = -(100 + i + 1);
      return NULL;
    }
  }
  if (err) *err = OPUS_OK;
  return enc;
}

/* A GET request (OPUS_GET_*_REQUEST) read back; returns the value, or INT32_MIN when refused. */
OW_EXPORT int32_t ow_enc_get(OpusEncoder *enc, int request) {
  opus_int32 v = 0;
  return opus_encoder_ctl(enc, request, &v) == OPUS_OK ? v : INT32_MIN;
}

/* A SET request (OPUS_SET_*_REQUEST) with one integer value, at any time after creation (the sharing
 * pipeline sets the bitrate when a segment opens); returns OPUS_OK or the libopus error. */
OW_EXPORT int ow_enc_set(OpusEncoder *enc, int request, int value) {
  return opus_encoder_ctl(enc, request, (opus_int32)value);
}

/* One frame of float PCM (frame_size samples per channel) to one packet; returns its bytes or a
 * negative libopus error. */
OW_EXPORT int ow_enc_encode(OpusEncoder *enc, const float *pcm, int frame_size, unsigned char *out, int max) {
  return opus_encode_float(enc, pcm, frame_size, out, max);
}

OW_EXPORT void ow_enc_destroy(OpusEncoder *enc) { if (enc) opus_encoder_destroy(enc); }

OW_EXPORT OpusDecoder *ow_dec_create(int rate, int channels) {
  int e = 0;
  OpusDecoder *d = opus_decoder_create(rate, channels, &e);
  return e == OPUS_OK ? d : NULL;
}

/* One packet to float PCM; returns samples per channel or a negative libopus error. */
OW_EXPORT int ow_dec_decode(OpusDecoder *d, const unsigned char *data, int len, float *pcm, int max_frames) {
  return opus_decode_float(d, data, len, pcm, max_frames, 0);
}

OW_EXPORT void ow_dec_destroy(OpusDecoder *d) { if (d) opus_decoder_destroy(d); }

OW_EXPORT const char *ow_version(void) { return opus_get_version_string(); }
