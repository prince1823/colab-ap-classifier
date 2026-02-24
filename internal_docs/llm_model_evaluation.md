# LLM Model Evaluation — Issue #80

**Date:** 2026-02-22

## Current Configuration

- **Default model:** `claude-3-5-haiku-latest` (Anthropic)
- **Default provider:** `anthropic` (also supports `openai`, `openrouter`)
- All 4 agents share one model — no per-agent override

## Agent Cost Profile

| Agent | Complexity | Call Frequency | Cost Impact |
|-------|-----------|----------------|-------------|
| Classification | High | Per invoice group (100s per run) | **Dominant cost driver** |
| Research | High | Per unique supplier (batches of 5) | Moderate |
| Feedback | High | Per reclassification (user-triggered) | Low |
| Canonicalization | Medium | Once per CSV upload | Negligible |

All agents use `temperature: 0`, `maxTokens: 4096`, system+user two-part prompts.

## Pricing Comparison (per 1M tokens, USD)

### Anthropic

| Model | Input | Output | Relative to Haiku 3.5 |
|-------|-------|--------|----------------------|
| Claude Haiku 3.5 | $0.80 | $4.00 | 1x (current default) |
| Claude Haiku 4.5 | $1.00 | $5.00 | 1.25x |
| Claude Sonnet 4 | $3.00 | $15.00 | 3.75x |

### OpenAI

| Model | Input | Output | Relative to Haiku 3.5 |
|-------|-------|--------|----------------------|
| GPT-4.1-nano | $0.10 | $0.40 | 0.10x |
| GPT-4o-mini | $0.15 | $0.60 | 0.15x |
| GPT-4.1-mini | $0.40 | $1.60 | 0.40x |
| GPT-4.1 | $2.00 | $8.00 | 2.0x |
| GPT-4o | $2.50 | $10.00 | 2.5x |

### OpenRouter

No markup on token prices. 5.5% fee on credit purchases. Provides access to both Anthropic and OpenAI models via one API key.

## Considerations

### Why Haiku 3.5 works well
- Response parsing is battle-tested against Haiku output patterns
- Good balance of cost and quality for structured JSON extraction
- Reliable JSON adherence at temperature 0

### Why GPT-4o-mini / GPT-4.1-nano are cheaper but riskier
- 5-10x cheaper than Haiku 3.5
- Known parsing issues: inverted mappings, array-wrapped values (already mitigated in code)
- GPT-4.1-nano is newest/cheapest but untested with our prompts

### Reasoning models (o3-mini, o4-mini) are overkill
- $1.10/$4.40 — similar cost to Haiku but designed for multi-step reasoning
- Our prompts are structured extraction, not open-ended reasoning
- No benefit over Haiku for classification tasks

## Decision

**TBD** — pending evaluation run with candidate models against `innova_test` dataset.

### Next Steps

1. Run `pipeline-run.test.ts` with Haiku 3.5 (baseline) and GPT-4.1-mini (candidate)
2. Compare classification accuracy and cost
3. Update `settings.ts` model list to include newer models (GPT-4.1 series, Haiku 4.5)
4. Update `backend_spec.md` LLM Provider Configuration table
5. Update `.env.example` if default model changes
