# Python domain workers

One job: transform explicitly supplied document/study/Canvas data into bounded
results. No network, credentials, computer-wide indexing or persistent store.

- `presentation.py`: bounded PPTX ZIP/XML text extraction, binary stdin.
- `retrieval.py`: keyword passages, exact UTF-16 offsets, stable ranking.
- `study.py`: input/consent routing, study instructions and strict reply validation.
- `canvas_records.py`: course/assignment/module/page record normalization.
- `common.py`: shared string/JSON validation semantics.
- `worker.py`: fixed-operation JSON dispatch and best-effort Unix CPU/file limits.

Node adapters own HTTP authentication, credentials, provider network/CLI access,
admission, wall deadlines, process killing and response-byte caps. Python
receives only the data needed for an allowlisted operation, not bearer tokens
or arbitrary paths/commands. Each process exits after one job. There are no
pip dependencies, model downloads or automatic cloud fallbacks.

Configure an absolute Python executable via `READER_PYTHON`; default is
`/usr/bin/python3`. Use Python 3.9+ (3.12 is selected for this owner's preview).
PDF/text viewing and device speech still work without Python. PPTX import,
library retrieval, AI policy checks and connected Canvas normalization require it.
Process limits are not an OS sandbox. Do not add provider authority here.

Human check: open/read a source, search the library, follow a returned passage,
ask a consented question, and verify real course instructions. A failed worker
must give a bounded error and leave the next request usable. Run the Python
suite and Node process/HTTP/browser regressions before promotion.

`app_changes.py` is a separate fixed CLI for local browser-source transactions, not
a model-callable general file tool. Server-selected roots and an exact path
allowlist are enforced with no-follow directory descriptors, owned regular files,
byte limits, a private lock/journal, baseline hashes, atomic file replacements and
interrupted-write rollback. It never executes generated code. One prior change is
retained; newer source edits block Undo. POSIX only (macOS/Linux).
