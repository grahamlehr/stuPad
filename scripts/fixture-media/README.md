# scripts/fixture-media/

`tiny.mp4` is a tiny, silent, generated test clip used by `scripts/make-fixtures.mjs` to build
`tests/fixtures/video.pptx` (feature H, "Video on destination slides"). It is checked in so
`npm run fixtures` never needs `ffmpeg` at fixture-build time.

Generated once with:

```sh
ffmpeg -f lavfi -i testsrc=size=64x36:rate=10 -t 1 -pix_fmt yuv420p -c:v libx264 -preset veryslow -crf 40 -an -movflags +faststart scripts/fixture-media/tiny.mp4
```

1 second, 64x36, 10 fps, no audio, ~2 KB.
