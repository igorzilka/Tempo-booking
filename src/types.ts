import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** Project root directory (one level up from dist/) */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Jira issue keys used for worklog distribution.
 * Read from config.json at project root; falls back to defaults if missing.
 */
function loadJiraIssues(): { PRIMARY: string; SECONDARY: string; MANAGEMENT: string } {
  const defaults = { PRIMARY: 'PFLUITS-3554', SECONDARY: 'TAU-96', MANAGEMENT: 'ARTQMPM-171' };
  const configPath = path.join(PROJECT_ROOT, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const issues = raw?.jiraIssues;
    if (issues?.primary && issues?.secondary && issues?.management) {
      return { PRIMARY: issues.primary, SECONDARY: issues.secondary, MANAGEMENT: issues.management };
    }
    console.warn('   ⚠️  config.json missing jiraIssues fields, using defaults.');
    return defaults;
  } catch {
    return defaults;
  }
}

export const JIRA_ISSUES = loadJiraIssues();

export const JIRA_BASE_URL = 'https://jira.uniqagroup.com';
export const TIMEDIFF_URL = `${JIRA_BASE_URL}/secure/TimeDiff.jspa`;

/**
 * Input for creating a worklog entry in Tempo
 */
export interface CreateWorklogInput {
  /** Jira issue key (e.g., "SR-37407") */
  issueKey: string;

  /** Date in YYYY-MM-DD format */
  date: string;

  /** Hours worked (decimal, e.g., 1.5 for 1 hour 30 minutes) */
  hours: number;

  /** Optional description/note for the worklog */
  note?: string;
}

/**
 * Result of worklog creation attempt
 */
export interface CreateWorklogResult {
  /** Status of the operation */
  status: 'created' | 'updated' | 'skipped' | 'failed';

  /** Optional message providing details */
  message?: string;

  /** Optional path to evidence screenshot */
  evidencePath?: string;
}
