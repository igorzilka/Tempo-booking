import { Browser } from 'playwright';
import { ensureAuthenticated, launchBrowser } from './tempo-ui.js';
import { scrapeAttendanceFromTimeDiff } from './scrape-attendance.js';

async function main() {
  let browser: Browser | null = null;

  try {
    console.log('\n🚀 Starting attendance scraper in ATTENDED mode...');
    console.log('   You will need to log in manually.\n');

    const launched = await launchBrowser();
    browser = launched.browser;
    const page = launched.page;

    await ensureAuthenticated(page);

    const result = await scrapeAttendanceFromTimeDiff(page);

    if (result.success && result.entries.length > 0) {
      console.log('✅ Success! Scraped', result.entries.length, 'attendance entries.');
      console.log('\nYou can now use this data to book worklogs in Tempo.');
    } else {
      console.log('❌ Failed to scrape attendance data.');
      if (result.errorMessage) {
        console.log('   Error:', result.errorMessage);
      }
    }

    console.log('\n💡 Tip: Check scraped-attendance.json for the full data.\n');

    await page.waitForTimeout(5000);

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
