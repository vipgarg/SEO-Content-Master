# Gyan Sadhan SEO Content Engine — Final Generation & Verification Plan (v3.1)

Rendering: **Option A** — Astro static site on `/books/*`, Cloudflare Pages, Worker-proxied under the main domain.
Verification: **Gemini free tier (AI Studio)**.
Generation: **Claude** (must be a different model family — see §1).

This document is a corrected revision of v3 (uploaded 2026-08-27). It fixes three
verified errors in v3 and adds one new control. Everything else in v3 — which
itself replaced §7–§9 of v2 — stands unchanged. **v2 was not available when this
revision was made**; the JSON schema (v2 §7), banned-phrase list (v2 §8d), and
editorial/publish workflow (v2 §10–11) referenced below still live there and
have not been re-verified against this revision.

Changes from v3 are marked **[FIX]** or **[NEW]** inline. See §9 for the full changelog.

---

## 1. Model assignment

| Stage | Model | Why |
|---|---|---|
| Draft generation | Claude | Long-context, reliable structured JSON output |
| Self-critique pass | Claude (same call chain) | Cheap fix before verification |
| Claim entailment | **Gemini Flash (free)** | Different family = independent judgement. This is the whole point. |
| Banned-claim classification | **Gemini Flash-Lite (free)** | Simple classification, highest RPM |
| Editorial rubric | **Gemini Flash (free)** | Advisory only |
| Corpus uniqueness / thinness check **[NEW]** | No model | Pure code, run alongside deterministic checks. See §4a. |
| Structural + numeric checks | **No model** | Pure code. Free, deterministic, catches most errors. |

Never let the generator verify itself. If Claude wrote a claim, Claude marking it "entailed" tells you nothing — it will validate its own fluent prose. The whole value of Gemini here is that it has no stake in the output.

---

## 2. Gemini free tier — the constraints that shape the design

Verified as of August 2026 against live sources; re-check the live per-project quota before building, since Google adjusts these often.

| Constraint | Value | Design consequence |
|---|---|---|
| Models available free | Flash and Flash-Lite families only. Pro's free tier was removed April 2026. | Don't design around Pro. Flash is sufficient for entailment. |
| Requests/day | ~1,500 RPD for Flash-class | Ample. See §3 budget. |
| Requests/minute | ~10–15 RPM (Flash), higher for Flash-Lite | **This is the real limit.** Serial processing with ~5s spacing. |
| Tokens/minute | 250k–1M TPM | Never the binding constraint here. |
| Reset | Daily quota resets at midnight **Pacific time**, not on a rolling window. **[FIX]** Pacific is UTC-7 (PDT) roughly mid-March–early November and UTC-8 (PST) otherwise — the reset is **not** a fixed UTC hour. See §4 for the tracker fix. | Compute the reset instant from the `America/Los_Angeles` zone at runtime (e.g. via a proper tz library), never a hardcoded UTC offset. Currently (August, PDT) that's 07:00 UTC. |
| Quota scope | Per Google Cloud project, not per API key — extra keys in the same project share one pool. | Don't try to multiply quota with keys. |
| Billing trap | Enabling billing on a project deletes its free tier entirely; every call bills from the first token. Confirmed current as of August 2026. | **Keep verification in a dedicated project with billing off.** If you later add paid Gemini usage, use a separate project. |
| Data usage | Free-tier prompts and responses may be used to improve Google's products. | See §2.1. |

### 2.1 Data-sharing — why it's acceptable here

Everything sent to the verifier is destined for a public web page anyway: book metadata, publisher-page facts, official exam syllabus text, and your own retail price. None of it is proprietary.

Two rules to keep it that way:

- **Never send Amazon-derived evidence to Gemini.** It's `publishable = false` and has no business in verification. Enforce by filtering on the flag when assembling the payload.
- **Never send internal business data** — stock levels, margins, BDIP scores, supplier terms. The verifier needs the claim and its cited evidence snippet. Nothing else.

Build the payload assembler so it can only read `publishable = true` evidence rows. Then this is structurally impossible rather than a rule someone has to remember.

### 2.2 Google Search policy risk — the one that actually matters most **[NEW]**

Separate from Gemini API terms, this is a **Google Search spam policy** risk, and it's the largest external risk to the whole project: Google's **scaled content abuse** policy (reinforced by the August 2025 spam update and named explicitly as a target of the March 2026 core update) targets "many pages generated for the primary purpose of manipulating search rankings... using generative AI tools to generate many pages without adding value for users." Sites publishing large volumes of AI-assisted pages without adequate editorial oversight have seen 50–80% traffic drops under this policy in 2025–2026.

