import { describe, it, expect } from 'vitest';
import { toCsv, csvFileName, pdfFileName } from '../../src/report/csv';
import { CSV_COLUMNS, type LogEvent } from '../../src/types';

describe('toCsv', () => {
  it('starts with a UTF-8 BOM', () => {
    const csv = toCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('writes the header row from CSV_COLUMNS', () => {
    const csv = toCsv([]);
    const [header] = csv.slice(1).split('\r\n');
    expect(header).toBe(CSV_COLUMNS.join(','));
  });

  it('writes one row per event with empty strings for missing fields', () => {
    const events: LogEvent[] = [
      { id: 1042, ts: '2026-10-14T10:32:07.412+01:00', session_id: '7f3c', visit_id: 'a91e', event: 'button_press', button_id: '4', button_label: 'Sustainability', slide_from: 1, slide_to: 3 },
      { id: 1043, ts: '2026-10-14T10:32:25.832+01:00', session_id: '7f3c', visit_id: 'a91e', event: 'return_home', slide_from: 3, slide_to: 1, method: 'timeout', dwell_ms: 18420 },
    ];
    const csv = toCsv(events);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).toBe('1042,2026-10-14T10:32:07.412+01:00,7f3c,a91e,button_press,4,Sustainability,1,3,,,,');
    expect(lines[2]).toBe('1043,2026-10-14T10:32:25.832+01:00,7f3c,a91e,return_home,,,3,1,timeout,18420,,');
  });

  it('quotes fields containing commas, quotes, or newlines per RFC 4180', () => {
    const events: LogEvent[] = [
      { id: 1, ts: 't1', session_id: 's', event: 'button_press', button_id: 'b1', button_label: 'Say "Hi", Bob\nNext line' },
    ];
    const csv = toCsv(events);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).toContain('"Say ""Hi"", Bob\nNext line"');
  });

  it('leaves plain fields unquoted', () => {
    const events: LogEvent[] = [{ id: 1, ts: 't1', session_id: 's', event: 'button_press', button_id: 'b1', button_label: 'Plain' }];
    const csv = toCsv(events);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).not.toContain('"');
  });

  it('ends with a trailing CRLF and has no extra blank rows for an empty log', () => {
    const csv = toCsv([]);
    const withoutBom = csv.slice(1);
    expect(withoutBom.endsWith('\r\n')).toBe(true);
    expect(withoutBom.split('\r\n')).toEqual([CSV_COLUMNS.join(','), '']);
  });
});

describe('csvFileName / pdfFileName', () => {
  const now = new Date(2026, 9, 14, 10, 32); // months are 0-based: October

  it('sanitises the session name and appends the local timestamp', () => {
    expect(csvFileName('My Cool Session!', now)).toBe('My-Cool-Session_2026-10-14-1032.csv');
    expect(pdfFileName('My Cool Session!', now)).toBe('My-Cool-Session_2026-10-14-1032.pdf');
  });

  it('collapses runs of punctuation and trims leading/trailing dashes', () => {
    expect(csvFileName('  ***weird///name***  ', now)).toBe('weird-name_2026-10-14-1032.csv');
  });

  it('falls back to "session" for a name with no alphanumeric characters', () => {
    expect(csvFileName('!!!', now)).toBe('session_2026-10-14-1032.csv');
  });

  it('zero-pads month, day, hour and minute', () => {
    const early = new Date(2026, 0, 5, 3, 7);
    expect(csvFileName('S', early)).toBe('S_2026-01-05-0307.csv');
  });
});
