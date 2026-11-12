# Roger

Roger is a local study workspace: connect a course, read its materials, ask cited questions, and build small interactive tools around the way you study. It is a classroom prototype, not an official Canvas or college service.

## Run locally

Use **Node 24** and **Python 3.9 or later**. From this project folder:

```sh
npm run setup
npm start
```

Open [Roger](http://127.0.0.1:3847/). The server binds to loopback only. Setup installs pinned development tools inside the project; it does not connect accounts or download AI models. `npm start` checks formatting, lint, architecture, source provenance, and the generated map before starting.

If the system Python is unsuitable, set `READER_PYTHON` to the absolute path of a supported interpreter. Development setup uses `READER_SETUP_PYTHON` when supplied. The direct `node src/server/index.mjs` entry bypasses development checks and is intended for debugging.

For recordings, turn on **Settings → Demo mode**. With Canvas connected, the
demo reads the live course list, assignments, modules and syllabus matches. It
shows aliases, generated dates and submission statuses, and sample text. The
browser receives masked records on a separate origin. Original file contents,
Canvas links and IDs, account names, and saved conversations stay out of that
view. Source counts and available sections can still reflect the live course.
**Ask Roger** cites the masked syllabus or assignment when available. Turn off
the same switch to return to your private workspace. Without a Canvas connection,
the switch opens fictional classes, as does `npm run demo`.

On **Today**, open **Find books**, **News & research**, or **Student tools**.
Student tools includes a BA II Plus-style financial calculator, weighted grades,
a Babson undergraduate semester GPA estimator, a final-grade target calculator,
and a venture break-even calculator.
The financial keypad supports TVM, amortization, cash flows, memory, and the 2nd-key worksheets.
The tools run in the browser and are available in Demo mode. Search for
`Pride and Prejudice` in Demo mode to show a sample free-book result.

## Connect your services

Open **AI connections** and choose a provider:

- **Codex:** use the official Codex account signed in on this computer, or open its official sign-in. Connecting Roger does not give it the history of your Codex chats.
- **OpenAI, Claude, Gemini, or Grok API:** provide that service's API key and select an available model. API access and billing are separate from consumer chat subscriptions. [Anthropic's Claude Code authentication policy](https://code.claude.com/docs/en/legal-and-compliance) explains which integrations can use a subscription.

Connections require an explicit choice. API keys stay in server memory and are cleared on disconnect, session expiry, or restart. Codex has been exercised against a real account; the other provider transports have synthetic integration tests. A provider may reject a listed model for account, endpoint, or usage-limit reasons. Roger does not silently switch providers.

The Canvas adapter targets **Babson Canvas**. Once Babson approves a read-scoped
developer key, **Settings → Sign in with Babson Canvas** opens the official
Canvas login and returns to the course list after consent. Configure
`READER_CANVAS_OAUTH_CLIENT_ID`, `READER_CANVAS_OAUTH_CLIENT_SECRET`,
`READER_CANVAS_OAUTH_REDIRECT_URI`, and the approved space-separated
`READER_CANVAS_OAUTH_SCOPES` on the server. The registered callback for the
default local port is `http://127.0.0.1:3847/api/canvas/oauth/callback`.
The requested scopes must match the school's approved GET routes for the
features in use, including the profile endpoint. OAuth access and refresh
tokens stay in the local server session. **Local developer setup** retains the
manual token field for one's own institution-authorized tests.
[Canvas developer key requirements](https://developerdocs.instructure.com/services/canvas/oauth2/file.developer_keys)

## Study and read

- **This Semester** shows courses in the selected Canvas term. **All Assignments** combines their deadlines and submission-status records. Other accessible terms remain available.
- **Announcements**, **Discussions**, and **Groups** open inside the course. Roger shows available messages and threaded replies under your Canvas permissions. If Canvas requires an initial post, use the original topic in Canvas.
- **Syllabus** searches accessible syllabus pages, modules, pages, and file listings. Grading and office-hour excerpts link to their source; PDF citations open the cited page. Discovery can be partial, and alternate candidates remain visible.
- **Study** starts from course materials and past assignments. **Plan from the syllabus** identifies exam mentions, maps explicit chapter coverage and course-topic headings to materials, explains matches, and names missing sources. An unstated exam scope remains unknown; broad course review is labeled accordingly.
- Any number of available course sources may be selected. Same-course documents linked inside selected pages or assignment instructions are also discovered, deduplicated, and read. Add text or a transcript to an external course link or video to include it in study. Roger cites the link and any supplied timestamps. Unavailable material is identified in the source list.
- Practice formats include flashcards, short-answer questions, multiple choice, true/false, cited discussion prompts, and editable percentage worksheets. Discussion responses export as text, and worksheets export as CSV with formulas and source evidence. These are small practice sets. Existing local AI is optional.
- The reader displays original PDFs with selectable text, highlights, notes, and page citations. TXT/Markdown and supported Word study text are readable. PPTX import extracts slide text, not the original visual layout. Notes and annotations can be exported without changing the original PDF.
- **Today** shows the next assignment, a countdown, the local due time, and current classes. Canvas connection controls live in Settings. **Readings** opens your selected files for reading, listening, and notes.
- **Plan time** imports an ICS calendar or manual busy times and finds study slots before Canvas deadlines. Calendar data stays in the browser. Optional desktop reminders require browser permission and a visible Roger tab.
- **Find Books** searches Project Gutenberg, the Open Textbook Library, and eligible Google Books downloads. It covers literature and nonfiction as well as textbooks. Search links carry the query to Anna’s Archive, whose index includes LibGen collections, and to other book catalogs. **News & research** links to publishers, market data, and campus access guides.
- **Course export** downloads a JSON or Markdown snapshot of the assignment/module index, syllabus discoveries, coverage, and file references. Choose **ZIP with original files** to include supported files your account can open. The ZIP includes a manifest of omitted files and reasons. Canvas IMS packages and external transcripts remain separate.

The extraction pipeline has explicit document, text-memory, and request budgets. Progress, cancellation, and coverage notes explain partial results. Syllabus/readings use a five-minute cache bounded to 128 entries and 32 MiB. Refresh or reconnect to invalidate cached course data.

## Ask Roger and customize

The paw opens a compact assistant on hover or click. Drag its paw or grip within the app; arrow keys move the focused control, and Escape closes it. Position persists in the browser. It is not a system-wide desktop pet.

Connected questions can use cited excerpts from open readings. **Your tools** turns requests into actual self-contained HTML/CSS/JavaScript previews. Test a preview, request revisions, keep it, reopen it later, or undo a saved revision. Tools run in isolated frames without account, parent-page, filesystem, network-API, or server access. Saved tool code survives reload; data entered inside a tool is temporary unless an explicitly supported export says otherwise. This interface does not rewrite Roger's server or install arbitrary software.

**Change app** in Roger’s paw edits actual browser-app source: existing pages, navigation, layout and integrated features. Describe the change, open the whole-app preview, try it, then explicitly Apply or Discard. The preview uses sample courses on a separate localhost origin; it cannot connect real accounts, invoke AI or submit assignments. Reviewed edits are formatted and JavaScript is syntax/lint checked before preview. Applying writes the reviewed source files; reload to use them. Undo restores one previous applied change and refuses to overwrite newer edits. [Recovery controls](http://127.0.0.1:3847/app-recovery) work even when the editable interface breaks. Source edits support macOS/Linux; server/authentication/dependency changes and Windows source transactions are not supported. This is local source editing, not automatic deployment or GitHub publication.

The chosen AI receives the request and bounded excerpts of editable application source. No course cache, uploaded documents, account configuration or keys are collected for this request. Previews expire after twenty minutes. The private `.roger-changes/` rollback journal is excluded from Git. To restore without the web interface, from this checkout run `printf '{}' | python3 src/python/app_changes.py "$PWD" undo` (close active editing first).

Appearance opens a compact color editor: drag the color wheel, adjust hue/saturation/brightness, or enter an exact hex color for accents, backgrounds, cards and text. Manual changes save locally without AI and support undo. Ask Roger for broader appearance changes to preview before keeping them. Voice controls offer supported app changes directly. Editable custom text pages and appearance preferences are stored in the browser. Provider requests disclose the context being sent; feature generation does not automatically include course readings.

Four narration presets—Clear, Warm, Calm, and Bright—have preview controls. Device speech uses installed local voices. Natural Kokoro narration and Apple Vision OCR are optional integrations with reviewed local helpers; a fresh checkout does not provision those helpers. Missing capabilities are reported, and natural-voice failure does not silently switch engines.

## Storage and boundaries

**Conversations & memory** stores connected course conversations and completed questions about device-selected readings. Each reading has its own history. Citations reopen the source page or section if the saved revision is available. You can inspect, resume, pause, export, or delete conversations and pin preferences. Reading history stays out of general recall and provider prompts. The database reports when it reaches its storage budget.

Files you select in **Readings**, including supported files in a selected folder, are saved with notes, PDF highlights, and the last page in the current browser profile. Removing a reading removes its saved copy and edits. Clearing browser data also removes them, so export work you need to keep elsewhere. Canvas readings stay in the connected session. Practice sets are session data. Saved generated tools and the optional conversation-memory store belong to the app’s private local data directory, outside the repository. Keep that directory, credentials, course downloads, and private conversation exports out of Git.

Live Canvas submissions are disabled. Draft review is not submission. File-upload, discussion, group, pledge, and external-tool submission parity are unfinished. External/LTI content may require Canvas. Automatic whole-computer indexing, teammate hosting, and unrestricted app self-modification are not provided.

## Development checks

```sh
npm run format
npm run map
npm run check
npm run test:workflow
```

The full check covers JavaScript/Python tests, formatting, lint, architecture, and provenance. Browser checks require an installed supported Chrome/Chromium; `READER_BROWSER_CHANNEL` selects its channel. Tests use synthetic materials and intercepted provider responses unless explicitly labeled as a live check.

Python owns document and study-domain transformations. JavaScript owns the browser, local HTTP service, and provider boundaries. Generated code is never executed by the server. Start with [AGENTS.md](AGENTS.md) and the module context files for ownership; [the architecture map](architecture/Explorer.html) shows source relationships. `CORE-SOURCES.json` and `ASSET-SOURCES.json` record snapshot provenance. Vendored PDF.js retains its Apache 2.0 license in `public/vendor/PDFJS-LICENSE.txt`.
