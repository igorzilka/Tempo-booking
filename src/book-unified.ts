/**
 * UNIFIED BOOKING - Scrape + Book in one session
 * Avoids double login by reusing the same browser session
 */

import { Browser, Page } from 'playwright';
import { ensureAuthenticated, launchBrowser, waitIfLoginRedirect } from './tempo-ui.js';
import { scrapeAttendanceFromTimeDiff, AttendanceEntry } from './scrape-attendance.js';
import { CreateWorklogInput, CreateWorklogResult, JIRA_BASE_URL, JIRA_ISSUES, PROJECT_ROOT } from './types.js';
import * as fs from 'fs';
import * as path from 'path';

interface WorklogDistribution {
  issueKey: string;
  hours: number;
  note: string;
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

  if (isEven) {
    // EVEN: 50/50 split
    const halfHours = sapHours / 2;
    return [
      {
        issueKey: JIRA_ISSUES.PRIMARY,
        hours: parseFloat(halfHours.toFixed(3)),
        note: 'Daily work (50% split)',
      },
      {
        issueKey: JIRA_ISSUES.SECONDARY,
        hours: parseFloat(halfHours.toFixed(3)),
        note: 'Daily work (50% split)',
      },
    ];
  } else {
    // ODD: 1h to management, rest split 50/50
    const remainder = sapHours - 1.0;
    const halfRemainder = remainder / 2;
    return [
      {
        issueKey: JIRA_ISSUES.MANAGEMENT,
        hours: 1.0,
        note: 'Management',
      },
      {
        issueKey: JIRA_ISSUES.PRIMARY,
        hours: parseFloat(halfRemainder.toFixed(3)),
        note: 'Daily work (50% split)',
      },
      {
        issueKey: JIRA_ISSUES.SECONDARY,
        hours: parseFloat(halfRemainder.toFixed(3)),
        note: 'Daily work (50% split)',
      },
    ];
  }
}

