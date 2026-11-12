# Atlas Reader class project

This is the standalone OIM3641 team application, not the personal Atlas runtime.

- Scope and acceptance: `CONTEXT.md`.
- Browser document workflow: `src/client/CONTEXT.md`.
- Local HTTP and provider boundaries: `src/server/CONTEXT.md`.
- Python document/retrieval/study/Canvas jobs: `src/python/CONTEXT.md`.
- Historical Python migration evidence is owner-local and excluded from the shared repository.
- Retained hardened CLI transport: `src/core/CONTEXT.md` and `CORE-SOURCES.json`.
- Start and teammate handoff: `README.md`.
- Automated checks: `scripts/quality/run.mjs`; run `npm run check` and
  `npm run test:workflow` before completing changes. Normal `npm start`/`npm test`
  run static gates automatically. Source map: `architecture/Code Map.md`; interactive view: `architecture/Explorer.html`.

Do not import the main Atlas application, its accounts, environment files, database, saved notebooks, release machinery or unrelated features. New provider access must be explicit. No live Canvas writes or silent cloud sharing. Use original character assets, not approximate redesigns. Preserve each module's responsibility. No mandatory model download.

The owner explicitly authorized reusing only their saved Canvas token on October 15. `scripts/reuse-owner-canvas.mjs` is a one-time, exact-owner provisioning tool; runtime loads only its private Canvas configuration. This does not authorize transferring other Atlas credentials or collecting teammates' tokens.
