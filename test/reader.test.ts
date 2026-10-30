import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';

const night = '2026-10-28';
const event = {
  at: '2026-10-29T01:00:00+01:00', job: 'lane/sync', status: 'ok', owner: 'rook',
};

describe('readNight', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'rig-reader-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function writeEvents(events: unknown[]) {
    writeFileSync(join(directory, `${night}.jsonl`), events.map(value => JSON.stringify(value)).join('\n'));
  }

  it('reads the real fixture with five sorted jobs, one bad line, and event counts', () => {
    const digest = readNight('runs', night);
    expect(digest?.badLines).toBe(1);
    expect(digest?.counts).toEqual({ ok: 10, retry: 4, fail: 1 });
    expect(digest?.rows.map(row => row.job)).toEqual([
      'digest/render', 'fixtures/refresh', 'lane/sync', 'notes/backup', 'rig/rotate-logs',
    ]);
    expect(digest?.rows[0]).toMatchObject({ owner: null, runs: 1, lastError: null });
    expect(digest?.rows[1]).toEqual({
      job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, lastStatus: 'ok',
      lastError: 'upstream 503', firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
    });
    expect(digest?.rows[2]).toMatchObject({ runs: 8, retries: 1, lastStatus: 'ok', lastError: 'lock held' });
    expect(digest?.rows[3]).toMatchObject({ lastStatus: 'fail', lastError: 'quota exceeded' });
  });

  it('returns null for a missing night and an empty digest for an empty file', () => {
    expect(readNight(directory, night)).toBeNull();
    writeFileSync(join(directory, `${night}.jsonl`), '');
    expect(readNight(directory, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it.each(['../2026-10-28', '..\\2026-10-28', '/2026-10-28', '2026-10-28.jsonl', '2026-10-28\n', '', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00'])('rejects invalid night %s', invalid => {
    expect(readNight(directory, invalid)).toBeNull();
  });

  it('counts malformed JSON and invalid values without losing valid records', () => {
    const invalid = [
      null, [], 3, 'text', {}, { ...event, job: '' }, { ...event, job: '  ' },
      { ...event, job: 3 }, { ...event, owner: undefined }, { ...event, owner: {} },
      { ...event, status: 'unknown' }, { ...event, error: null }, { ...event, error: 5 },
      { ...event, at: '2026-10-29T01:00:00' }, { ...event, at: 'tomorrow' },
      { ...event, at: '2026-02-30T01:00:00Z' }, { ...event, at: '2026-10-29T24:00:00Z' },
      { ...event, at: '2026-10-29T01:00:00+24:00' }, { ...event, at: 0 },
    ];
    const lines = [JSON.stringify(event), '{broken', '', ' ', ...invalid.map(value => JSON.stringify(value)), JSON.stringify({ ...event, owner: null })];
    writeFileSync(join(directory, `${night}.jsonl`), lines.join('\r\n') + '\r\n');
    const digest = readNight(directory, night);
    expect(digest?.badLines).toBe(invalid.length + 3);
    expect(digest?.rows).toHaveLength(1);
    expect(digest?.rows[0]).toMatchObject({ runs: 2, owner: null });
    expect(digest?.counts).toEqual({ ok: 2, retry: 0, fail: 0 });
  });

  it('orders by instants across offsets, retaining the latest error after recovery', () => {
    writeEvents([
      { ...event, at: '2026-10-29T03:00:00+02:00', owner: null },
      { ...event, at: '2026-10-29T00:30:00Z', status: 'fail', error: 'latest error' },
      { ...event, at: '2026-10-29T02:15:00+02:00', status: 'retry', error: 'older error' },
      { ...event, at: '2026-10-29T00:00:00+01:00', owner: 'first owner' },
    ]);
    expect(readNight(directory, night)).toEqual({
      night, badLines: 0, counts: { ok: 2, retry: 1, fail: 1 },
      rows: [{
        job: 'lane/sync', runs: 4, retries: 1, owner: null, lastStatus: 'ok', lastError: 'latest error',
        firstAt: '2026-10-29T00:00:00+01:00', lastAt: '2026-10-29T03:00:00+02:00',
      }],
    });
  });

  it('uses file order to resolve equal instants and preserves an empty error string', () => {
    writeEvents([
      { ...event, status: 'fail', error: 'old' },
      { ...event, at: '2026-10-29T00:00:00Z', owner: null, error: '' },
    ]);
    expect(readNight(directory, night)?.rows[0]).toMatchObject({
      owner: null, lastStatus: 'ok', lastError: '', lastAt: '2026-10-29T00:00:00Z',
    });
  });

  it('accepts leap days and compares submillisecond timestamps', () => {
    writeEvents([
      { ...event, at: '2024-02-29T00:00:00.0009Z', owner: 'latest' },
      { ...event, at: '2024-02-29T00:00:00.0001Z', owner: 'earlier' },
    ]);
    expect(readNight(directory, night)?.rows[0]).toMatchObject({
      owner: 'latest', firstAt: '2024-02-29T00:00:00.0001Z', lastAt: '2024-02-29T00:00:00.0009Z',
    });
  });
});
