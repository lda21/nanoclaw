/**
 * Langfuse tracing for the agent-runner.
 *
 * Self-hosted/Cloud Langfuse observability for every agent turn. This is the
 * ONLY place that knows about OpenTelemetry; the rest of the runner talks to
 * the small surface exported here (`withTrace`, `getClaudeQuery`,
 * `startCodexGeneration`, `flushTraces`, `shutdownTracing`).
 *
 * ## Enablement
 *
 * Tracing turns on iff all three `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
 * / `LANGFUSE_BASE_URL` env vars are present (injected by the host at container
 * spawn — see `src/container-runner.ts`). With any missing, every export here
 * is a no-op: zero overhead, zero new failure modes. Setup errors are caught
 * and downgrade to disabled — tracing must NEVER take the agent down.
 *
 * ## Bun
 *
 * The runner runs on Bun. We deliberately avoid `@opentelemetry/sdk-node`'s
 * `NodeSDK` (its `beforeExit` auto-shutdown lifecycle is unreliable here and we
 * flush explicitly anyway) and use a plain `NodeTracerProvider`. The Claude
 * Agent SDK is patched via OpenInference's `manuallyInstrument()` rather than
 * auto-instrumentation import hooks, which don't fire reliably on Bun.
 *
 * ## Provider coverage
 *
 * - **claude**: `getClaudeQuery()` returns the instrumented SDK `query`, so the
 *   OpenInference instrumentation auto-captures model, tokens, tool calls, and
 *   span hierarchy.
 * - **codex**: uses a separate `codex app-server` the instrumentation can't
 *   see, so the provider opens a manual generation span via
 *   `startCodexGeneration()`.
 *
 * Both nest under the per-turn `withTrace()` root created by the poll loop.
 */
import * as ClaudeAgentSDKModule from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { LangfuseSpanProcessor, isDefaultExportSpan, type ShouldExportSpan } from '@langfuse/otel';
import { propagateAttributes, startActiveObservation, startObservation } from '@langfuse/tracing';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

function log(msg: string): void {
  console.error(`[tracing] ${msg}`);
}

// ── Configuration ────────────────────────────────────────────────────────────

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
const BASE_URL = process.env.LANGFUSE_BASE_URL;

/**
 * When true, blanket-redact long attribute values to `[REDACTED:Nchars]` in
 * addition to the always-on credential scrub. Off by default: this is a
 * single-operator personal assistant talking to its own (often self-hosted)
 * Langfuse, where seeing message content is the whole point. Flip on for
 * shared/multi-tenant deployments where prompt/response content is sensitive.
 */
const REDACT_CONTENT = process.env.LANGFUSE_TRACE_REDACT_CONTENT === 'true';
const REDACT_CONTENT_THRESHOLD = 24; // chars; short values (ids, names) stay readable

const OPENINFERENCE_SCOPE = '@arizeai/openinference-instrumentation-claude-agent-sdk';

// ── Masking ──────────────────────────────────────────────────────────────────

// Credential shapes that must never reach Langfuse, even on a private instance.
// Scrubbed from every exported attribute value regardless of REDACT_CONTENT.
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-***'],
  [/sk-lf-[A-Za-z0-9-]{8,}/g, 'sk-lf-***'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-***'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, 'Bearer ***'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, '***JWT***'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh***'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***'],
];

/**
 * Mask hook for `LangfuseSpanProcessor`. Receives the stringified value of a
 * maskable attribute (input/output/metadata) and returns the scrubbed value.
 * Always scrubs credentials; optionally collapses long values when
 * REDACT_CONTENT is set.
 */
