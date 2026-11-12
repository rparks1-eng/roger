// Protocol validation is dependency-free so it can be regression-tested without
// provider access. It does not authorize tools or execute generated output.
export const CODEX_STUDY_LIMITS = { inputBytes: 65_536, outputBytes: 160_000, lineBytes: 32_768, timeoutMs: 70_000, killAfterMs: 2_000 } as const;
export const CODEX_STUDY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["reply", "passages", "question"],
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 1600 },
    passages: { type: "array", maxItems: 1, items: { type: "object", additionalProperties: false,
      required: ["quote", "note"], properties: { quote: { type: "string", minLength: 1, maxLength: 160 }, note: { type: "string", minLength: 1, maxLength: 300 } } } },
    question: { type: "string", minLength: 1, maxLength: 240 },
  },
} as const;
const DISABLED = ["shell_tool", "apps", "plugins", "multi_agent", "multi_agent_v2", "browser_use", "computer_use", "code_mode", "code_mode_only", "code_mode_prewarm", "code_mode_host", "image_generation", "memories", "chronicle", "hooks", "unbounded_connection_retries", "daemon_auto_start", "view_image", "tool_suggest", "in_app_local_automation"];
export function codexStudyArgs(schemaPath: string): string[] {
  return ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--enable", "skip_host_skill_discovery",
    ...DISABLED.flatMap(feature => ["--disable", feature]), "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "-c", "suppress_unstable_features_warning=true", "--output-schema", schemaPath, "--json", "--color", "never", "-"];
}

export function createStudyEventReader() {
  let bytes = 0, buffer = "", final = "", complete = false, failed = false, started = false, disabledHostNotice = false;
  function line(raw: string) {
    if (!raw.trim()) return;
    if (Buffer.byteLength(raw) > CODEX_STUDY_LIMITS.lineBytes) throw new Error("oversized");
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw); } catch { throw new Error("output"); }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") throw new Error("output");
    if (!["thread.started", "turn.started", "item.started", "item.updated", "item.completed", "turn.completed", "turn.failed", "error"].includes(event.type)) throw new Error("output");
    if (event.type === "turn.failed" || event.type === "error") { failed = true; throw new Error("unavailable"); }
    if (event.type === "turn.started") started = true;
    if (event.item !== undefined) {
      const item = event.item as Record<string, unknown>;
      if (item && item.type === "error") {
        // This CLI build emits its deliberately disabled Code Mode host as an
        // error-shaped startup notice, then completes ordinary text-only turns.
        // Ignore only this exact pre-turn notice once; never enable its host or
        // ignore a model/provider error after the turn starts.
        if (!started && !complete && !disabledHostNotice && item.message === "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.") {
          disabledHostNotice = true; return;
        }
        const message = String(item.message ?? "").toLowerCase();
        const providerFailure = /usage|quota|rate.limit|credit|limit.*reach/.test(message) ? "account-limit"
          : /auth|sign.in|token|credential|401/.test(message) ? "authentication"
          : /model|feature|config|unsupported|unknown/.test(message) ? "configuration"
          : /network|connect|tls|certificate|fetch|stream/.test(message) ? "transport" : "provider-error";
        throw Object.assign(new Error("unavailable"), { providerFailure });
      }
      // Deny every tool type, including future types unknown to this adapter.
      if (!item || typeof item !== "object" || !["agent_message", "reasoning"].includes(String(item.type))) {
        const itemType = item && /^[a-z_]{1,48}$/.test(String(item.type)) ? String(item.type) : "unknown";
        throw Object.assign(new Error("tool"), { rejectedItemType: itemType });
      }
      if (event.type === "item.completed" && item.type === "agent_message") {
        if (complete || typeof item.text !== "string" || final) throw new Error("output");
        final = item.text;
      }
    }
    if (event.type === "turn.completed") {
      if (complete) throw new Error("output");
      complete = true;
    }
  }
  return {
    push(chunk: string) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > CODEX_STUDY_LIMITS.outputBytes) throw new Error("oversized");
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (Buffer.byteLength(buffer) > CODEX_STUDY_LIMITS.lineBytes) throw new Error("oversized");
    },
    finish(): unknown {
      if (buffer.trim()) line(buffer);
      buffer = "";
      if (!complete || failed || !final) throw new Error("output");
      try { return JSON.parse(final); } catch { throw new Error("output"); }
    },
  };
}
