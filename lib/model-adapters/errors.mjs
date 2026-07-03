// Model-protocol error classes. Surface provider failures with a stable
// shape regardless of which adapter raised them — callers shouldn't need
// to special-case Anthropic 529s vs OpenAI 5xx vs Gemini RPC errors.
//
// Spec: architecture/03-ai-ml/MODEL_PROTOCOL.md §9 AC-MP-10.

export class ModelProviderError extends Error {
  constructor({ provider, model, status, message, cause } = {}) {
    super(message || `Model provider ${provider} failed (status=${status ?? '?'})`);
    this.name = 'ModelProviderError';
    this.provider = provider;
    this.model = model;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

// Thrown by the dispatcher's structured-output ladder when a caller asked
// for structured output (req.responseSchema / req.structuredOutput) but the
// model's reply could not be coerced into a JSON value — even after the
// prompt-rung re-ask. The contract: callers get a valid object OR this
// typed error, never silent prose.
export class StructuredOutputError extends Error {
  constructor({ provider, model, text, message } = {}) {
    super(message || `Structured output could not be parsed from ${provider ?? '?'}/${model ?? '?'} response.`);
    this.name = 'StructuredOutputError';
    this.provider = provider ?? null;
    this.model = model ?? null;
    // A trimmed sample of the unparseable text, for debugging (bounded).
    this.raw_text = typeof text === 'string' ? text.slice(0, 1000) : null;
  }
}

export class NotImplementedError extends Error {
  constructor(message = 'Not implemented') {
    super(message);
    this.name = 'NotImplementedError';
  }
}
