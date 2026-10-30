import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, ReadNight, RunStatus } from './types.js';

type RunEvent = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error?: string;
};

function validDate(date: string): boolean {
  if (date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return match !== null && validDate(match[1]) && Number.isFinite(Date.parse(value));
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return validTimestamp(event.at)
    && typeof event.job === 'string' && event.job.trim().length > 0
    && (event.owner === null || typeof event.owner === 'string')
    && (event.status === 'ok' || event.status === 'retry' || event.status === 'fail')
    && (!('error' in event) || typeof event.error === 'string');
}

// Date.parse has millisecond precision; compare the remaining fractional digits
// too, so high precision logs still choose the chronologically latest event.
function compareTime(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  const leftFraction = /\.(\d+)/.exec(left)?.[1] ?? '';
  const rightFraction = /\.(\d+)/.exec(right)?.[1] ?? '';
  const length = Math.max(leftFraction.length, rightFraction.length);
  const a = leftFraction.padEnd(length, '0');
  const b = rightFraction.padEnd(length, '0');
  return a < b ? -1 : a > b ? 1 : 0;
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validDate(night)) return null;

  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }

  const jobs = new Map<string, { row: DigestRow; errorAt: string | null }>();
  const counts = { ok: 0, retry: 0, fail: 0 };
  let badLines = 0;
  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  // A final newline terminates the previous record; it is not another record.
  if (lines.at(-1) === '') lines.pop();

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!isRunEvent(event)) {
      badLines++;
      continue;
    }

    counts[event.status]++;
    let job = jobs.get(event.job);
    if (!job) {
      job = {
        row: {
          job: event.job, owner: event.owner, runs: 0, retries: 0,
          lastStatus: event.status, lastError: null, firstAt: event.at, lastAt: event.at,
        },
        errorAt: null,
      };
      jobs.set(event.job, job);
    }
    const row = job.row;
    row.runs++;
    if (event.status === 'retry') row.retries++;
    if (compareTime(event.at, row.firstAt) < 0) row.firstAt = event.at;
    // Equal timestamps use the last record in the file for status/owner/error.
    if (compareTime(event.at, row.lastAt) >= 0) {
      row.lastAt = event.at;
      row.lastStatus = event.status;
      row.owner = event.owner;
    }
    if (event.error !== undefined
      && (job.errorAt === null || compareTime(event.at, job.errorAt) >= 0)) {
      row.lastError = event.error;
      job.errorAt = event.at;
    }
  }

  const rows = [...jobs.values()].map(({ row }) => row)
    .sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return { night, rows, badLines, counts };
};