async function createWorklogFast(page: Page, input: CreateWorklogInput): Promise<CreateWorklogResult> {
  const { issueKey, date, hours, note } = input;

  console.log(`📝 ${issueKey} (${hours}h)`);

  try {
    const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;
    await page.goto(issueUrl, { waitUntil: 'domcontentloaded' });

    // If SSO session expired, wait for re-authentication then reload the issue page
    if (page.url().includes('login') || page.url().includes('auth') || page.url().includes('sso')) {
      await waitIfLoginRedirect(page);
      await page.goto(issueUrl, { waitUntil: 'domcontentloaded' });
    }

    // Wait for page to be ready
    await page.waitForSelector('#summary-val, [data-testid="issue.views.issue-base.foundation.summary.heading"]', {
      timeout: 10000,
      state: 'visible'
    });

    // Click "Log Work" button
    const logWorkButton = page.locator('a:has-text("Log Work")').first();
    await logWorkButton.click();

    // Wait for dialog
    await page.waitForSelector('h2:has-text("Log Work")', {
      timeout: 5000,
      state: 'visible'
    });

    // Fill Time Spent field
    const timeSpentSelectors = [
      'label:has-text("Time Spent") + input',
      'label:has-text("Time Spent") ~ input',
      'input[placeholder*="3w 4d 12h"]',
      'input[id*="log-work"][id*="time"]',
    ];

    let timeFieldFilled = false;
    for (const selector of timeSpentSelectors) {
      try {
        const timeField = page.locator(selector).first();
        if (await timeField.isVisible({ timeout: 1500 })) {
          await timeField.clear();
          await timeField.fill(`${hours}h`);
          timeFieldFilled = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!timeFieldFilled) {
      throw new Error('Could not find Time Spent field');
    }

    // Fill Date Started field
    const [year, month, day] = date.split('-');
    const formattedDate = `${day}.${month}.${year} 09:00`;

    const dateSelectors = [
      'label:has-text("Date Started") + input',
      'label:has-text("Date Started") ~ input',
      'input[id*="date"][id*="start"]',
      'input[placeholder*="date"]',
    ];

    let dateFieldFilled = false;
    for (const selector of dateSelectors) {
      try {
        const dateField = page.locator(selector).first();
        if (await dateField.isVisible({ timeout: 1500 })) {
          await dateField.clear();
          await dateField.fill(formattedDate);
          dateFieldFilled = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!dateFieldFilled) {
      throw new Error('Could not find Date Started field');
    }

    // Fill description if provided
    if (note) {
      const descSelectors = [
        'textarea[id*="description"]',
        'label:has-text("Work Description") + textarea',
      ];

      for (const selector of descSelectors) {
        try {
          const descField = page.locator(selector).first();
          if (await descField.isVisible({ timeout: 1500 })) {
            await descField.clear();
            await descField.fill(note);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    // Click "Log" button
    const submitBtn = page.locator('button:text-is("Log")').last();
    await submitBtn.click();

    // CRITICAL: Wait for success or error indicator
    // Selector promises swallow rejections so only the timeout fallback resolves
    // when neither selector matches (avoids non-deterministic Promise.race behavior)
    const result = await Promise.race([
      page.waitForSelector('.aui-message.aui-message-success, [data-testid="issue.views.common.flag-message.success"]', {
        timeout: 6000,
        state: 'visible'
      }).then(() => 'success' as const).catch(() => new Promise<never>(() => {})),
      page.waitForSelector('.aui-message.aui-message-error, .error, [role="alert"]:has-text("error"), [role="alert"]:has-text("failed")', {
        timeout: 6000,
        state: 'visible'
      }).then(() => 'error' as const).catch(() => new Promise<never>(() => {})),
      page.waitForTimeout(5000).then(() => 'timeout' as const)
    ]);

    if (result === 'success') {
      console.log(`   ✅ ${issueKey} SUCCESS`);
      return {
        status: 'created',
        message: `Worklog created: ${hours}h on ${date}`,
      };
    } else if (result === 'error') {
      throw new Error('Jira showed error message after submit');
    } else {
      throw new Error('Timeout: No success or error message detected');
    }

  } catch (error) {
    console.error(`   ❌ ${issueKey} FAILED: ${error}`);

    // Screenshot ONLY ON FAILURE
    try {
      const artifactsDir = path.join(PROJECT_ROOT, 'artifacts');
      if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(artifactsDir, `error-${issueKey}-${date}-${timestamp}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`   📸 Screenshot: ${screenshotPath}`);
    } catch {}

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

      if (fs.existsSync(ATTENDANCE_FILE)) {
        try {
          const existingData = JSON.parse(fs.readFileSync(ATTENDANCE_FILE, 'utf-8'));
          if (Array.isArray(existingData) && existingData.length > 0) {
            allAttendance = existingData;
            console.log(`   ✅ Loaded ${allAttendance.length} entries from ${ATTENDANCE_FILE}\n`);
          } else {
            console.error('   ❌ Existing file is empty or invalid.');
            process.exit(1);
          }
        } catch (error) {
          console.error(`   ❌ Failed to read existing file: ${error}`);
          process.exit(1);
        }
      } else {
        console.error('   ❌ No existing attendance data found.');
        console.error('   💡 Run without --skip-scrape to fetch fresh data.');
        process.exit(1);
      }
    } else {
      console.log('🔄 STEP 1: Scraping attendance data...\n');

      // Backup existing file before scraping
      let backupData: AttendanceEntry[] = [];
      if (fs.existsSync(ATTENDANCE_FILE)) {
        try {
          backupData = JSON.parse(fs.readFileSync(ATTENDANCE_FILE, 'utf-8'));
        } catch {}
      }

      // Scrape attendance data using the same authenticated session
      const scrapeResult = await scrapeAttendanceFromTimeDiff(page);

      if (!scrapeResult.success || scrapeResult.entries.length === 0) {
        console.warn('\n⚠️  Failed to scrape attendance data.');
        console.warn(`   Error: ${scrapeResult.errorMessage || 'No entries found'}`);

        // Restore backup if available
        if (backupData.length > 0) {
          console.warn('   ℹ️  Restoring backup data...');
          fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify(backupData, null, 2));
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

    // Book worklogs
    const results: BookingResult[] = [];
    const startTime = Date.now();

    for (let i = 0; i < targetAttendance.length; i++) {
      const entry = targetAttendance[i];
      const distribution = distributeHours(entry.attendanceSAP);

      console.log(`[${i + 1}/${targetAttendance.length}] ${entry.date} (${entry.attendanceSAP}h)`);
      console.log('──────────────────────────────────────────────────');

      for (const wl of distribution) {
        const input: CreateWorklogInput = {
          issueKey: wl.issueKey,
          date: entry.date,
          hours: wl.hours,
          note: wl.note,
        };

        const result = await createWorklogFast(page, input);

        results.push({
          date: entry.date,
          issueKey: wl.issueKey,
          hours: wl.hours,
          status: result.status,
          message: result.message,
        });

        await page.waitForTimeout(400); // Small delay between worklogs
      }

      if (i < targetAttendance.length - 1) {
        await page.waitForTimeout(800); // Delay between dates
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
    fs.writeFileSync(resultsFileName, JSON.stringify(results, null, 2));
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
