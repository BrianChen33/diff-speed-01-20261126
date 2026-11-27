// solve.js — a fast, dependency-free drop-in for makefun-diff 1.0.0.
//
// Own implementation, written from the published rule (RULES.txt and the
// reference's header comment): tokenize on '\n' only, keep the longest common
// prefix then the longest common suffix, exact forward Myers search with the
// deletion-first tie-break and no edge-diagonal pruning, then hunks of 3
// context lines merged when at most 6 kept lines apart. The patch string is
// built from merged operation runs and serialized with a single join.
//
// Design (per the design guidance, advisor only — no code taken from it):
//   * shared Map line interning over the trimmed middles (ids from 1), so the
//     search compares integers in Uint32Array instead of strings;
//   * typed-array frontier + parity-compressed flat trace, no per-state
//     allocations; the search is restricted to the cone
//     d + |k - (N-M)| <= U for a cheap greedy upper bound U (a resyncing
//     greedy alignment; the bound is provably >= the true distance), which
//     cuts the searched states by ~a third while computing exactly the
//     full search's values on the states it keeps; a plain unrestricted
//     Myers with the same tie-break stands by as fallback, storing only
//     packed 1-bit predecessor decisions (plus two frontier rows) instead
//     of an endpoint trace, so its memory is O(D^2) bits, not O(D^2) words;
//   * backtracking recomputes each layer's candidates from the previous
//     layer with the same guards and tie-break, recovering the exact snake
//     lengths — never extending snakes backwards greedily;
//   * fast paths: identical texts, and middles sharing no line id (delete
//     all then insert all — one change run, deletions before insertions,
//     which is exactly what the reference renders there).
//
// No state is kept between run() calls: every per-case structure is built
// inside run(). No Date / random / environment reads: two runs of the same
// input are byte-identical.

const UNREACH = -2;

/** Run kinds (internal). */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * A text's lines, each with its "\n" (the last one without, when the text
 * does not end in one). The empty text has no lines; "\n" has one.
 */
