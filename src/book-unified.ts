/**
 * UNIFIED BOOKING - Scrape + Book in one session
 * Avoids double login by reusing the same browser session
 */

import { Browser, Page } from 'playwright';
import { ensureAuthenticated, launchBrowser, navigateToTimeDiff } from './tempo-ui.js';
import { scrapeAttendanceFromTimeDiff, AttendanceEntry } from './scrape-attendance.js';
import { CreateWorklogInput, CreateWorklogResult, JIRA_ISSUES, PROJECT_ROOT } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface WorklogDistribution {
  issueKey: string;
  hours: number;
}

interface BookingResult {
  date: string;
  issueKey: string;
  hours: number;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  message?: string;
}

function distributeHours(sapHours: number): WorklogDistribution[] {
  const isEven = Math.floor(sapHours) % 2 === 0;

  let distribution: WorklogDistribution[];

  if (isEven) {
    // EVEN: 50/50 split
    const halfHours = sapHours / 2;
    distribution = [
      { issueKey: JIRA_ISSUES.PRIMARY, hours: parseFloat(halfHours.toFixed(3)) },
      { issueKey: JIRA_ISSUES.SECONDARY, hours: parseFloat(halfHours.toFixed(3)) },
    ];
  } else {
    // ODD: 1h to management, rest split 50/50
    const remainder = sapHours - 1.0;
    const halfRemainder = remainder / 2;
    distribution = [
      { issueKey: JIRA_ISSUES.MANAGEMENT, hours: 1.0 },
      { issueKey: JIRA_ISSUES.PRIMARY, hours: parseFloat(halfRemainder.toFixed(3)) },
      { issueKey: JIRA_ISSUES.SECONDARY, hours: parseFloat(halfRemainder.toFixed(3)) },
    ];
  }

  return distribution.filter(d => d.hours > 0);
}

/**
 * Book a worklog directly from the TimeDiff page by clicking the underlined
 * difference value for the target date, then filling the Log Work dialog.
 */
