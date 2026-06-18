'use strict';
// StateGen — NGEM (Nevada Government eMarketplace) ingest adapter.
// GET → returns open Nevada state/local solicitations in a normalized shape.
//
// STATUS: SAMPLE MODE. fetchNgemBids() currently returns a representative
// Nevada bid set so the live site is fully functional. To go live, replace
// the body of fetchNgemBids() with the real NGEM read — either:
//   (a) NGEM's internal JSON endpoint (the call its public bid-list page makes), or
//   (b) an HTML scrape of the public open-solicitations list.
// No API key is required as long as NGEM exposes open bids without login.
// Everything downstream (filtering, rendering) consumes the normalized shape below.

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

// Normalized opportunity shape (source-agnostic — mirrors CapGen's pattern):
// { id, title, agency, category_code, category, city, county, posted_days_ago,
//   due_in_days, solicitation_no, url, status }
const SAMPLE_BIDS = [
  { id: 'nv-001', title: 'Statewide Janitorial & Custodial Services', agency: 'State of Nevada — Purchasing Division', category_code: '910', category: 'Building Maintenance & Repair', city: 'Carson City', county: 'Carson City', posted_days_ago: 4, due_in_days: 21, solicitation_no: 'NV-PUR-25-1180' },
  { id: 'nv-002', title: 'Enterprise Network Infrastructure Upgrade', agency: 'Clark County', category_code: '920', category: 'Data Processing & IT Services', city: 'Las Vegas', county: 'Clark', posted_days_ago: 6, due_in_days: 14, solicitation_no: 'CC-IT-2026-044' },
  { id: 'nv-003', title: 'Citywide Park Landscape Maintenance', agency: 'City of Las Vegas', category_code: '988', category: 'Landscaping & Grounds', city: 'Las Vegas', county: 'Clark', posted_days_ago: 2, due_in_days: 9, solicitation_no: 'COLV-PR-26-007' },
  { id: 'nv-004', title: 'Student Transportation Routing Software', agency: 'Clark County School District', category_code: '920', category: 'Data Processing & IT Services', city: 'Las Vegas', county: 'Clark', posted_days_ago: 9, due_in_days: 30, solicitation_no: 'CCSD-TS-2026-118' },
  { id: 'nv-005', title: 'Arterial Road Resurfacing — Phase II', agency: 'City of Henderson', category_code: '913', category: 'Roads & Construction', city: 'Henderson', county: 'Clark', posted_days_ago: 5, due_in_days: 25, solicitation_no: 'COH-PW-26-031' },
  { id: 'nv-006', title: 'On-Call Professional Engineering Services', agency: 'Washoe County', category_code: '925', category: 'Engineering Services', city: 'Reno', county: 'Washoe', posted_days_ago: 7, due_in_days: 18, solicitation_no: 'WC-ENG-2026-012' },
  { id: 'nv-007', title: 'Campus Security & Patrol Services', agency: 'Nevada System of Higher Education', category_code: '990', category: 'Security & Protective Services', city: 'Reno', county: 'Washoe', posted_days_ago: 3, due_in_days: 12, solicitation_no: 'NSHE-SEC-26-009' },
  { id: 'nv-008', title: 'Bus Shelter Fabrication & Installation', agency: 'RTC of Southern Nevada', category_code: '550', category: 'Fabrication & Metalwork', city: 'Las Vegas', county: 'Clark', posted_days_ago: 8, due_in_days: 16, solicitation_no: 'RTC-FAB-2026-022' },
  { id: 'nv-009', title: 'Water Pipeline Inspection Services', agency: 'Las Vegas Valley Water District', category_code: '968', category: 'Utility Services', city: 'Las Vegas', county: 'Clark', posted_days_ago: 1, due_in_days: 7, solicitation_no: 'LVVWD-OPS-26-058' },
  { id: 'nv-010', title: 'Marketing & Public Communications Consulting', agency: 'City of Reno', category_code: '915', category: 'Communications & PR', city: 'Reno', county: 'Washoe', posted_days_ago: 6, due_in_days: 28, solicitation_no: 'COR-COM-2026-014' },
  { id: 'nv-011', title: 'HVAC Preventative Maintenance — County Facilities', agency: 'Clark County', category_code: '031', category: 'HVAC & Mechanical', city: 'Las Vegas', county: 'Clark', posted_days_ago: 10, due_in_days: 19, solicitation_no: 'CC-FAC-2026-071' },
  { id: 'nv-012', title: 'Temporary Staffing — Administrative Support', agency: 'State of Nevada — Purchasing Division', category_code: '961', category: 'Staffing & Temporary Services', city: 'Carson City', county: 'Carson City', posted_days_ago: 4, due_in_days: 11, solicitation_no: 'NV-PUR-26-0204' },
];

const SITE_URL = 'https://stategen.aproposgroupllc.com';

async function fetchNgemBids() {
  // TODO(go-live): replace with the real NGEM read (internal JSON or scrape of
  // the public open-solicitations list). Return objects in the normalized shape above.
  return { mode: 'sample', bids: SAMPLE_BIDS };
}

function isoFromDaysOut(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  try {
    const { mode, bids } = await fetchNgemBids();
    const normalized = bids
      .map(b => ({
        ...b,
        status: 'Open',
        due_date: isoFromDaysOut(b.due_in_days),
        url: b.url || (SITE_URL + '/bid/' + encodeURIComponent(b.id)),
      }))
      .sort((a, b) => a.due_in_days - b.due_in_days);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        source: 'ngem',
        state: 'NV',
        scanMode: mode,            // "sample" now → "live" once real ingest is wired
        generatedAt: new Date().toISOString(),
        count: normalized.length,
        bids: normalized,
      }),
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'NGEM fetch failed', detail: String(e && e.message || e) }) };
  }
};