This plan's shape — hundreds of templated per-book pages built from a shared evidence schema — is structurally the pattern this policy targets. The existing controls (self-critique, deterministic checks, advisory rubric, throttled 20–40 pages/week publish rate, 200-page human-reviewed calibration) all help, but none of them directly measures *whether a page says anything a human reader couldn't already get from the metadata table*. §4a below closes that gap with a deterministic pre-publish gate, not just an advisory rubric.

---

## 3. Request budget

The key optimisation: **batch all claims for a page into one verification call.** One call per page, not one per claim.

Per page:

| Call | Model | Count |
|---|---|---|
| Draft + self-critique | Claude | 1 |
| Batched entailment (all claims) | Gemini Flash | 1 |
| Banned-claim scan (full text) | Gemini Flash-Lite | 1 |
| Rubric score | Gemini Flash | 1 |
| Block-level regeneration (partial) | Claude | 0.3 avg |
| Re-verification after fix | Gemini Flash | 0.3 avg |

**[FIX] ≈ 3.3 Gemini calls per page** (1 + 1 + 1 + 0.3 — the v3 draft stated 2.6, which undercounted; corrected here).

| Scenario | Pages | Gemini calls | Fits free tier? |
|---|---|---|---|
| Throttled steady state | 30/week | ~99/week | Trivially |
| Full initial run in one day | 300 | ~990 | Yes, ~66% of daily quota **[FIX]** (was stated as 52%) |
| Full 800-page corpus in one day | 800 | ~2,640 | **No** — split across 2 days (unchanged conclusion) |

At 10 RPM you can't burn a day's quota anyway — 1,500 requests at 10/min is 2.5 hours of continuous running. The queue should self-pace.

**Conclusion: the free tier is still sufficient for this workload**, but with a tighter margin than v3 claimed — a 300-page day runs at roughly two-thirds of daily quota, not half. Batching is what makes it work, not quota juggling; just budget the real number when sizing batch-day schedules.

---

## 4. Rate-limit handling (build this properly, it's not optional)

Add a `gemini_quota` worker in BullMQ:

- **Token bucket limiter** at 8 RPM (headroom below the 10 RPM limit), 1,200 RPD (headroom below 1,500).
- **429 handling:** exponential backoff — 5s, 15s, 45s, 120s — then park the job. A 429 is not a verification failure; never let it mark a page as rejected.
- **Daily quota tracker** in Postgres, resetting at midnight `America/Los_Angeles` time **[FIX]** — compute this via a timezone-aware library (e.g. `luxon`/`date-fns-tz` in Node) rather than a hardcoded UTC offset, since the offset itself changes twice a year with US DST. A tracker hardcoded to a fixed UTC hour will be off by an hour for roughly 8 months of the year.
- **Circuit breaker:** 5 consecutive non-429 errors → pause the queue and alert. Prevents burning quota on a broken prompt.
- **Log every call** to `job_runs`, consistent with how BDIP already does it.

---

## 5. Generation flow — final

### Step 1: Assemble the evidence pack

```sql
SELECT id, attribute, value_text, value_num, value_date, source_type, source_quote
FROM evidence
WHERE entity_id = $1
  AND publishable = true          -- hard filter, C3
  AND deleted_at IS NULL
  AND superseded_by IS NULL
  AND retrieved_at > now() - freshness_window(attribute);
```

If fewer than 6 rows return, the page is **not generated at all** — it goes straight to the Evidence Gap Queue before Step 2 ever runs. (See §6 — this is the point in the flow it actually branches from.)

### Step 2: Draft (Claude)

Inputs: brief, evidence pack, style guide, banned-phrase list, word budget.

Output: the structured JSON from v2 §7 — blocks, each with `claims` carrying `evidence_ids` and `claim_type`.

Hard requirement in the prompt: any sentence containing a number, date, edition, exam name or superlative must carry a claim object. Anything unsourceable goes in `unsupported_flags`, not into the prose.

### Step 3: Self-critique (Claude, same chain)

Feed the draft back with the evidence pack: "List every sentence not fully supported by the cited evidence. Rewrite or remove them." Cheap, and it removes roughly half the failures before they consume Gemini quota. That matters when quota is the scarce resource.

### Step 4: Deterministic checks (code, free — run before any Gemini call)

Run these first. They cost nothing and reject the worst output without spending quota.

- JSON parses; all `evidence_ids` exist, are `publishable`, unexpired, not superseded.
- **Numeric/date/entity exact match:** extract every number, date, ISBN, edition year, author and publisher string from the rendered text; each must equal its cited evidence value exactly. Zero tolerance on identifiers and dates.
- Meta title ≤ 60 chars, description ≤ 155, exactly one H1, ≥3 H2s, ≥2 internal links, FAQ count within range.
- Banned-phrase regex list ("in today's fast-paced world", "delve", "look no further", etc.).
- Shingled duplicate check against every published page (exact/near-duplicate text).
- **Corpus uniqueness / thinness gate — §4a below.** **[NEW]**

