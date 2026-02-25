/**
 * Tempo UI utilities - ATTENDED mode authentication only
 * No worklog checking, no duplicate detection - just authentication
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { JIRA_BASE_URL } from './types.js';

/**
 * Launch a headed Chromium browser with standard viewport.
 * Centralises browser config so book-unified and scrape-cli stay in sync.
 */
export async function launchBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Ensure user is authenticated to Jira in ATTENDED mode
 * User must login manually - no credentials stored
 */
export async function ensureAuthenticated(page: Page): Promise<void> {
  console.log('\n🔐 Navigating to Jira...');
  await page.goto(JIRA_BASE_URL, { waitUntil: 'domcontentloaded' });

  const currentUrl = page.url();

  if (currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('sso')) {
    console.log('\n⚠️  ATTENDED MODE: Please complete login and MFA in the browser.');
    console.log('    The script will continue once Jira home is visible.\n');
  }

  try {
    await page.waitForSelector('[role="navigation"], #header', { timeout: 300000, state: 'visible' });
    console.log('✅ Authenticated! Jira home page detected.\n');
  } catch (error) {
    throw new Error('Timeout waiting for login. Please ensure you complete the authentication process.');
  }
}

/**
 * Check if the current page is a login/SSO redirect.
 * If so, wait for the user to re-authenticate before continuing.
 */
export async function waitIfLoginRedirect(page: Page): Promise<void> {
  const url = page.url();
  if (url.includes('login') || url.includes('auth') || url.includes('sso')) {
    console.log('   ⚠️  Session expired — redirected to login. Please re-authenticate in the browser.');
    await page.waitForSelector('[role="navigation"], #header', { timeout: 300000, state: 'visible' });
    console.log('   ✅ Re-authenticated.');
  }
}
