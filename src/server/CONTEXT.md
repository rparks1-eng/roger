# Local HTTP and authority boundary

One job: serve the Reader and mediate bounded operations with explicit authority.

`index.mjs` binds only 127.0.0.1. `http.mjs` maps fixed assets/routes.
`security.mjs` enforces Host/session/Origin/CSRF, body/time/rate/admission budgets.
`owner-canvas.mjs` reads only the private, permission-checked owner Canvas
configuration. Runtime never reads personal Atlas environments or databases.

`python-domain.mjs` launches only the fixed Python dispatcher with a scrubbed
environment, allowlisted operation and JSON stdin. It permits two concurrent
jobs, a 10-second wall deadline, operation-specific input caps and 2 MiB stdout.
Cancellation/overflow kills the child and keeps admission claimed until close.
`retrieval.mjs` is its library-search adapter. The POST retrieval route requires
session, Origin and CSRF, accepts at most 2 MiB, and never reads filesystem paths.
Python owns keyword indexing/ranking, study policy/validation and Canvas records.

`canvas.mjs` retains credential checks and fixed-origin bounded network reads,
pagination and fallback fanout, delegating only raw records to Python without
tokens. `canvas-download.mjs` retains the verified file-host/redirect boundary.
`study.mjs` retains bounded fixed-loopback Ollama transport and the separately
gated Codex CLI call. Python prepares the study policy and validates the reply.
Codex stays disabled unless the process explicitly opts in and the user consents.
No model receives file/command/provider authority. No automatic cloud fallback.

`submissions.mjs` retains exact-content, expiry, connection-binding, single-use
claim and receipt checks. Live writes remain disabled in the entry point.
File uploads, discussion/LTI/pledge/group submissions are not implemented.

`document-processing.mjs` retains native Apple Vision OCR unchanged, plus the
thin PPTX adapter. `python-presentation.mjs` owns its fixed binary-stdin Python
process: 12 MiB input, 1 MiB output, one slot and 10-second wall limit. The old
JavaScript ZIP/XML parser is gone. See `../python/CONTEXT.md` for ownership.
Neither worker extracts archives, runs uploaded code or loads owner state.
No server/core/Python source file is a public static asset.

Human check: hostile Host/origin, missing CSRF, oversized input, concurrent or
cancelled jobs and stale sessions fail closed. Preview is not public deployment,
teammate OAuth, full Canvas parity or verified live submission support.

`connections.mjs` mediates explicitly selected session-only AI access through the
installed official Codex CLI or fixed provider API origins. `builder.mjs` persists
versioned generated frontend tools, with owner-bound expiring previews. The HTTP
layer serves these only into sandboxed iframes with a separate restrictive CSP;
no generated code runs in Node or the parent app. Session expiry and server close
dispose connection services. See Engineering Checks.md for current evidence.

`memory.mjs` owns private local conversation persistence, explicit preferences, exact course/assignment retrieval, paginated inspection, pause/export/deletion and capacity failure. Runtime injects disk storage; fixture servers default to in-memory storage. `appearance-builder.mjs` validates a declarative appearance; `web-resources.mjs` uses fixed Open Textbook Library and Google Books endpoints to return free full-text options; `course-export.mjs` creates explicitly partial course snapshots. No generated code receives these capabilities directly.

`app-changes.mjs` builds exact source edits through the selected connection, formats
and checks candidate browser code without executing it, and captures fixed public
assets for `app-preview.mjs`. Preview uses localhost; the live entry redirects to
127.0.0.1, separating cookies and storage. Preview APIs contain sample data only
and reject all mutations. Its CSP restricts subresources; top-level navigation is
not claimed to be fully confined. No personal data or credentials enter preview.
The authenticated Apply route requires an opened, owner-bound draft and explicit
confirmation. Fixed Python `app_changes.py` owns allowlisted source transactions,
exact-hash conflicts and a private crash-recovery journal. No generated server code
executes. `app-recovery.mjs` serves immutable recovery controls outside editable
source. Changes become actual browser code only after Apply, not automatically
published or deployed. Secure file transactions currently require macOS/Linux.
