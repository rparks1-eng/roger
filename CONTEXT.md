# Atlas Reader project boundary

One job: let a student choose course material, read or listen to it, and ask source-grounded questions in a clean standalone interface.

Team: Brandon Parks, Gavin Aydelotte and Ansh Barmecha. Shared assignment remains the existing OneDrive Milestone I document; this folder does not replace or edit it.

## Include

A document library and connected Courses landing; local PDF/text and text-only PPTX import; original PDF canvas/text-layer viewing, page-linked highlights/notes and bounded text extraction; optional local Apple Vision OCR on this Mac; exact-source device narration; page-linked questions; keyword retrieval over explicitly opened documents; local Qwen or explicitly consented Codex; read-only Canvas courses/modules/assignments/pages and narrowly verified file downloads. Text/URL drafts can be reviewed, with live sends disabled by default.

## Exclude

Personal Atlas saved stories, Google/Supabase sign-in, Gmail, personal calendar, trading/research, file organization, computer-wide indexing, automatic training, browser history, arbitrary app control, production credentials and release code. Shared storage, Whisper, embedded annotated-PDF export, original-layout PPTX rendering and live Canvas submission parity are not implied by this build.

## Reuse contract

Import only independently bounded core modules through `scripts/import-atlas-core.mjs`. Record exact source and output hashes. The class project is a deliberate standalone snapshot; future parent changes require reviewed re-import, not a dependency on the entire app. Copy existing artwork and PDF.js vendor files with provenance through `scripts/prepare-assets.mjs`. No existing paths move and no personal records transfer.

## Human check

Open with the explicitly provisioned owner connection: show Courses, never a story. Without a connection show an empty library with clear import/Canvas actions. Open internal assignment instructions, import a course document, read the original, select/highlight text, run OCR on a scan, search text, stop narration, navigate pages, download notes/marks and ask only with a chosen provider. Verify real Canvas reads separately from intercepted tests. Review drafts without sending; live submission is not complete until explicitly approved exact payload and provider receipt are verified. A working local preview is not deployment or teammate authentication.
