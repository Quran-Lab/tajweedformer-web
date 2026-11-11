# TajweedFormer with Vite

The quick start as a Vite project with no `vite.config.js`: the package is imported by its name, and Vite finds
the engine's Worker and its WebAssembly file by itself.

```sh
npm install                                        # in your own project: npm install @quran-lab/tajweedformer
echo "VITE_QURANLAB_KEY=qlk_v1_..." > .env.local   # your web key from sdk.quranlab.ai; never commit it
npm run dev                                        # http://localhost:5173
npm run build                                      # dist/: the page, the Worker, the wasm
```

Inside this repository the package comes from the checkout (`file:../..`), so build it first: `npm run build:all`
in the repository's root.

## The key

- For `vite dev` use the app's **development** web key, with `http://localhost:*` among its origins. A production
  key does not work on a local address: the SDK says so with the error `server_rejected` and what to do.
- A web key belongs to the first origin that used it. For this example that is the page's origin:
  `http://localhost:5173` under `vite dev`, and your site's origin (`https://app.example.org`) once deployed. To
  use one key from another origin, add that origin on the key's page at https://sdk.quranlab.ai/keys.
- On a local origin recitation sharing is not offered.

## What the page does

"Play sample" runs a sample clip of the model through `listen({ from })`, so output appears with no microphone.
"Recite" asks for the microphone; the take ends by itself after 1.5 s of silence, and the same button stops it
before that. In a noisy room a take may not end on silence, so keep a Stop control.
