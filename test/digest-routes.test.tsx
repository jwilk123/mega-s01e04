import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const night = '2026-10-30';
const originalLaneMarker = process.env.LANE_MARKER;

let runsDir: string;

function app() {
  return createApp({
    adapter: 'shim',
    installed: '2026-10-29T14:06:00+01:00',
    beatEverySeconds: 60,
    runsDir,
  });
}

function writeNight(contents: string, name = `${night}.jsonl`) {
  writeFileSync(join(runsDir, name), contents, 'utf8');
}

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
  process.env.LANE_MARKER = 'DIGEST-TEST-LANE';
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  if (originalLaneMarker === undefined) delete process.env.LANE_MARKER;
  else process.env.LANE_MARKER = originalLaneMarker;
});

describe('digest routes', () => {
  it('serves matching sorted jobs in HTML and JSON, keeping event details safe and visible', async () => {
    writeNight(
      [
        '{malformed line',
        JSON.stringify({ at: '2026-10-30T09:00:00+05:30', job: '<script>alert(1)</script>', status: 'retry', owner: 'Ada', error: '<img src=x onerror=alert(1)>' }),
        JSON.stringify({ at: '2026-10-30T09:01:00+05:30', job: '<script>alert(1)</script>', status: 'retry', owner: 'Ada' }),
        JSON.stringify({ at: '2026-10-30T09:02:00+05:30', job: '<script>alert(1)</script>', status: 'retry', owner: 'Ada' }),
        JSON.stringify({ at: '2026-10-30T09:03:00+05:30', job: '<script>alert(1)</script>', status: 'fail', owner: 'Ada', error: '<img src=x onerror=alert(1)> & <b>latest failure</b>' }),
        JSON.stringify({ at: '2026-10-30T09:04:00+05:30', job: 'beta', status: 'fail', owner: 'Grace', error: 'keep this error' }),
        JSON.stringify({ at: '2026-10-30T09:05:00+05:30', job: 'beta', status: 'ok', owner: null }),
        JSON.stringify({ at: '2026-10-30T09:06:00+05:30', job: 'alpha', status: 'ok', owner: 'Lin' }),
      ].join('\n') + '\n',
    );

    const [htmlResponse, jsonResponse] = await Promise.all([
      app().request(`/digest/${night}`),
      app().request(`/api/digest/${night}`),
    ]);
    const html = await htmlResponse.text();
    const digest = (await jsonResponse.json()) as NightDigest;

    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(digest.rows.map((row) => row.job)).toEqual([
      '<script>alert(1)</script>',
      'alpha',
      'beta',
    ]);

    const escapedJob = '&lt;script&gt;alert(1)&lt;/script&gt;';
    expect(html.indexOf(escapedJob)).toBeLessThan(html.indexOf('alpha'));
    expect(html.indexOf('alpha')).toBeLessThan(html.indexOf('beta'));
    expect(html).toContain('DIGEST-TEST-LANE');
    expect(html).toContain('bad lines: 1');
    expect(html).toContain('—');
    expect(html).toContain('class="warn">3</td>');
    expect(html).toContain('class="warn">fail</td>');

    const dangerousRow = digest.rows[0];
    expect(dangerousRow.retries).toBe(3);
    expect(dangerousRow.lastStatus).toBe('fail');
    expect(dangerousRow.firstAt).toBe('2026-10-30T09:00:00+05:30');
    expect(dangerousRow.lastAt).toBe('2026-10-30T09:03:00+05:30');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;latest failure&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<b>latest failure</b>');

    const beta = digest.rows[2];
    expect(beta.owner).toBeNull();
    expect(beta.lastStatus).toBe('ok');
    expect(beta.lastError).toBe('keep this error');
    expect(beta.firstAt).toBe('2026-10-30T09:04:00+05:30');
    expect(beta.lastAt).toBe('2026-10-30T09:05:00+05:30');
  });

  it('returns 404 for absent nights, invalid calendar dates, and traversal identifiers', async () => {
    const requests = [
      app().request('/digest/2026-10-29'),
      app().request('/api/digest/2026-10-29'),
      app().request('/digest/2026-02-30'),
      app().request('/api/digest/2026-02-30'),
      app().request('/digest/%2e%2e%2fsecret'),
      app().request('/api/digest/%2e%2e%2fsecret'),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it('returns an empty row list and renders “nothing ran” for an empty night', async () => {
    writeNight('');

    const [htmlResponse, jsonResponse] = await Promise.all([
      app().request(`/digest/${night}`),
      app().request(`/api/digest/${night}`),
    ]);
    const html = await htmlResponse.text();
    const digest = (await jsonResponse.json()) as NightDigest;

    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(html).toContain('nothing ran');
    expect(digest.rows).toEqual([]);
    expect(digest.badLines).toBe(0);
  });
});
