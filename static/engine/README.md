# Vendored chess engine

Stockfish 10, compiled to WebAssembly — used only by the premium "Best move" hint on the
chess board ([src/lib/chessengine.svelte.js](../../src/lib/chessengine.svelte.js)).

| File | Size | What |
|---|---|---|
| `stockfish.wasm.js` | ~97 KB | emscripten glue; runs as a Web Worker, speaks UCI over `postMessage` |
| `stockfish.wasm` | ~559 KB | the engine |
| `Copying.txt` | — | GPL-3.0, Stockfish's licence. Must ship alongside the binary. |

Source: [`stockfish.js@10.0.2`](https://www.npmjs.com/package/stockfish.js) (niklasf), files
`stockfish.wasm.js` / `stockfish.wasm` / `Copying.txt` copied verbatim. Not an npm dependency
— it is a build artifact, and vendoring keeps it out of the module graph so nothing can
accidentally import it into the Durable Object bundle.

## Why this build

**Single-threaded, and verified so.** Its `pthread_create` is a stub that returns `EAGAIN`,
there is no `SharedArrayBuffer` or `Atomics` anywhere in the glue, and the `WebAssembly.Memory`
it creates is not shared. That matters: a threaded Stockfish needs `SharedArrayBuffer`, which
needs COOP/COEP headers on *every* response the app serves — a whole-app change for one
feature.

**Small.** 656 KB total against ~7.3 MB for the modern `stockfish-18-lite-single` NNUE build.
Stockfish 10 is around 3400 Elo; the hint it gives a club player is indistinguishable from
what a newer engine would say, and this is a mobile PWA.

## Rules

- `stockfish.wasm.js` resolves its `.wasm` **relative to its own URL**, so both files must
  stay together in this directory and the worker must be constructed from `/engine/…`.
- These files are **excluded from the PWA precache** (`globIgnores` in
  [vite.config.js](../../vite.config.js)) so non-premium users never download them. If you
  move or rename this directory, update that glob too.
- Do not minify, bundle, or otherwise process them — they are shipped as-is.

## Upgrading

Re-download the three files from the same package version, keep the names, and re-run the
`SharedArrayBuffer` / `pthread_create` checks above before committing.
