// episode-rank.js — the Episode Leaderboard's "Overall" rank, pure.
//
// The stats page's Episode Leaderboard opens on Overall (renderLeaderboard
// in stats.js, a classic script this module cannot be imported by, so the
// rule lives there too, step for step): every ledger row with an episode
// number is summed into that episode's sats; a non-zap row is one boost and
// its npub (else its sender name, else one anonymous head) one supporter;
// each episode's competition rank in sats, in boosts and in supporters is
// summed, lowest total first, ties broken supporters → sats → boosts →
// episode number, and a full tie shares a place. The homepage's Top
// Episodes rail paints the first ten of this order (Reed and Rev,
// 2026-11-08). Change the rule in stats.js and change it here; the weekly
// episodesats note ranks by the same rule in the bots.

// Competition rank of every value in `vals`: 1 + the count strictly ahead,
// so equal values share a place (1, 2, 2, 4). OnlyBoosts' rank.js.
export function compRanks(vals) {
  return vals.map((v) => {
    let ahead = 0
    for (let i = 0; i < vals.length; i++) if (vals[i] > v) ahead++
    return 1 + ahead
  })
}

// One record per episode over the ledger rows: { num, sats, boosts,
// supporters }. Show-level rows (no episode_num) are skipped; a zap adds
// sats and nothing else.
export function episodeTotals(rows) {
  const byEp = new Map()
  for (const row of rows || []) {
    if (row == null || row.episode_num == null) continue
    const num = parseInt(row.episode_num, 10)
    if (!isFinite(num) || num <= 0) continue
    let ep = byEp.get(num)
    if (!ep) { ep = { num, sats: 0, boosts: 0, keys: new Set(), anon: 0 }; byEp.set(num, ep) }
    ep.sats += Number(row.total_sats) || 0
    if (row.source === 'zap') continue
    ep.boosts += 1
    const key = row.sender_npub || row.sender_name
    if (key) ep.keys.add(key)
    else ep.anon += 1
  }
  return Array.from(byEp.values()).map((e) => ({
    num: e.num, sats: e.sats, boosts: e.boosts, supporters: e.keys.size + e.anon,
  }))
}

// The Overall order: the episodes sorted best first, each with `rank` (the
// shared place on a full tie) and `tied`.
export function overallOrder(episodes) {
  const eps = episodes || []
  const rS = compRanks(eps.map((e) => e.sats))
  const rB = compRanks(eps.map((e) => e.boosts))
  const rK = compRanks(eps.map((e) => e.supporters))
  const scored = eps.map((e, i) => ({ ...e, rankSats: rS[i], rankBoosts: rB[i], rankSupporters: rK[i], score: rS[i] + rB[i] + rK[i] }))
  scored.sort((a, b) => a.score - b.score || b.supporters - a.supporters ||
    b.sats - a.sats || b.boosts - a.boosts || a.num - b.num)
  const tup = (x) => `${x.score}|${x.supporters}|${x.sats}|${x.boosts}`
  let runRank = 1
  for (let i = 0; i < scored.length; i++) {
    if (i > 0 && tup(scored[i]) !== tup(scored[i - 1])) runRank = i + 1
    scored[i].rank = runRank
    scored[i].tied = (i > 0 && tup(scored[i]) === tup(scored[i - 1])) ||
      (i + 1 < scored.length && tup(scored[i]) === tup(scored[i + 1]))
  }
  return scored
}

// `#4`, or `T#4` on a shared place: the stats page's chip.
export function rankChip(ep) {
  return (ep.tied ? 'T#' : '#') + ep.rank
}

export function topEpisodes(rows, n = 10) {
  return overallOrder(episodeTotals(rows)).slice(0, n)
}
