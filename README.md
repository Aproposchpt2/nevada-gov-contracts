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

## Current status — LIVE
`netlify/functions/ngem-pipeline.js` scrapes NGEM's **public Current Bids** list in real time and
returns normalized opportunities (`scanMode: "live"`). The front-end (`index.html`) also carries a
small inline fallback so it renders even when opened locally without the function.

### How the live ingest works
NGEM runs on **Ionwave** (`nevada.ionwave.net`). The public current-bids list —
`SourcingEvents.aspx?SourceType=1` — is viewable without login; a single GET with a browser
User-Agent returns the full Telerik grid. The function parses rows (Bid Number, Title, Type,
Organization, Issue Date, Close Date), computes days-to-close, drops closed bids, sorts by deadline,
and caches for 5 minutes. If the live read ever fails, it falls back to a small sample set
(`scanMode: "sample"`) so the site stays up.

**Per-bid deep link:** the RadGrid ClientState maps each row index → `BidID`
(e.g. `"0":{"BidID":"20049"}`). We join that to each row and link straight to the public
**Bid Opportunity Detail** page: `PublicDetail.aspx?bidID={BidID}&SourceType=1`. Falls back to the
current-bids list only if a BidID is ever missing.

### Matching layer (live)
Visitors can save a **keyword profile** (services/trades/product types). StateGen scores each open bid
by keyword hits across title + type + agency, shows **★ Match / ★ Strong match** badges, and a
**"My matches"** view that filters + ranks by relevance. Stored client-side in `localStorage`
(`stategen_keywords`) — no login yet. This is the seed of the subscription value (alerts, tiers).

### Future enhancements
- **Pagination** — ingests page 1 (soonest-closing, ~20). NGEM's Telerik pager is client-side
  button-driven (not a replayable inline postback), so the full set likely needs a headless browser.
- **NIGP categories** — pull NIGP codes from bid detail pages for richer category matching + alerts.
- **Server-side profiles + email alerts** — move the keyword profile server-side; daily "new bids that
  match you" emails. Then onboarding + tiers (mirror CapGen's model).
- **Closed/Awarded** — `SourceType=2` (closed) and `SourceType=3` (awarded) feeds are available too.

## Deploy
GitHub → Netlify auto-deploy from `main`. Static publish (`.`) + functions in `netlify/functions`.
No environment variables required in sample mode.
