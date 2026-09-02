// electron/llm/geminiModels.ts
//
// Gemini connection-probe helpers for Settings → AI Providers → Test Connection.
//
// Why not pin one model + generateContent: the probe used gemini-3.7-flash and
// reported failure when Google returned 503 ("high demand") or when a corporate
// SSL-inspection proxy (Netskope) added enough latency to hit the 15s timeout.
// A 503 or a slow round trip does NOT mean the key is bad — and the models list
// endpoint already succeeds in the same environment (see fetchProviderModels).
//
// THE QUESTION THE PROBE ANSWERS IS "was the key accepted?", not "did this one
// model generate a token right now?". GET /v1beta/models is lighter, does not
// depend on a hot model tier, and matches what Refresh uses to populate the
// picker.
//
// Platform note: pure HTTP classification. Identical on macOS and Windows.

/** Longer default for corporate proxies that add TLS-inspection latency. */
export const GEMINI_PROBE_TIMEOUT_MS = 30_000;

export type GeminiProbeVerdict = 'key-ok' | 'key-bad' | 'inconclusive';

export function classifyGeminiProbeError(err: any): GeminiProbeVerdict {
  const status = Number(err?.response?.status ?? err?.status ?? err?.statusCode ?? 0) || 0;
  const body = err?.response?.data;
  const message = [
    err?.message,
    typeof body === 'string' ? body : body ? JSON.stringify(body) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (status === 401 || status === 403 || status === 407) return 'key-bad';
  if (
    /api_key_invalid|invalid.*api[_ -]?key|permission_denied|permission denied|unregistered callers|forbidden|unauthor/.test(
      message,
    )
  ) {
    return 'key-bad';
  }

  // Billing / account disabled — key reached Google but the account cannot pay.
  if (/billing|failed_precondition.*billing|insufficient.*credit|payment required/.test(message)) {
    return 'key-bad';
  }

  // Overload on a generation call still proves auth succeeded; list-models rarely 503s.
  if (status === 503 || status === 529 || /high demand|overloaded|unavailable/.test(message)) {
    return 'key-ok';
  }

  if (status === 429 || status === 408) return 'inconclusive';
  if (err?.code === 'ECONNABORTED' || /timeout|timed out|etimedout/.test(message)) {
    return 'inconclusive';
  }

  return 'inconclusive';
}

function geminiErrorDetail(err: any): string | null {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    (typeof err?.response?.data === 'string' ? err.response.data : null) ||
    null
  );
}

/**
 * Probe whether a Gemini API key is accepted. Uses the models catalogue endpoint
 * (same as Refresh) instead of generateContent on a pinned hot model.
 */
export async function probeGeminiApiKey(
  apiKey: string,
  axios: { get: (url: string, config?: object) => Promise<{ status: number; data?: any }> },
  timeoutMs: number = GEMINI_PROBE_TIMEOUT_MS,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = (apiKey || '').trim();
  if (!trimmed) return { success: false, error: 'No API key provided' };

  try {
    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(trimmed)}`,
      { timeout: timeoutMs },
    );
    if (response.status === 200 && Array.isArray(response.data?.models) && response.data.models.length > 0) {
      return { success: true };
    }
    return { success: false, error: 'Unexpected response from Gemini API' };
  } catch (err: any) {
    const verdict = classifyGeminiProbeError(err);
    if (verdict === 'key-ok') return { success: true };
    if (verdict === 'key-bad') {
      return { success: false, error: geminiErrorDetail(err) || err?.message || 'Invalid API key' };
    }
    return {
      success: false,
      error:
        geminiErrorDetail(err) ||
        err?.message ||
        'Connection timed out or failed — check your network or proxy and try again.',
    };
  }
}