function tokenize(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const idx = text.indexOf('\n', start);
    if (idx === -1) break;
    lines.push(text.slice(start, idx + 1));
    start = idx + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * A valid upper bound on the Myers distance of the interned middles: a
 * greedy alignment that only resyncs on a run of R equal lines, which makes
 * a repeated line less likely to throw it off the true alignment — it only
 * lowers the probability, it cannot guarantee it. The bound's validity does
 * not depend on that: the matched lines form a common subsequence of length
 * `matched`, so (N - matched) + (M - matched) >= D always. The best of two
 * resync lengths is taken; the minimum of valid bounds is valid.
 */
function greedyUpperBound(A, B, N, M) {
  return Math.min(greedyBound(A, B, N, M, 64, 3), greedyBound(A, B, N, M, 64, 2));
}

function greedyBound(A, B, N, M, W, R) {
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < N && j < M) {
    if (A[i] === B[j]) {
      i++;
      j++;
      matched++;
      continue;
    }
    // Resync by deleting: B[j] reappears in A ahead, confirmed by a run of
    // R equal lines. Resync by inserting: A[i] reappears in B ahead.
    let di = -1;
    let dj = -1;
    for (let t = 1; t <= W && i + t + R <= N && j + R <= M; t++) {
      if (A[i + t] === B[j]) {
        let ok = true;
        for (let s = 1; s < R; s++) {
          if (A[i + t + s] !== B[j + s]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          di = t;
          break;
        }
      }
    }
    for (let t = 1; t <= W && j + t + R <= M && i + R <= N; t++) {
      if (B[j + t] === A[i]) {
        let ok = true;
        for (let s = 1; s < R; s++) {
          if (B[j + t + s] !== A[i + s]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          dj = t;
          break;
        }
      }
    }
    if (di === -1 && dj === -1) {
      i++;
      j++;
    } else if (dj === -1 || (di !== -1 && di <= dj)) {
      i += di;
    } else {
      j += dj;
    }
  }
  return N + M - 2 * matched;
}

/**
 * Exact forward Myers on interned id arrays A (length N) and B (length M),
 * both non-empty, sharing at least one id, with A[0] !== B[0].
 * Returns the merged edit runs [{ kind, count }] for the middle.
 *
 * The search is restricted to the cone d + |k - (N-M)| <= U for the greedy
 * upper bound U: a state outside the cone cannot lie on any script of
 * length <= U, and every retained state's predecessors are inside the cone,
 * so the cone search computes exactly the full search's values on the states
 * it keeps (this is not the edge-diagonal pruning the reference forbids —
 * that pruning drops reachable edge diagonals unconditionally). If the bound
 * ever failed (U < D), the search would not terminate by d = U, and the
 * plain search below runs instead.
 */
function myersRuns(A, B, N, M) {
  const U = greedyUpperBound(A, B, N, M);
  const cone = myersRunsCone(A, B, N, M, U);
  if (cone !== null) return cone;
  return myersRunsPlain(A, B, N, M);
}

/** Cone-restricted Myers; returns null when the bound U proves too small. */
function myersRunsCone(A, B, N, M, U) {
  const delta = N - M;
  // Per-layer geometry: layer d holds the diagonals k in
  // [max(-d, delta-(U-d)), min(d, delta+(U-d))] with k = d (mod 2).
  const startK = new Int32Array(U + 2);
  const width = new Int32Array(U + 2);
  const off = new Int32Array(U + 2);
  let total = 0;
  for (let d = 0; d <= U; d++) {
    let lo = -d;
    const clo = delta - (U - d);
    if (clo > lo) lo = clo;
    let hi = d;
    const chi = delta + (U - d);
    if (chi < hi) hi = chi;
    if ((lo - d) % 2 !== 0) lo++;
    if ((hi - d) % 2 !== 0) hi--;
    if (hi < lo) {
      width[d] = 0;
      startK[d] = lo;
      off[d] = total;
      continue;
    }
    width[d] = (hi - lo) / 2 + 1;
    startK[d] = lo;
    off[d] = total;
    total += width[d];
  }
  // Safety valve: the preallocated trace is sized by the bound U, not by
  // the true distance D. If U is loose (a pathological text the greedy
  // cannot track), the cone's full table would be far larger than the search
  // ever reaches; fall back to the plain search, whose decision storage
  // grows only to the layers the search actually visits.
  if (total > 48000000) return null;
  const trace = new Int32Array(total);

  // d = 0: the initial snake from (-1, -1).
  let x = -1;
  let y = -1;
  while (x + 1 < N && y + 1 < M && A[x + 1] === B[y + 1]) {
    x++;
    y++;
  }
  trace[0] = x;
  let D = 0;
  let kFinal = 0;
  if (x + 1 < N || y + 1 < M) {
    let found = false;
    for (let d = 1; d <= U && !found; d++) {
      const w = width[d];
      if (w === 0) continue;
      const sK = startK[d];
      const base = off[d];
      const pOff = off[d - 1];
      const pSK = startK[d - 1];
      const pW = width[d - 1];
      // Predecessor indices in the previous layer: deletion (k-1) is at
      // j + delShift, insertion (k+1) at j + insShift.
      const delShift = (sK - pSK - 1) / 2;
      const insShift = (sK - pSK + 1) / 2;
      for (let j = 0; j < w; j++) {
        const k = sK + 2 * j;
        const jd = j + delShift;
        const ji = j + insShift;
        const vDel = jd >= 0 && jd < pW ? trace[pOff + jd] : UNREACH;
        const vIns = ji >= 0 && ji < pW ? trace[pOff + ji] : UNREACH;
        const canRemove = vDel !== UNREACH && vDel + 1 < N;
        const canAdd = vIns !== UNREACH && vIns - k < M;
        if (!canRemove && !canAdd) {
          trace[base + j] = UNREACH;
          continue;
        }
        // Furthest into the old text wins; the deletion wins ties.
        const byDel = canRemove ? vDel + 1 : -2;
        const byIns = canAdd ? vIns : -2;
        let xv = byDel >= byIns ? byDel : byIns;
        let yv = xv - k;
        while (xv + 1 < N && yv + 1 < M && A[xv + 1] === B[yv + 1]) {
          xv++;
          yv++;
        }
        trace[base + j] = xv;
        if (xv + 1 >= N && yv + 1 >= M) {
          D = d;
          kFinal = k;
          found = true;
          break;
        }
      }
    }
    if (!found) return null;
  }

  // Backtrack from (D, kFinal): at each layer recompute the two candidates
  // from the previous layer with the same guards and tie-break, so the
  // recovered edit and snake length are exactly the forward pass's.
  const rev = [];
  let k = kFinal;
  for (let d = D; d >= 1; d--) {
    const sK = startK[d];
    const base = off[d];
    const j = (k - sK) / 2;
    const xD = trace[base + j];
    const pSK = startK[d - 1];
    const pOff = off[d - 1];
    const pW = width[d - 1];
    const delShift = (sK - pSK - 1) / 2;
    const insShift = (sK - pSK + 1) / 2;
    const jd = j + delShift;
    const ji = j + insShift;
    const vDel = jd >= 0 && jd < pW ? trace[pOff + jd] : UNREACH;
    const vIns = ji >= 0 && ji < pW ? trace[pOff + ji] : UNREACH;
    const canRemove = vDel !== UNREACH && vDel + 1 < N;
    const canAdd = vIns !== UNREACH && vIns - k < M;
    const byDel = canRemove ? vDel + 1 : -2;
    const byIns = canAdd ? vIns : -2;
    let x0;
    let kind;
    if (byDel >= byIns) {
      x0 = byDel;
      kind = DELETE;
      k = k - 1;
    } else {
      x0 = byIns;
      kind = INSERT;
      k = k + 1;
    }
    const snake = xD - x0;
    if (snake > 0) rev.push({ kind: KEEP, count: snake });
    rev.push({ kind, count: 1 });
  }
  const firstSnake = trace[0] + 1;
  if (firstSnake > 0) rev.push({ kind: KEEP, count: firstSnake });

  // Reverse into forward order, merging consecutive runs of one kind.
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i];
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** Plain (unrestricted) Myers, same contract as myersRunsCone. */
function myersRunsPlain(A, B, N, M) {
  // Packed predecessor decisions: only the previous and current endpoint
  // frontier rows are kept (one Int32 entry per diagonal), and for every
  // state the forward pass records a single bit — deletion won (1) or
  // insertion won (0). Decision storage is (D+1)(D+2)/2 bits in total
  // (~11.7 MiB at D = 13,998; ~156 MiB at D = 50,000), held in fixed-size
  // blocks allocated incrementally as layers are reached, so there is no
  // doubling endpoint trace and no unbounded trace growth: the old flat
  // Int32 trace needed (D+1)(D+2)/2 * 4 bytes (>512 MiB at D = 16,384)
  // and briefly held the old and new traces at once while doubling.
  // Backtracking reads the recorded decisions to recover the edit
  // sequence, reverses it, then replays it forward from (-1, -1),
  // greedily extending each forward snake exactly as the forward search
  // did — the replay reproduces the forward pass's path exactly, so the
  // runs are identical to the endpoint-trace version's. The search keeps
  // the same coordinate convention (x = last consumed old index, -1 for
  // none; y = x - k), the same predecessor legality checks, the same
  // deletion-first comparison, and the same greedy snake extension.
  const BLOCK_BITS = 1 << 20; // 1,048,576 decisions per block
  const BLOCK_WORDS = BLOCK_BITS / 32;
  const blocks = [];
  function setDecision(bitIndex, value) {
    if (value === 0) return; // blocks start zero-filled; a 0 bit needs no write
    const b = (bitIndex / BLOCK_BITS) | 0;
    let block = blocks[b];
    if (block === undefined) {
      block = new Uint32Array(BLOCK_WORDS);
      blocks[b] = block;
    }
    const off = bitIndex - b * BLOCK_BITS;
    block[off >>> 5] |= 1 << (off & 31);
  }
  function getDecision(bitIndex) {
    const b = (bitIndex / BLOCK_BITS) | 0;
    const block = blocks[b];
    if (block === undefined) return 0;
    const off = bitIndex - b * BLOCK_BITS;
    return (block[off >>> 5] >>> (off & 31)) & 1;
  }

  // d = 0: the initial snake from (-1, -1).
  let x = -1;
  let y = -1;
  while (x + 1 < N && y + 1 < M && A[x + 1] === B[y + 1]) {
    x++;
    y++;
  }
  let prev = new Int32Array(1);
  prev[0] = x;
  let D = 0;
  let kFinal = 0;
  if (x + 1 < N || y + 1 < M) {
    let found = false;
    for (let d = 1; !found; d++) {
      const cur = new Int32Array(d + 1);
      const baseBit = (d * (d + 1)) / 2;
      for (let k = -d, j = 0; k <= d; k += 2, j++) {
        // Deletion candidate: one old line past the (d-1)-point on k-1,
        // stored at previous-layer index j-1. Insertion candidate: one new
        // line past the (d-1)-point on k+1, at previous-layer index j.
        // A move past the end of either text is no candidate.
        const vDel = j > 0 ? prev[j - 1] : UNREACH;
        const vIns = j < d ? prev[j] : UNREACH;
        const canRemove = vDel !== UNREACH && vDel + 1 < N;
        const canAdd = vIns !== UNREACH && vIns - k < M;
        if (!canRemove && !canAdd) {
          cur[j] = UNREACH;
          continue;
        }
        // Furthest into the old text wins; the deletion wins ties.
        const byDel = canRemove ? vDel + 1 : -2;
        const byIns = canAdd ? vIns : -2;
        let xv;
        if (byDel >= byIns) {
          xv = byDel;
          setDecision(baseBit + j, 1);
        } else {
          xv = byIns;
          // Insertion won: the decision bit stays 0.
        }
        let yv = xv - k;
        while (xv + 1 < N && yv + 1 < M && A[xv + 1] === B[yv + 1]) {
          xv++;
          yv++;
        }
        cur[j] = xv;
        if (xv + 1 >= N && yv + 1 >= M) {
          D = d;
          kFinal = k;
          found = true;
          break;
        }
      }
      prev = cur;
    }
  }

  // Backtrack from (D, kFinal) through the recorded decisions to recover
  // the edit sequence, in reverse order. Every state on the path is
  // reachable (its winning predecessor was a valid candidate), so its
  // decision bit is meaningful; unreachable states are never visited.
  const revEdits = [];
  let k = kFinal;
  for (let d = D; d >= 1; d--) {
    const j = (k + d) / 2;
    if (getDecision((d * (d + 1)) / 2 + j) === 1) {
      revEdits.push(DELETE);
      k = k - 1;
    } else {
      revEdits.push(INSERT);
      k = k + 1;
    }
  }

  // Replay forward from (-1, -1): the initial snake, then each edit in
  // forward order followed by its greedy snake — exactly the forward
  // search's path. Merge consecutive runs of one kind.
  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };
  x = -1;
  y = -1;
  while (x + 1 < N && y + 1 < M && A[x + 1] === B[y + 1]) {
    x++;
    y++;
  }
  pushRun(KEEP, x + 1);
  for (let i = revEdits.length - 1; i >= 0; i--) {
    if (revEdits[i] === DELETE) {
      x++;
      pushRun(DELETE, 1);
    } else {
      y++;
      pushRun(INSERT, 1);
    }
    const xBefore = x;
    while (x + 1 < N && y + 1 < M && A[x + 1] === B[y + 1]) {
      x++;
      y++;
    }
    pushRun(KEEP, x - xBefore);
  }
  return runs;
}

/** One covered line as the patch writes it: op + line, plus a "%" line when the line had no newline. */
function pushWritten(out, op, line) {
  if (line.charCodeAt(line.length - 1) === 10) out.push(op + line);
  else out.push(op + line + '\n%\n');
}

/** Serialize the full runs (over the whole texts a/b) into the patch string. */
function renderPatch(a, b, n, m, runs) {
  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  const changes = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * 3 kept lines apart share one.
  const hunks = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let ci = 0; ci < h.length; ci++) {
      const c = h[ci];
      for (; at < c.o; at++) pushWritten(out, '=', a[at]);
      for (let k = 0; k < c.dels; k++) pushWritten(out, '-', a[c.o + k]);
      for (let k = 0; k < c.ins; k++) pushWritten(out, '+', b[c.p + k]);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) pushWritten(out, '=', a[at]);
  }
  return out.join('');
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // Identical texts: the header line alone.
  if (oldText === newText) {
    return `makefun-diff/1 old=${n} new=${m} hunks=0 deleted=0 inserted=0\n`;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  const N = n - prefix - suffix;
  const M = m - prefix - suffix;

  // Intern the trimmed middles with one shared Map (ids from 1), and note
  // whether they share any line at all.
  const map = new Map();
  const A = new Uint32Array(N);
  const B = new Uint32Array(M);
  let nextId = 1;
  for (let i = 0; i < N; i++) {
    const s = a[prefix + i];
    let id = map.get(s);
    if (id === undefined) {
      id = nextId++;
      map.set(s, id);
    }
    A[i] = id;
  }
  const aIds = nextId - 1;
  let hasCommon = false;
  for (let j = 0; j < M; j++) {
    const s = b[prefix + j];
    let id = map.get(s);
    if (id === undefined) {
      id = nextId++;
      map.set(s, id);
    } else if (id <= aIds) {
      hasCommon = true;
    }
    B[j] = id;
  }

  let midRuns;
  if (!hasCommon) {
    // No line in common: the script deletes every middle old line and
    // inserts every middle new line; the change run lists deletions first.
    midRuns = [];
    if (N > 0) midRuns.push({ kind: DELETE, count: N });
    if (M > 0) midRuns.push({ kind: INSERT, count: M });
  } else {
    midRuns = myersRuns(A, B, N, M);
  }

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (let i = 0; i < midRuns.length; i++) {
    const r = midRuns[i];
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  if (suffix > 0) {
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.kind === KEEP) last.count += suffix;
    else runs.push({ kind: KEEP, count: suffix });
  }
  return renderPatch(a, b, n, m, runs);
}