function maskData({ data }: { data: unknown }): unknown {
  let s = typeof data === 'string' ? data : safeStringify(data);
  for (const [re, replacement] of CREDENTIAL_PATTERNS) s = s.replace(re, replacement);
  if (REDACT_CONTENT && s.length > REDACT_CONTENT_THRESHOLD) {
    return `[REDACTED:${s.length}chars]`;
  }
  return s;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let processor: LangfuseSpanProcessor | undefined;
let provider: NodeTracerProvider | undefined;
let instrumentedQuery: typeof ClaudeAgentSDKModule.query | undefined;

/** True once OTel + the Langfuse processor + SDK instrumentation are wired. */
export let tracingEnabled = false;

if (PUBLIC_KEY && SECRET_KEY && BASE_URL) {
  try {
    // Export Langfuse-native spans (our withTrace/codex spans), gen_ai spans,
    // and the OpenInference Claude spans; drop everything else (OTel noise).
    const shouldExportSpan: ShouldExportSpan = ({ otelSpan }) =>
      isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope?.name === OPENINFERENCE_SCOPE;

    // `timeout` (default 5s) bounds export so a slow/unreachable Langfuse can't
    // wedge container shutdown past the host's heartbeat tolerance.
    processor = new LangfuseSpanProcessor({ mask: maskData, shouldExportSpan });

    provider = new NodeTracerProvider({ spanProcessors: [processor] });
    provider.register();

    // Patch the Claude Agent SDK in place. ESM namespace objects are frozen,
    // so copy first, instrument the copy, and hand its `query` to the provider.
    const instrumentation = new ClaudeAgentSDKInstrumentation();
    const sdkCopy = { ...ClaudeAgentSDKModule } as typeof ClaudeAgentSDKModule;
    instrumentation.manuallyInstrument(sdkCopy);
    instrumentedQuery = sdkCopy.query;

    tracingEnabled = true;
    log(`Langfuse tracing enabled (base=${BASE_URL}${REDACT_CONTENT ? ', content redacted' : ''})`);
  } catch (err) {
    log(`init failed, continuing WITHOUT tracing: ${err instanceof Error ? err.message : String(err)}`);
    tracingEnabled = false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * The Claude Agent SDK `query` to call. Instrumented when tracing is enabled,
 * otherwise the raw SDK export. The claude provider uses this instead of
 * importing `query` directly so the OpenInference patch is guaranteed applied.
 */
export function getClaudeQuery(): typeof ClaudeAgentSDKModule.query {
  return instrumentedQuery ?? ClaudeAgentSDKModule.query;
}

export interface TurnTraceAttributes {
  sessionId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  /** Turn input (the formatted prompt). Set on the root observation. */
  input?: unknown;
  /** Optional trace name override (defaults to the observation `name`). */
  traceName?: string;
}

/**
 * Wrap one agent turn in a Langfuse trace. The provider's streaming child spans
 * (Claude auto-spans, the Codex generation span) inherit this active context.
 * No-op passthrough when tracing is disabled.
 */
export async function withTrace<T>(
  name: string,
  attrs: TurnTraceAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled) return fn();
  return startActiveObservation(name, async (span) => {
    if (attrs.input !== undefined) span.update({ input: attrs.input });
    return propagateAttributes(
      {
        userId: attrs.userId,
        sessionId: attrs.sessionId,
        tags: attrs.tags,
        metadata: attrs.metadata,
        traceName: attrs.traceName,
      },
      fn,
    );
  });
}

export interface CodexGenerationUsage {
  input?: number;
  output?: number;
  total?: number;
}

/** Handle for a manually-opened Codex generation span. */
export interface CodexGenerationHandle {
  end(result: { output?: unknown; usage?: CodexGenerationUsage }): void;
}

/**
 * Open a generation span for a Codex app-server turn. Nests under the active
 * `withTrace` root. No-op handle when tracing is disabled.
 */
export function startCodexGeneration(args: { model?: string; input?: unknown }): CodexGenerationHandle {
  if (!tracingEnabled) return { end: () => {} };
  const generation = startObservation(
    'codex-generation',
    { model: args.model, input: args.input },
    { asType: 'generation' },
  );
  return {
    end: ({ output, usage }) => {
      try {
        generation.update({
          output,
          usageDetails: usage ? { input: usage.input ?? 0, output: usage.output ?? 0 } : undefined,
        });
      } catch (err) {
        log(`codex span update failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        generation.end();
      }
    },
  };
}

/**
 * Flush buffered spans. Bounded by `timeoutMs` and wrapped so a Langfuse outage
 * can never block the agent turn or mask an agent error. Called after each turn
 * and on shutdown.
 */
export async function flushTraces(timeoutMs = 5000): Promise<void> {
  if (!tracingEnabled || !processor) return;
  try {
    await Promise.race([processor.forceFlush(), delay(timeoutMs)]);
  } catch (err) {
    log(`flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Final flush + shutdown. Called from the runner's signal handlers. */
export async function shutdownTracing(timeoutMs = 5000): Promise<void> {
  if (!tracingEnabled || !provider) return;
  try {
    await Promise.race([provider.shutdown(), delay(timeoutMs)]);
  } catch (err) {
    log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
