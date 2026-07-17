# Best practices

How to get a signal you can trust out of this harness. Each item is a real tradeoff, not a
strawman — the default is defensible; these are the cases where a different setting pays off. Line
references are to the current tree.

## 1. Point the judge at a different model than the source

The CLI wires the *same* `llm` as both source and judge (`packages/cli/src/cli.ts:183`:
`coverage(createModelKnowledgeSource(llm), createJudge(llm), …)`). That is fine for the alarm you
most care about — `canaryBiteRate` rides only on a refuse-vs-answer classification, which the code
deliberately keeps model-light and heuristic-backed (`judge.ts`, `REFUSAL_RE`). It is **not** fine
for `groundedRate`, `inconsistencyRate`, or `validate`'s stance calls: those are the judge grading
prose, and when judge == source a confabulator grades its own confabulation.

- **Evidence.** LLM-as-judge work (Zheng et al., *Judging LLM-as-a-Judge*, MT-Bench, 2023) measures
  a *self-enhancement bias* — models score their own outputs materially higher than a third party
  scores them (≈10 points of win-rate in their setup). Self-grading systematically inflates
  `groundedRate` and depresses `inconsistencyRate`.
- **Do.** For any run whose grounded/consistency numbers you'll quote, construct `createJudge` with a
  separate, stronger `Llm`. **Tradeoff:** a second backend/API cost. If you only read the canary
  rate, skip it — that number was designed to survive a weak or self-grading judge.

## 2. Treat `schemaEnforced: false` runs as provisional

Every verdict is Zod-validated *after* the call and falls back to a string heuristic on failure —
Jaccard ≥ 0.3 for agreement, a regex for refusal (`judge.ts`). Those fallbacks are recorded in
`warnings()` and surfaced in the report's `caveats`, but the numbers still change under you.

- **Evidence.** Grammar-/schema-constrained decoding produces valid structured output ~100% of the
  time by construction; prompt-only "please return JSON" does not, and the gap is largest exactly on
  the smaller local models this harness targets. The harness's own fallback count is your local
  measurement of that gap — read it, don't assume it's zero.
- **Do.** Run `pnpm dev -- --check-schema` first and only trust grounded/consistency/stance numbers
  when it passes. **Tradeoff:** this narrows your backend choice to servers that actually enforce
  schemas (real constrained decoding, not `response_format` that 200s and ignores you).

## 3. Author ≥3 questions per topic, and keep `paraphrases` at 3

Coverage takes `questions.slice(0, paraphrases)` (`coverage.ts`), and consistency compares answers
*pairwise* — `k` responsive answers yield `k(k-1)/2` comparisons, with a topic flagged inconsistent
only when `agreement < 0.5`.

- **The numbers.** With `k = 2` there is exactly **1** comparison, so any single flaky disagreement
  drives agreement to 0 and trips the flag — noisy. With `k = 3` there are **3** comparisons and you
  need **2 of 3** to disagree, so one noisy pair (agreement 2/3) does *not* trip it. Going 2→3 costs
  +50% source calls but 3× the judge `agree` calls, and buys robustness against a single bad
  comparison rather than more raw detections — which is why 3 is the floor, not 5.
- **The trap.** A topic with fewer than 2 questions can *never* be flagged inconsistent: with ≤1
  responsive answer `consistency()` returns `1` unconditionally. `kb/topics/ondc/protocol.yaml`
  ships **2** questions, so at the default it uses both and has zero paraphrase headroom. Author at
  least 3 genuinely distinct phrasings per real topic or the self-consistency probe is silently off
  for it.

## 4. Budget canaries for resolution, not as a token gesture

`canaryBiteRate = (bitten canaries) / (total canaries)`. With **3** canaries the metric can only
take the values 0, 33, 67, 100% — one lucky abstention swings it 33 points.

- **The numbers.** It's a binomial proportion: the 95% CI half-width is ≈ `1.96·√(p(1−p)/n)`. For a
  true bite-rate around 10%, `n = 4` canaries gives roughly ±30 points, `n = 40` roughly ±9. The
  signal only firms up in the dozens.
- **Do.** Scale canaries with the real-topic count (aim for tens, not a token 2–3), and keep them
  **plausible and on-distribution** — a fabricated topic must be indistinguishable in surface form
  from a real one, or the source refuses it on pattern rather than on grounding and you over-count
  `canary-ok`. **Tradeoff:** each canary is real source calls, and too many dilute a manifest meant
  to also describe genuine coverage — this is a power/cost balance, not "more is always better".

## 5. Match the source's probe temperature to how you'll deploy it

`TEMPERATURE` defaults to `0` and is shared by source *and* judge (`config.ts`). For the **judge**
that's correct — you want deterministic, reproducible verdicts. For the **source** it quietly changes
what self-consistency means: at temp 0 the only variation between paraphrases is the wording, so you
measure robustness-to-rephrasing but not the sampling flakiness a model actually exhibits when served
at temp 0.7.

- **Why it matters.** A model that gives conflicting answers under real sampling can look perfectly
  `grounded` at temp 0. The probe isn't wrong — it's answering a narrower question than you may think.
- **Do.** Keep temp 0 for a clean, reproducible baseline. If the signal needs to reflect a
  temperature you'll actually serve at, run a second coverage pass at that temperature and compare —
  a rise in `inconsistencyRate` between the two is itself the finding. **Tradeoff:** a second pass
  doubles the source calls; do it when consistency is the number you're reporting, not on every run.

---

**One rule under all five:** the harness already prints its own reliability caveats
(`report.caveats`, `judge.warnings`). Read them before quoting a number — a metric with an active
caveat is a different, weaker measurement than the same metric without one.
