export type RunStatus = 'ok' | 'retry' | 'fail';

/** One job aggregated from the valid events in a night. */
export type DigestRow = {
  job: string;
  /** Owner from the chronologically latest event; null remains a visible missing value. */
  owner: string | null;
  runs: number;
  retries: number;
  lastStatus: RunStatus;
  /** Most recent error, retained even if a later event succeeds. */
  lastError: string | null;
  /** Original timestamp strings, including their offsets; never normalized for display. */
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  night: string;
  /** Sorted by job in deterministic ascending order, shared by HTML and JSON. */
  rows: DigestRow[];
  badLines: number;
  /** Event counts, rather than counts of jobs' final statuses. */
  counts: Record<RunStatus, number>;
};

/**
 * Synchronous reader implemented by reader.ts.
 * Return null for a missing file or an invalid night identifier. An existing empty
 * file returns an empty rows array, zero badLines and zero status counts.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
