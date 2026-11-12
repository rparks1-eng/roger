# Document workflow

One job: render the student's explicitly opened material and study controls.

Inputs: selected local files, read-only Canvas response records, session-protected Python retrieval endpoint. Never load personal Atlas notebooks or credentials from another app.

`documents.mjs` extracts bounded source pages with cancellation and a 30-second deadline. `pdf-workspace.mjs` renders the original PDF with a selectable text layer, exact page-local selection offsets and normalized highlight rectangles. `speech.mjs` owns local-only narration lifecycle. `api.mjs` owns local session/CSRF HTTP and bounded document uploads. `canvas-ui.mjs` owns Canvas course presentation, internal assignment/page details and stale-request cancellation. Rich Canvas instructions are parsed inertly and rebuilt through a bounded element allowlist; scripts, styles, active images and executable attributes are never inserted. Other source text uses textContent. `submission-ui.mjs` owns draft review and a separately gated confirmation, never automatic sends. `app.mjs` connects those modules to the HTML controls, OCR and slide-text imports.

Outputs: in-memory library, original-page view, bounded question context, notes Markdown and page-annotation JSON exports. Annotation JSON does not modify/embed marks into a PDF. OCR updates extracted text only, not original bytes. PowerPoint support is slide text only; export the slides to PDF to retain their visual layout. Reload clears the library, marks and notes; no silent cloud storage. A student must review extracted text before relying on it, especially OCR scans and complex layouts.

Human check: blank launch, import, page navigation, source evidence, read/stop, provider consent, disconnect and failure messages. Phone and desktop layouts must remain usable.

`roger-widget.mjs` owns the draggable/hover companion presentation.
`connections-ui.mjs` owns provider selection and explicit connection consent.
`builder-ui.mjs` owns generated previews, saved-tool navigation, revisions and
undo; generated code runs only in an opaque-origin iframe. Leaving the workspace
cancels generation and removes the iframe. App controls keep their existing
validated customization path; generated tools never modify the parent DOM.

`roger-navigation.mjs` resolves verified course/assignment labels without model-invented destinations. `memory-ui.mjs` owns history inspection, resume and explicit preferences. `canvas-display.mjs` owns status/calendar/cache helpers; `customization-drawer.mjs` preserves the current page. `appearance-preview.mjs` applies validated colors and decorative motion with preview/undo; `resources-ui.mjs` renders catalog evidence. Global Ask saves its conversations/receipts; separate reader/study-panel histories are not yet unified.
