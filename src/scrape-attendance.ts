import { Page } from 'playwright';
import * as fs from 'fs/promises';
import { PROJECT_ROOT } from './types.js';
import { navigateToTimeDiff } from './tempo-ui.js';
import * as path from 'path';

export interface AttendanceEntry {
  date: string;
  attendanceSAP: number;
  tempoLogged?: number;
  difference?: number;
}

export interface ScrapeAttendanceResult {
  success: boolean;
  entries: AttendanceEntry[];
  errorMessage?: string;
}

export async function scrapeAttendanceFromTimeDiff(page: Page): Promise<ScrapeAttendanceResult> {
  console.log('\n📊 Scraping attendance data from TimeDiff page...');

  try {
    console.log('   → Navigating to TimeDiff and waiting for SAP data...');
    await navigateToTimeDiff(page);

    console.log('   → Extracting table data...');

    const entries: AttendanceEntry[] = [];
    const tables = await page.locator('table').all();

    if (tables.length === 0) {
      throw new Error('No tables found on the TimeDiff page.');
    }

    console.log(`   → Found ${tables.length} table(s), attempting to parse...`);

    // Find the table with "Attendance (SAP)" and "Booked (Tempo)" rows
    let attendanceTable = null;
    let dateHeaderRow: string[] = [];
    let sapDataRow: string[] = [];
    let tempoDataRow: string[] = [];

    for (const table of tables) {
      const rows = await table.locator('tr').all();

      if (rows.length === 0) continue;

      // Get first row (date headers like "01T", "02F", etc.)
      const firstRowCells = await rows[0].locator('th, td').allTextContents();
      console.log('   → Table headers:', firstRowCells);

      // Look for both "Attendance (SAP)" and "Booked (Tempo)" rows
      let foundSapRow = false;
      for (let i = 0; i < rows.length; i++) {
        const cells = await rows[i].locator('th, td').allTextContents();
        const label = cells[0]?.toLowerCase() ?? '';

        if (label.includes('attendance') && label.includes('sap')) {
          attendanceTable = table;
          dateHeaderRow = firstRowCells;
          sapDataRow = cells;
          foundSapRow = true;
          console.log(`   ✓ Found "Attendance (SAP)" row with ${cells.length} cells`);
          console.log(`   ✓ Date headers: ${firstRowCells.slice(0, 10).join(', ')}...`);
        } else if (label.includes('booked') && label.includes('tempo')) {
          tempoDataRow = cells;
          console.log(`   ✓ Found "Booked (Tempo)" row with ${cells.length} cells`);
        }
      }

      if (foundSapRow) break;
    }

    if (!attendanceTable || sapDataRow.length === 0) {
      console.log('   ⚠️  Could not find "Attendance (SAP)" row in table.');
      throw new Error('Could not find "Attendance (SAP)" row.');
    }

    // Parse horizontally: match date headers with SAP values
    // Skip first column (row label "Attendance (SAP) in hours")
    // Skip second column (usually sum/total)

    // Determine current month/year from context
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12

    for (let colIndex = 2; colIndex < dateHeaderRow.length && colIndex < sapDataRow.length; colIndex++) {
      const dateHeader = dateHeaderRow[colIndex]?.trim();
      const sapValue = sapDataRow[colIndex]?.trim();

      if (!dateHeader || !sapValue) continue;

      // Extract day number from header like "07W", "08T", "09F"
      const dayMatch = dateHeader.match(/^(\d{1,2})[A-Z]?$/i);
      if (!dayMatch) continue;

      const day = parseInt(dayMatch[1], 10);
      if (day < 1 || day > 31) continue;

      const sapHours = parseHoursFromText(sapValue);
      if (sapHours > 0) {
        const tempoValue = tempoDataRow[colIndex]?.trim() ?? '';
        const tempoHours = parseHoursFromText(tempoValue);
        const dateString = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        entries.push({
          date: dateString,
          attendanceSAP: sapHours,
          tempoLogged: tempoHours,
          difference: parseFloat((sapHours - tempoHours).toFixed(3)),
        });
      }
    }

    console.log(`   ✅ Extracted ${entries.length} attendance entries\n`);

    if (entries.length > 0) {
      console.log('   Date       | SAP Hours | Tempo | Diff');
      console.log('   -----------|-----------|-------|------');
      entries.forEach(e => {
        const tempo = e.tempoLogged !== undefined ? e.tempoLogged.toFixed(2) : '-';
        const diff = e.difference !== undefined ? e.difference.toFixed(2) : '-';
        console.log(`   ${e.date.padEnd(11)}| ${e.attendanceSAP.toFixed(2).padEnd(10)}| ${tempo.padEnd(6)}| ${diff}`);
      });
      console.log('');
    }

    const outputPath = path.join(PROJECT_ROOT, 'scraped-attendance.json');
    await fs.writeFile(outputPath, JSON.stringify(entries, null, 2));
    console.log(`   💾 Saved to: ${outputPath}\n`);

    return {
      success: true,
      entries,
    };

  } catch (error) {
    console.error(`   ❌ Failed to scrape attendance: ${error}\n`);
    return {
      success: false,
      entries: [],
      errorMessage: String(error),
    };
  }
}

function parseHoursFromText(text: string): number {
  if (!text) return 0;

  text = text.trim();

  // Check for decimal format FIRST (e.g., "9.6" or "9,6")
  const decimalText = text.replace(',', '.');
  const decimalMatch = decimalText.match(/^(\d+\.?\d*)$/);
  if (decimalMatch) {
    return parseFloat(decimalMatch[1]);
  }

  // Check for colon format (e.g., "9:36")
  const colonMatch = text.match(/^(\d+):(\d+)$/);
  if (colonMatch) {
    const hours = parseInt(colonMatch[1], 10);
    const minutes = parseInt(colonMatch[2], 10);
    return hours + minutes / 60;
  }

  // Check for hour/minute format (e.g., "9h 36m" or "9h36m")
  const hourMinMatch = text.match(/(\d+)h\s*(\d+)?m?/i);
  if (hourMinMatch) {
    const hours = parseInt(hourMinMatch[1], 10);
    const minutes = hourMinMatch[2] ? parseInt(hourMinMatch[2], 10) : 0;
    return hours + minutes / 60;
  }

  return 0;
}
