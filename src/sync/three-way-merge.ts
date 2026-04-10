/**
 * Three-way line-level merge for markdown documents.
 * Uses the base (common ancestor) version to determine what each side changed,
 * then merges non-conflicting changes automatically.
 */

export interface MergeResult {
  success: boolean;
  content: string;
  conflicts: number; // Number of conflicting regions
}

/**
 * Merge local and remote versions using base as common ancestor.
 * Returns merged content with conflict markers if needed.
 */
export function threeWayMerge(
  base: string,
  local: string,
  remote: string
): MergeResult {
  try {
    return doMerge(base, local, remote);
  } catch {
    // If merge fails for any reason, return both with conflict markers
    return {
      success: false,
      content: `<<<<<<< LOCAL\n${local}\n=======\n${remote}\n>>>>>>> REMOTE`,
      conflicts: 1,
    };
  }
}

function doMerge(base: string, local: string, remote: string): MergeResult {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const localDiff = diffLines(baseLines, localLines);
  const remoteDiff = diffLines(baseLines, remoteLines);

  const merged: string[] = [];
  let conflicts = 0;

  const maxBase = baseLines.length;
  let bi = 0; // base index

  while (bi <= maxBase) {
    const localChange = localDiff.get(bi);
    const remoteChange = remoteDiff.get(bi);

    if (!localChange && !remoteChange) {
      // No changes at this line — use base
      if (bi < maxBase) merged.push(baseLines[bi]);
      bi++;
      continue;
    }

    if (localChange && !remoteChange) {
      // Only local changed — accept local
      for (const line of localChange.newLines) merged.push(line);
      bi = localChange.endBase;
      continue;
    }

    if (!localChange && remoteChange) {
      // Only remote changed — accept remote
      for (const line of remoteChange.newLines) merged.push(line);
      bi = remoteChange.endBase;
      continue;
    }

    // Both changed at the same region
    if (localChange && remoteChange) {
      // If they made the same change, no conflict
      if (arraysEqual(localChange.newLines, remoteChange.newLines)) {
        for (const line of localChange.newLines) merged.push(line);
        bi = Math.max(localChange.endBase, remoteChange.endBase);
        continue;
      }

      // Actual conflict — include both with markers
      conflicts++;
      merged.push("<<<<<<< LOCAL");
      for (const line of localChange.newLines) merged.push(line);
      merged.push("=======");
      for (const line of remoteChange.newLines) merged.push(line);
      merged.push(">>>>>>> REMOTE");
      bi = Math.max(localChange.endBase, remoteChange.endBase);
      continue;
    }

    bi++;
  }

  return {
    success: conflicts === 0,
    content: merged.join("\n"),
    conflicts,
  };
}

// ── Line diff engine ────────────────────────────────

interface Change {
  startBase: number; // First base line affected
  endBase: number;   // First base line NOT affected (exclusive)
  newLines: string[];
}

/**
 * Compute a map of base line index → Change for lines that differ.
 * Uses longest common subsequence to find unchanged regions.
 */
function diffLines(
  base: string[],
  modified: string[]
): Map<number, Change> {
  const changes = new Map<number, Change>();
  const lcs = longestCommonSubsequence(base, modified);

  let bi = 0;
  let mi = 0;
  let li = 0;

  while (bi < base.length || mi < modified.length) {
    if (li < lcs.length && bi === lcs[li].baseIdx && mi === lcs[li].modIdx) {
      // This line is unchanged
      bi++;
      mi++;
      li++;
      continue;
    }

    // Find the extent of the changed region
    const startBase = bi;
    const startMod = mi;

    // Advance until we hit the next LCS match
    while (bi < base.length && (li >= lcs.length || bi !== lcs[li].baseIdx)) {
      bi++;
    }
    while (mi < modified.length && (li >= lcs.length || mi !== lcs[li].modIdx)) {
      mi++;
    }

    const newLines = modified.slice(startMod, mi);
    changes.set(startBase, {
      startBase,
      endBase: bi,
      newLines,
    });
  }

  return changes;
}

interface LCSMatch {
  baseIdx: number;
  modIdx: number;
}

/**
 * Find the longest common subsequence of lines.
 * Uses a simple O(n*m) DP approach — fine for documents under 10K lines.
 */
function longestCommonSubsequence(a: string[], b: string[]): LCSMatch[] {
  const m = a.length;
  const n = b.length;

  // Use fast approach for anything non-trivial (>500 lines either side)
  if (m > 500 || n > 500 || m * n > 250_000) {
    return fastLCS(a, b);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the actual subsequence
  const result: LCSMatch[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift({ baseIdx: i - 1, modIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Fast LCS for large documents — hash-based line matching.
 */
function fastLCS(a: string[], b: string[]): LCSMatch[] {
  const bMap = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const line = b[j];
    if (!bMap.has(line)) bMap.set(line, []);
    bMap.get(line)!.push(j);
  }

  const result: LCSMatch[] = [];
  let lastJ = -1;
  for (let i = 0; i < a.length; i++) {
    const positions = bMap.get(a[i]);
    if (!positions) continue;
    for (const j of positions) {
      if (j > lastJ) {
        result.push({ baseIdx: i, modIdx: j });
        lastJ = j;
        break;
      }
    }
  }
  return result;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