Failures here → regenerate the offending block only, never the whole page.

#### 4a. Corpus uniqueness / thinness gate **[NEW]**

The shingling check above only catches *exact or near-exact* duplicate text. It does not catch the failure mode the scaled-content-abuse policy actually targets: hundreds of pages that are each textually unique but structurally and informationally interchangeable — same sentence templates with different nouns swapped in, saying nothing a reader couldn't get from the metadata table alone. Since this is the single largest external risk to the project (§2.2), it gets a deterministic, blocking gate, not just the advisory rubric in Step 7.

Run these checks on every page before it can reach `checks_passed`:

- **Non-templated sentence ratio.** Diff the page's sentence structure (not exact text — e.g. POS-tag skeletons or n-gram shape after stripping named entities/numbers) against a sample of already-published pages. If more than ~70% of sentences reduce to the same skeleton as prior pages, reject and require the block to be rewritten with page-specific framing, not just swapped values.
- **Metadata-only test.** Programmatically strip every sentence whose only content is a direct restatement of an evidence field (a number, date, name, or price already in the evidence pack) and require what's left — after stripping — to still clear a minimum word count. If a page is entirely "the book has N pages and costs ₹X," it fails: that's a metadata table, not an article.
- **Corpus-relative information gain.** Track, per book category (e.g. by exam/subject), which facts have already appeared across the published corpus. A page whose entire content set is facts already stated identically on other pages in the same category should fail — it isn't adding coverage, just restating the template.

Failures here route to `needs_review` with `flag = thin_content`, same as a rubric-flagged page, but **blocking** rather than advisory — a `thin_content` flag prevents publish until an editor either adds page-specific content or confirms the book genuinely has nothing more to say (e.g. a very minor SKU), in which case it's marked `low_priority` and either merged into a category page or deliberately kept `noindex` rather than published as a thin standalone URL.

Calibrate the skeleton-similarity and word-count thresholds during the same 200-page human calibration run used for the rubric in Step 7 — they're new, unvalidated numbers, and the specific thresholds above are starting points, not fixed law.

### Step 5: Batched entailment (Gemini Flash) — one call

Send all claims from the page in a single request. Critically, **send each claim with only its own cited evidence** — no page title, no book name, no surrounding prose. The verifier must judge support, not plausibility.

```json
{
  "task": "For each item, decide whether the evidence supports the claim.",
  "items": [
    {"id": "c1",
     "claim": "the 2025 edition runs to 812 pages",
     "evidence": [{"id": 4471, "source_type": "publisher",
                   "text": "Pages: 812 | Edition: 2025"}]},
    {"id": "c2", "claim": "...", "evidence": [...]}
  ]
}
```

Response format — force JSON mode:

```json
{"results": [{"id": "c1", "verdict": "entailed", "confidence": 0.95, "reason": "..."}]}
```

Verdicts: `entailed` | `partially` | `not_entailed` | `contradicted`.

Routing:
- All `entailed` → proceed.
- Any `contradicted` → hard reject, regenerate block, flag the evidence row for re-check (the source may have changed).
- `not_entailed` → strip the block if optional, regenerate if structural.
- `partially` → keep but route to human editorial queue.

Batch size cap: ~25 claims per call. Beyond that, quality of per-item judgement degrades and one bad parse costs you the whole page.

### Step 6: Banned-claim scan (Gemini Flash-Lite) — one call

Full rendered text against the hard-reject list from v2 §8d: exam outcome guarantees, medical/legal/financial advice, syllabus claims without an official-exam-body source, competitor disparagement, and any Amazon-derived figure. Binary output plus offending span.

Any hit → hard reject. No auto-fix; this goes to a human.

### Step 7: Rubric score (Gemini Flash) — one call, advisory

Fixed rubric on observable properties: does it answer the query in the first 100 words, does it contain information beyond the metadata, is any section filler. Used to **route** to human review, not to gate publication — the blocking gate for thinness is now §4a; this rubric is a softer, model-judged signal for review prioritization on top of that. Calibrate against human ratings from the first 200 pages; if it doesn't correlate, drop it.

### Step 8: Editorial queue → publish → build

Per v2 §10–11. First 200 pages fully human-reviewed. Throttle to 20–40 published pages/week. Incremental Astro build on publish.

---

## 6. Status flow **[FIX]**

The v3 diagram drew `evidence_gap` as a step sequentially after `scored`/`needs_review`, which misstated when a page actually enters it. Corrected below: `evidence_gap` branches off *before generation starts* (Step 1); `needs_review` branches off from any of several later failure points. They are two independent exit branches, not a chain.