async function createWorklogFromTimeDiff(page: Page, input: CreateWorklogInput, useRemainingDiff = false): Promise<CreateWorklogResult> {
  const { issueKey, date, hours } = input;
  const targetDay = parseInt(date.split('-')[2], 10);

  console.log(`📝 ${issueKey} (${hours}h)`);

  try {
    // Find column index for the target day from the header row
    const table = page.locator('table').first();
    const headerCells = await table.locator('tr').first().locator('th, td').allTextContents();

    let colIndex = -1;
    for (let i = 0; i < headerCells.length; i++) {
      const header = headerCells[i].trim();
      const dayMatch = header.match(/^(\d{1,2})[A-Z]?$/i);
      if (dayMatch && parseInt(dayMatch[1], 10) === targetDay) {
        colIndex = i;
        break;
      }
    }

    if (colIndex === -1) {
      throw new Error(`Could not find column for day ${targetDay} in header row`);
    }

    // Find the Difference row and click the value in the target column.
    // The clickable element may be an <a>, <span>, or the cell itself.
    const allRows = await table.locator('tr').all();
    let clicked = false;

    for (const row of allRows) {
      const cells = await row.locator('td, th').all();
      if (cells.length === 0) continue;

      const firstCellText = (await cells[0].textContent()) ?? '';
      if (firstCellText.toLowerCase().includes('differ')) {
        if (colIndex >= cells.length) {
          throw new Error(`Column ${colIndex} out of bounds (${cells.length} cells in Difference row)`);
        }

        const targetCell = cells[colIndex];
        const cellText = (await targetCell.textContent())?.trim() ?? '';
        console.log(`   → Difference cell text for day ${targetDay}: "${cellText}"`);

        // Try clicking in order: <a> link, <span>, or the cell itself
        const link = targetCell.locator('a').first();
        if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
          await link.click();
          clicked = true;
        } else {
          const span = targetCell.locator('span').first();
          if (await span.isVisible({ timeout: 1000 }).catch(() => false)) {
            await span.click();
            clicked = true;
          } else if (cellText && /\d/.test(cellText)) {
            // Cell has numeric content — click the cell directly
            await targetCell.click();
            clicked = true;
          } else {
            throw new Error(`Difference cell for day ${targetDay} has no clickable content (text: "${cellText}")`);
          }
        }
        break;
      }
    }

    if (!clicked) {
      throw new Error('Could not find Difference row in the table');
    }

    // Wait for the Log Work dialog by its heading (avoids matching hidden dialog shells)
    const dialogHeading = page.locator('h2:has-text("Log Work"), h1:has-text("Log Work")').first();
    await dialogHeading.waitFor({ timeout: 5000, state: 'visible' });
    await page.waitForTimeout(500); // Let dialog fully render

    // Fill Issue Key field
    const issueKeyField = page.locator('#input-issue-key');
    await issueKeyField.waitFor({ timeout: 3000, state: 'visible' });
    await issueKeyField.fill(issueKey);
    await page.waitForTimeout(300);
    await page.keyboard.press('Tab');

    // Fill Worked(h) field — for the last booking per date, keep the pre-filled
    // remaining difference to absorb any Tempo rounding gaps.
    const workedField = page.locator('#input-worked');
    await workedField.waitFor({ timeout: 3000, state: 'visible' });
    if (useRemainingDiff) {
      const prefilled = await workedField.inputValue();
      console.log(`   → Using remaining difference: ${prefilled}h (instead of calculated ${hours}h)`);
    } else {
      await workedField.fill(hours.toString());
    }

    // Click "Log Work" submit button
    await page.locator('#dialog-logwork-button').click();

    // Poll for dialog close (success) or error message (failure)
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!(await dialogHeading.isVisible().catch(() => false))) {
        // Wait for table data to repopulate after page auto-refresh:
        // 1) waitForFunction ensures the refresh has started (difference row has data)
        // 2) fixed delay lets remaining cells finish (they load asynchronously cell-by-cell)
        await page.waitForFunction(`(() => {
          const rows = document.querySelectorAll('table tr');
          for (const row of rows) {
            const firstCell = row.querySelector('td, th');
            const label = (firstCell?.textContent || '').toLowerCase();
            if (label.includes('differ')) {
              const cells = row.querySelectorAll('td, th');
              for (let i = 2; i < cells.length; i++) {
                const text = (cells[i]?.textContent || '').trim();
                if (/\\d/.test(text)) return true;
              }
            }
          }
          return false;
        })()`, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        console.log(`   ✅ ${issueKey} SUCCESS`);
        return {
          status: 'created',
          message: `Worklog created: ${hours}h on ${date}`,
        };
      }
      if (await page.locator('.aui-message-error, .error-message').isVisible().catch(() => false)) {
        throw new Error('Error message appeared in the Log Work dialog');
      }
      await page.waitForTimeout(300);
    }
    throw new Error('Timeout: dialog did not close after clicking Log Work');

  } catch (error) {
    console.error(`   ❌ ${issueKey} FAILED: ${error}`);

    // Screenshot on failure
    try {
      const artifactsDir = path.join(PROJECT_ROOT, 'artifacts');
      await fs.mkdir(artifactsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(artifactsDir, `error-${issueKey}-${date}-${timestamp}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`   📸 Screenshot: ${screenshotPath}`);
    } catch (screenshotErr) {
      console.warn(`   ⚠️  Could not capture error screenshot: ${screenshotErr}`);
    }

    // Try to close any open dialog to avoid blocking next booking
    try {
      const cancelBtn = page.locator('#dialog-close-button');
      if (await cancelBtn.isVisible({ timeout: 1000 })) {
        await cancelBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (dismissErr) {
      console.warn(`   ⚠️  Could not dismiss dialog: ${dismissErr}`);
    }

    return {
      status: 'failed',
      message: `Failed: ${error}`,
    };
  }
}

async function main() {
  // Parse command line arguments for target dates
  const args = process.argv.slice(2);
  const skipScrape = args.includes('--skip-scrape');

  const now = new Date();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const currentMonthName = monthNames[now.getMonth()];
  const scriptTitle = `UNIFIED BOOKING - ${currentMonthName} ${now.getFullYear()} (unbooked dates)`;
  const resultsFileName = path.join(PROJECT_ROOT, 'booking-results.json');

  console.log(`\n⚡ ${scriptTitle}\n`);

  const ATTENDANCE_FILE = path.join(PROJECT_ROOT, 'scraped-attendance.json');
  let browser: Browser | null = null;

  try {
    // Launch browser ONCE
    const launched = await launchBrowser();
    browser = launched.browser;
    const page = launched.page;

    // Authenticate ONCE
    await ensureAuthenticated(page);

    let allAttendance: AttendanceEntry[] = [];

    if (skipScrape) {
      console.log('🔄 STEP 1: Using existing attendance data (scraping skipped)...\n');

      try {
        const existingData = JSON.parse(await fs.readFile(ATTENDANCE_FILE, 'utf-8'));
        if (Array.isArray(existingData) && existingData.length > 0) {
          allAttendance = existingData;
          console.log(`   ✅ Loaded ${allAttendance.length} entries from ${ATTENDANCE_FILE}\n`);
        } else {
          console.error('   ❌ Existing file is empty or invalid.');
          process.exit(1);
        }
      } catch (error) {
        console.error(`   ❌ Failed to read existing attendance file: ${error}`);
        console.error('   💡 Run without --skip-scrape to fetch fresh data.');
        process.exit(1);
      }
    } else {
      console.log('🔄 STEP 1: Scraping attendance data...\n');

      // Backup existing file before scraping
      let backupData: AttendanceEntry[] = [];
      try {
        backupData = JSON.parse(await fs.readFile(ATTENDANCE_FILE, 'utf-8'));
      } catch {
        // No existing file or invalid JSON — no backup available
      }

      // Scrape attendance data using the same authenticated session
      const scrapeResult = await scrapeAttendanceFromTimeDiff(page);

      if (!scrapeResult.success || scrapeResult.entries.length === 0) {
        console.warn('\n⚠️  Failed to scrape attendance data.');
        console.warn(`   Error: ${scrapeResult.errorMessage || 'No entries found'}`);

        // Restore backup if available
        if (backupData.length > 0) {
          console.warn('   ℹ️  Restoring backup data...');
          await fs.writeFile(ATTENDANCE_FILE, JSON.stringify(backupData, null, 2));
          allAttendance = backupData;
          console.log(`   ✅ Using backup data with ${allAttendance.length} entries\n`);
        } else {
          console.error('   ❌ No backup data available.');
          process.exit(1);
        }
      } else {
        // Use freshly scraped data (already saved by scrapeAttendanceFromTimeDiff)
        allAttendance = scrapeResult.entries;
        console.log(`\n✅ Successfully scraped ${allAttendance.length} entries\n`);
      }
    }

    // Filter: only dates with attendance that are not yet fully booked
    const withAttendance = allAttendance.filter(entry => entry.attendanceSAP > 0);
    const alreadyBooked = withAttendance.filter(entry => entry.tempoLogged !== undefined && entry.tempoLogged >= entry.attendanceSAP);
    const targetAttendance = withAttendance.filter(entry => entry.tempoLogged === undefined || entry.tempoLogged < entry.attendanceSAP);

    if (alreadyBooked.length > 0) {
      console.log(`   ⏭️  Skipping ${alreadyBooked.length} already-booked date(s): ${alreadyBooked.map(e => e.date).join(', ')}`);
    }

    if (targetAttendance.length === 0) {
      console.log(`\n✅ Nothing to book — all dates with attendance data are already fully booked in Tempo.`);
      process.exit(0);
    }

    console.log(`\n✅ Found ${targetAttendance.length} dates with attendance data\n`);
    console.log('🔄 STEP 2: Booking worklogs...\n');

    // Preview
    console.log('📊 Booking Preview:\n');
    let totalHours = 0;
    let totalWorklogs = 0;

    for (const entry of targetAttendance) {
      const isEven = Math.floor(entry.attendanceSAP) % 2 === 0;
      const distribution = distributeHours(entry.attendanceSAP);
      totalHours += entry.attendanceSAP;
      totalWorklogs += distribution.length;

      console.log(`   ${entry.date} (${entry.attendanceSAP}h - ${isEven ? 'EVEN' : 'ODD'}):`);
      for (const wl of distribution) {
        console.log(`      → ${wl.issueKey}: ${wl.hours.toFixed(2)}h`);
      }
    }

    console.log(`\n   Total: ${totalHours.toFixed(2)}h\n`);
    console.log('\n🔄 Starting booking (using same browser session)...\n');

    // Navigate to TimeDiff only if we skipped scraping (scraping already leaves us on TimeDiff)
    if (skipScrape) {
      await navigateToTimeDiff(page);
    }

    // Book worklogs
    const results: BookingResult[] = [];
    const startTime = Date.now();

    for (let i = 0; i < targetAttendance.length; i++) {
      const entry = targetAttendance[i];
      const distribution = distributeHours(entry.attendanceSAP);

      console.log(`[${i + 1}/${targetAttendance.length}] ${entry.date} (${entry.attendanceSAP}h)`);
      console.log('──────────────────────────────────────────────────');

      let dateHasFailure = false;

      for (let j = 0; j < distribution.length; j++) {
        const wl = distribution[j];
        const isLastForDate = j === distribution.length - 1;
        // Only use remaining diff if last booking AND no prior failures for this date
        const useRemaining = isLastForDate && !dateHasFailure;
        const input: CreateWorklogInput = {
          issueKey: wl.issueKey,
          date: entry.date,
          hours: wl.hours,
        };

        const result = await createWorklogFromTimeDiff(page, input, useRemaining);

        if (result.status === 'failed') {
          dateHasFailure = true;
        }

        results.push({
          date: entry.date,
          issueKey: wl.issueKey,
          hours: wl.hours,
          status: result.status,
          message: result.message,
        });
      }

      console.log('');
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Summary
    console.log('======================================================================');
    console.log('📊 FINAL RESULTS');
    console.log('======================================================================\n');

    const created = results.filter(r => r.status === 'created').length;
    const failed = results.filter(r => r.status === 'failed').length;

    console.log('Overall:');
    console.log(`   ✅ Created: ${created}`);
    console.log(`   ❌ Failed:  ${failed}`);
    console.log(`   📝 Total entries: ${results.length}`);
    console.log(`   ⏱️  Duration: ${duration}s\n`);

    console.log('Per-date breakdown:\n');

    for (const entry of targetAttendance) {
      const dateResults = results.filter(r => r.date === entry.date);
      const dateSuccess = dateResults.filter(r => r.status === 'created').length;
      const dateFailed = dateResults.filter(r => r.status === 'failed').length;

      console.log(`   ${entry.date}:`);
      console.log(`      Hours: ${entry.attendanceSAP}h | Success: ${dateSuccess} | Failed: ${dateFailed}`);

      for (const res of dateResults) {
        const icon = res.status === 'created' ? '✅' : '❌';
        console.log(`         ${icon} ${res.issueKey}: ${res.hours.toFixed(2)}h`);
      }
      console.log('');
    }

    // Save results
    await fs.writeFile(resultsFileName, JSON.stringify(results, null, 2));
    console.log(`💾 Results saved to: ${resultsFileName}\n`);

    if (failed === 0) {
      console.log('✅ PERFECT! All worklogs created successfully.\n');
    } else {
      console.log(`⚠️  ${failed} worklog(s) failed. Check artifacts/ for screenshots.\n`);
    }

    const avgTime = (parseFloat(duration) / totalWorklogs).toFixed(1);
    console.log(`⚡ Performance: ${duration}s for ${totalWorklogs} worklogs = ${avgTime}s per worklog\n`);

    console.log('⏸️  Browser will stay open for 10 seconds for review...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error(`\n❌ Fatal error: ${error}`);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
