# Tempo Worklog Booking Rules

## Usage

```bash
npm run book
```

One command. No arguments needed. The script automatically:
1. Opens a browser (user logs in manually once)
2. Scrapes the current month's TimeDiff page for "Attendance (SAP)" and "Booked (Tempo)" hours
3. Skips dates already fully booked (Tempo >= SAP)
4. Books worklogs for remaining dates
5. Reports results and saves to `booking-results.json`

## Distribution Logic

Hours are distributed based on whether `Math.floor(sapHours)` is even or odd:

- **EVEN** (e.g., 8h, 6h): 50/50 split
  - PFLUITS-3554: 50%
  - TAU-96: 50%

- **ODD** (e.g., 7h, 9h): 1h to management, rest split 50/50
  - ARTQMPM-171: 1h
  - PFLUITS-3554: (remaining) / 2
  - TAU-96: (remaining) / 2

**Example:** 8.57h (EVEN) -> PFLUITS-3554: 4.285h, TAU-96: 4.285h
**Example:** 7.05h (ODD) -> ARTQMPM-171: 1h, PFLUITS-3554: 3.025h, TAU-96: 3.025h

## Key Behaviors

- **Idempotent**: Safe to run multiple times. Already-booked dates are skipped automatically.
- **Current month only**: The scraper uses the system date to determine which month to read from TimeDiff.
- **Attended mode**: No credentials stored. User must complete login/MFA in the browser.
- **Failure handling**: Screenshots saved to `./artifacts/` on any booking failure. Only confirmed successes are reported as 'created'.

## Success Validation

After submitting each worklog, the script waits (5s timeout) for one of:
1. AUI success banner (`.aui-message-success`) -> success
2. AUI error banner / error alert -> failure
3. No response -> treated as failure

## Files

| File | Purpose |
|------|---------|
| `src/book-unified.ts` | Main booking script (scrape + book) |
| `src/scrape-attendance.ts` | TimeDiff table scraper |
| `src/tempo-ui.ts` | Jira authentication & session management |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/scrape-cli.ts` | Standalone scraping CLI (`npm run scrape-attendance`) |
| `scraped-attendance.json` | Latest scraped attendance data |
| `booking-results.json` | Results of last booking run |

## Optional Flags

```bash
# Use previously scraped data instead of scraping fresh
npm run book -- --skip-scrape
```

---

**Last Updated:** 2026-02-06
