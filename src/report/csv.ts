import { CSV_COLUMNS, type LogEvent } from '../types';

function quoteField(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  // RFC 4180: quote whenever the field contains the delimiter, a quote, or a
  // line break; escape embedded quotes by doubling them.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * One row per event, header from CSV_COLUMNS, RFC 4180 quoting, CRLF line
 * endings. Prefixed with a UTF-8 BOM so Excel (which otherwise guesses the
 * system codepage) opens the file as UTF-8 instead of mangling non-ASCII
 * button labels.
 */
export function toCsv(events: LogEvent[]): string {
  const BOM = '﻿';
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const ev of events) {
    const row = CSV_COLUMNS.map((col) => quoteField((ev as unknown as Record<string, unknown>)[col]));
    lines.push(row.join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** yyyy-mm-dd-hhmm in local time, used by both csvFileName and pdfFileName. */
function stamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}`
  );
}

function sanitiseSessionName(sessionName: string): string {
  const cleaned = sessionName
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'session';
}

export function csvFileName(sessionName: string, now: Date = new Date()): string {
  return `${sanitiseSessionName(sessionName)}_${stamp(now)}.csv`;
}

export function pdfFileName(sessionName: string, now: Date = new Date()): string {
  return `${sanitiseSessionName(sessionName)}_${stamp(now)}.pdf`;
}
