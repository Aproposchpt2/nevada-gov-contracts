# StateGen

**Win Nevada government contracts.** StateGen is the state/local sibling to CapGen — it surfaces open
**State of Nevada, county, city, school district, and university** solicitations, matched to a business's
NIGP categories. **No SAM.gov registration required** (that's CapGen's federal lane; the two products stay separate).

- **Live:** https://stategen.aproposgroupllc.com
- **Owner:** Apropos Group LLC

## Architecture
Source-agnostic by design (mirrors CapGen's pattern): an **ingest adapter** pulls opportunities from a source
and normalizes them to a common shape, and the UI consumes that shape. Adding a new state = adding a new adapter.

Normalized opportunity shape:
```
{ id, title, agency, category_code, category, city, county,
  posted_days_ago, due_in_days, due_date, solicitation_no, url, status }
```

## Current status — SAMPLE MODE
`netlify/functions/ngem-pipeline.js` returns a representative Nevada bid set so the site is fully
functional and demoable now. The front-end (`index.html`) also carries a small inline fallback so it
renders even when opened locally without the function.

## Go-live: wiring real NGEM data
Replace the body of `fetchNgemBids()` in `ngem-pipeline.js` with the real read from
[NGEM](https://www.ngemnv.com/). No API key is needed if NGEM exposes open bids without login. Order of preference:
1. **Internal JSON** — the endpoint NGEM's public bid-list page calls (cleanest).
2. **HTML scrape** — parse the public open-solicitations list.

When real data flows, set `scanMode` to `"live"` (the UI badge and stats follow automatically).

## Deploy
GitHub → Netlify auto-deploy from `main`. Static publish (`.`) + functions in `netlify/functions`.
No environment variables required in sample mode.
