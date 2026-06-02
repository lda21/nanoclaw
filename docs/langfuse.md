# Langfuse Tracing

NanoClaw can emit [Langfuse](https://langfuse.com) traces for every agent turn —
model, token usage, tool calls, and span hierarchy — to a Langfuse Cloud or
self-hosted instance.

## How it works

All LLM activity happens inside the per-session agent container (Bun runtime),
so all tracing lives there too. The host's only role is to pass credentials in
and make the Langfuse endpoint reachable from inside the container.

- **Claude provider** (default): instrumented with OpenInference's
  `ClaudeAgentSDKInstrumentation`. Model, tokens, tool calls, and nested spans
  are captured automatically from the `@anthropic-ai/claude-agent-sdk` stream.
- **Codex provider**: the Codex `app-server` runs out-of-process, so the
  provider records a manual generation span per turn (token usage best-effort).
- Each turn is wrapped in an `agent-turn` trace carrying `sessionId`
  (`<agentGroupId>:<threadId>`), `userId` (the sender), and tags
  (`<provider>`, `<channel>`, `<group>`).

Implementation: `container/agent-runner/src/tracing/index.ts` (the only module
that touches OpenTelemetry), wired from `providers/claude.ts`, `providers/codex.ts`,
`poll-loop.ts`, and `index.ts`. Host plumbing: `src/config.ts` + `src/container-runner.ts`.

## Enabling

Tracing is **auto-on**: set all three keys in `.env` and rebuild/restart. With
any missing, tracing is a complete no-op (zero overhead, no new failure modes).

```bash
LANGFUSE_PUBLIC_KEY="pk-lf-..."
LANGFUSE_SECRET_KEY="sk-lf-..."
LANGFUSE_BASE_URL="https://cloud.langfuse.com"   # or your self-hosted URL
```

Keys come from the Langfuse UI → Settings → API Keys. They are observability
credentials (not LLM credentials), so they ride in env rather than the OneCLI
vault. After editing `.env`, rebuild the image and restart the host:

```bash
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

## Optional settings

| Var | Effect |
|-----|--------|
| `LANGFUSE_TRACING_ENVIRONMENT` | Tags traces with an environment (e.g. `production`, `dev`). |
| `LANGFUSE_TRACE_REDACT_CONTENT` | `true` ⇒ collapse long input/output values to `[REDACTED:Nchars]`. Default off (single-operator personal assistant on its own instance). Turn on for shared/multi-tenant deployments. |
| `LANGFUSE_HOST_GATEWAY` | `true`/`false` to force mapping the Langfuse host to the Docker host gateway. Unset ⇒ auto (self-hosted names like `*.ts.net`, `*.local`, localhost, private IPs). |

**Credential scrubbing is always on**, regardless of `LANGFUSE_TRACE_REDACT_CONTENT`:
API keys, bearer tokens, and JWT-shaped strings are masked before export
(`maskData` in the tracing module).

## Self-hosted networking notes

Agent containers route API traffic through the OneCLI proxy and can't resolve
arbitrary hostnames. For a self-hosted Langfuse the host runner automatically:

- adds the Langfuse host to the container's `NO_PROXY` so trace export bypasses
  the OneCLI vault proxy and connects directly;
- maps the Langfuse hostname to `host-gateway` (for `*.ts.net` / `*.local` /
  localhost / private IPs, or when `LANGFUSE_HOST_GATEWAY=true`) so the name
  resolves to the Docker host where the instance listens. With a valid cert for
  that hostname (e.g. a Tailscale cert), TLS validates cleanly.

If the instance binds only to a specific interface and `host-gateway` can't
reach it, point `LANGFUSE_BASE_URL` at an address the container can reach.

## Verifying

```bash
# From inside an agent container (or one with the same --add-host/NO_PROXY):
curl -sS "$LANGFUSE_BASE_URL/api/public/health"
```

Then send a message to an agent and open the Langfuse UI: you should see an
`agent-turn` trace with the right session/user/tags and a nested generation
showing model + token usage.
