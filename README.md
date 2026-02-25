# Tempo Worklog Automation (Attended Mode)

Node.js/TypeScript automation for creating Jira Tempo worklogs using Playwright in **attended mode**. No credentials are stored - you log in manually, and the script handles the repetitive worklog booking.

## Why Attended Mode?

- **Compliance-friendly**: No stored credentials, passwords, or tokens
- **MFA-compatible**: You complete SSO/MFA login yourself
- **Secure**: The script only acts after successful manual authentication

## Prerequisites

- **Node.js 20+**
- Access to Jira DC instance: `https://jira.uniqagroup.com`
- Tempo plugin installed in Jira

## Installation

```bash
# Install dependencies
npm install

# Install Playwright Chromium browser
npx playwright install chromium

# Build TypeScript
npm run build
```

## Usage

### Book Worklogs (main command)

```bash
npm run book
```

One command, no arguments. The script automatically:
1. Opens a browser (you log in manually once)
2. Scrapes the current month's TimeDiff page for SAP attendance and Tempo booked hours
3. Skips dates already fully booked (Tempo >= SAP)
4. Books worklogs for remaining dates using the distribution rules
5. Reports results and saves to `booking-results.json`

**Optional flag:**
```bash
# Use previously scraped data instead of scraping fresh
npm run book -- --skip-scrape
```

### Scrape Attendance Only

```bash
npm run scrape-attendance
```

Scrapes the TimeDiff page and saves to `scraped-attendance.json` without booking.

## Distribution Rules

Hours are distributed based on whether `Math.floor(sapHours)` is even or odd:

- **EVEN** (e.g., 8h, 6h): 50/50 split between PFLUITS-3554 and TAU-96
- **ODD** (e.g., 7h, 9h): 1h to ARTQMPM-171, remainder split 50/50 between PFLUITS-3554 and TAU-96

Issue keys are configured in `src/types.ts` (`JIRA_ISSUES` constant).

## Project Structure

```
tempo-worklog-automation/
├── src/
│   ├── types.ts              # Shared constants & TypeScript interfaces
│   ├── tempo-ui.ts           # Browser launch & Jira authentication
│   ├── scrape-attendance.ts  # TimeDiff table scraper
│   ├── book-unified.ts       # Main booking script (scrape + book)
│   └── scrape-cli.ts         # Standalone scraping CLI
├── dist/                     # Compiled JavaScript (generated)
├── artifacts/                # Error screenshots (generated)
├── tsconfig.json             # TypeScript configuration
├── package.json              # Dependencies and scripts
├── BOOKING-RULES.md          # Detailed booking rules reference
└── README.md                 # This file
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run book` | Build + scrape + book worklogs |
| `npm run scrape-attendance` | Build + scrape TimeDiff data only |

## Troubleshooting

### "Could not find Attendance (SAP) column"

The TimeDiff table structure may have changed. Inspect the table HTML and update selectors in `src/scrape-attendance.ts`.

### "Timeout waiting for login"

You have 5 minutes to complete SSO/MFA. If you need more time, increase the timeout in `src/tempo-ui.ts` (`waitForSelector({ timeout: 300000 })`).

## Security Notes

- **No credentials stored**: Zero passwords, tokens, or API keys
- **Attended authentication**: User drives all login flows
- **Error screenshots**: Saved to `./artifacts/` only on failure
- **Do not commit**: `.env`, credentials, or sensitive data (check `.gitignore`)

## License

MIT