```
                 ┌─ (evidence < 6 rows, Step 1) ──► evidence_gap
                 │
draft ───────────┴─► generated → self_critiqued → checks_passed ─┬─► entailed → scanned → scored → editorial → published → stale
                                        │                          │
                                        │ (deterministic/          │ (contradicted / not_entailed /
                                        │  thin_content fail)      │  banned-claim hit / partial verdict /
                                        ▼                          │  unsupported_flag)
                                   needs_review ◄───────────────────┘
```

`needs_review` and `evidence_gap` are different work queues. The first needs an editor; the second needs someone to find a URL. Don't merge them — the second is the one you can batch and delegate.

---

## 7. What changed from v2 because of the Gemini choice

1. **Claim verification is now batched per page**, not per claim. Purely a quota optimisation, but it's what makes the free tier viable — ~3.3 calls/page instead of ~30. **[FIX: corrected from v3's stated 2.6]**
2. **Deterministic checks moved ahead of all model calls.** Free checks first, paid-in-quota checks second. Reorders v2 §8 but the logic is unchanged.
3. **Self-critique pass added to generation.** Kills failures before they consume Gemini quota.
4. **Flash-Lite assigned to the banned-claim scan**, Flash to entailment — matching model capability and RPM to task difficulty.
5. **Payload assembler restricted to `publishable = true` rows.** Makes the "no Amazon data leaves the system" rule structural rather than procedural, which matters more now that a third party sees the payloads.
6. **Rate-limit worker with token bucket, backoff, daily budget and circuit breaker** — new component, required by the RPM ceiling.
7. **Dedicated Google Cloud project with billing disabled**, because enabling billing anywhere on that project destroys the free tier.
8. **Corpus uniqueness/thinness gate added as a blocking deterministic check** **[NEW]** — directly targets Google's scaled-content-abuse policy rather than relying solely on the advisory rubric.

---

## 8. Where this breaks, and what to do then

Free-tier Gemini is sufficient for ~800 pages at a throttled cadence. It stops being sufficient if:

- **You scale past ~500 pages/day.** Then move verification to a separate billed project (never the same one) — Flash pricing at this volume is small.
- **Entailment quality proves unreliable on Flash.** Measure it during the 200-page calibration run: compare Gemini verdicts against human judgement on the same claims. If agreement is below ~85%, the verifier isn't earning its place and you either upgrade the model or lean harder on the deterministic checks, which are the more valuable half of the system anyway.
- **Google changes free-tier terms.** They have moved multiple times in the past year. Keep the verifier behind the same provider interface BDIP uses, so swapping costs a config change.
- **The thin-content gate (§4a) proves too strict or too loose during calibration.** Recalibrate the skeleton-similarity and word-count thresholds against the same 200-page human review used for the rubric — these are new, unvalidated numbers as of this revision.

The deterministic checks in Step 4 (including §4a) are what actually protect you — both from publishing false claims about a book, and from tripping Google's scaled-content-abuse policy. Gemini is a valuable second layer, not the foundation. Build it in that order.

---

## 9. Changelog — v3 → v3.1

Fixes applied after reviewing the uploaded v3 document, confirmed against current sources where the claim was externally checkable:

1. **§3 math error:** Gemini calls/page corrected from the stated 2.6 to the actual sum of the table's Gemini rows, 3.3. Downstream percentages in the scenario table corrected accordingly (300-page day is ~66% of daily quota, not 52%). Conclusions ("free tier sufficient," "800 pages needs 2 days") are unchanged, but with a tighter real margin than v3 stated.
2. **§2/§4 timezone bug:** "resets at midnight Pacific" (§2) and "resetting at 08:00 UTC" (§4, and "schedule after 08:00 UTC" in §2) contradicted each other. Midnight Pacific during PDT (in effect roughly mid-March–early November, which includes August) is 07:00 UTC, not 08:00 UTC. Fixed to specify timezone-aware computation (`America/Los_Angeles`) rather than a hardcoded UTC hour.
3. **§6 diagram:** corrected to show `evidence_gap` branching from Step 1 (before generation), not sequentially after `scored`, matching the text's own description of when a page enters that queue.
4. **§4a added (new control):** a blocking, deterministic corpus-uniqueness/thinness gate, distinct from the existing advisory rubric and from the exact-duplicate shingling check, aimed directly at Google's scaled-content-abuse spam policy — confirmed live and actively enforced in 2025–2026, with real traffic-loss consequences for sites matching this project's page-generation pattern.

Not resolved in this revision, still open:
- **v2 was not available for this review.** The JSON schema (v2 §7), banned-phrase list (v2 §8d), and editorial workflow (v2 §10–11) that this document depends on have not been re-checked for consistency with the fixes above.
- **Amazon evidence acquisition method** (scraping vs. official API) is not documented in either v2 or v3 as reviewed here — worth confirming separately, since it's a legal question independent of the publish-time firewall this plan already enforces correctly.
