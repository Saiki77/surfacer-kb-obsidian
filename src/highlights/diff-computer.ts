/**
 * Simple character-level diff that returns changed ranges.
 * Compares current content against a historical snapshot.
 */

export interface ChangeRange {
  from: number;
  to: number;
}

/**
 * Find ranges in `current` that differ from `previous`.
 * Returns ranges of text that were added or changed.
 */
export function computeChangedRanges(
  previous: string,
  current: string
): ChangeRange[] {
  const ranges: ChangeRange[] = [];
  const minLen = Math.min(previous.length, current.length);

  let i = 0;
  while (i < current.length) {
    if (i < minLen && previous[i] === current[i]) {
      i++;
      continue;
    }

    // Found a difference — find the extent
    const start = i;
    // Skip forward to find where they match again
    // Use a simple sliding window approach
    let matchFound = false;
    for (let j = i + 1; j <= current.length; j++) {
      // Check if the rest matches from this point
      const currentRest = current.slice(j, j + 20);
      const prevIdx = previous.indexOf(currentRest, Math.max(0, start - 50));
      if (currentRest.length >= 10 && prevIdx >= 0) {
        ranges.push({ from: start, to: j });
        i = j;
        matchFound = true;
        break;
      }
    }
    if (!matchFound) {
      // Everything from here to the end is different
      if (start < current.length) {
        ranges.push({ from: start, to: current.length });
      }
      break;
    }
  }

  // Merge overlapping/adjacent ranges
  const merged: ChangeRange[] = [];
  for (const r of ranges) {
    if (merged.length > 0 && r.from <= merged[merged.length - 1].to + 1) {
      merged[merged.length - 1].to = Math.max(merged[merged.length - 1].to, r.to);
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
}
