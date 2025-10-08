# Repository Guidelines

## Project Structure & Module Organization
- `src/` — UMD wrapper entry (`src/index.js`) re‑exports from `mediabunny`.
- `dist/` — Rollup build output (`mediabunny.umd.js` + sourcemap).
- `demo/` — Reference pages, web worker, service worker, and helper scripts.
- `public/` — Build-ready copy of the demo produced by the build.
- `docs/` — Project notes and HOWTO/ROADMAP files.
- `rollup.config.js` — Build configuration (UMD named global `Mediabunny`).

## Build, Test, and Development Commands
- `npm run build` — Bundle with Rollup to `dist/` and stage demo to `public/`.
- `npm run prepare:public` — Internal step run by `build`; copies/rewrites demo assets.
- Local preview: serve `public/` with any static server, e.g.:
  - `npx http-server public -p 8080` or `python -m http.server 8080` from `public/`.

## Coding Style & Naming Conventions
- JavaScript, ES modules in `src/`; UMD build exposes `window.Mediabunny`.
- Indentation: 2 spaces; include semicolons; prefer const/let over var.
- Exports: keep wrapper as re‑exports (no default export in `src/`).
- Naming: JS in `src/` camelCase (`index.js` as entry). Keep existing names in demo/public (e.g., `remux.worker.js`, `idb-recorder.js`).

## Testing Guidelines
- No test harness yet. If adding, prefer Jest or Vitest.
- Place tests under `tests/` with `*.test.js` and mirror source paths.
- Target coverage ≥80% lines; include build check in CI.
- Example: `tests/index.test.js` exercises the UMD global and ESM re‑exports.

## Commit & Pull Request Guidelines
- Use Conventional Commits when possible: `type(scope): message`.
  - Examples: `feat(sessions): add split-by-size`, `fix(demo): wait for IDB flush`, `docs: add HOWTO`.
- PRs: include a clear description, linked issues, steps to verify (`npm run build` + open `public/index.html`), and screenshots/GIFs of demo pages.
- Do not commit `dist/` artifacts unless explicitly requested.

## Security & Configuration Tips
- Service Worker scope is under `public/`; avoid broad scopes and cross-origin fetches in demos.
- Keep dependencies minimal; do not commit secrets or tokens.
