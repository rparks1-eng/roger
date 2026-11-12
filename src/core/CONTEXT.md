# Hardened Codex CLI snapshot

One job: mediate explicitly enabled, consented, text-only Codex calls.

- `cli-protocol.ts`: fixed schema/arguments and bounded, deny-tools event parsing.
- `cli-runner.ts`: fixed executable discovery, isolated scratch, process cancellation.

These two snapshots remain server-only and retain SHA-256 provenance in
`../../CORE-SOURCES.json`. The import script allowlists only these two files.
The former retrieval/routing modules are removed; Python owns those jobs.
Nothing in this folder is served to the browser or imports personal Atlas state.
