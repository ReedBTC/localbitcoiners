// The Episode Leaderboard's Overall rule, as the homepage's Top Episodes
// rail reads it (assets/js/episode-rank.js). Run: node scripts/test-episode-rank.mjs
import { compRanks, episodeTotals, overallOrder, rankChip, topEpisodes } from '../assets/js/episode-rank.js'

let fails = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { console.log('ok   ' + name); return }
  fails++
  console.log('FAIL ' + name + '\n     got  ' + g + '\n     want ' + w)
}

eq('compRanks shares a place', compRanks([5, 9, 9, 1]), [3, 1, 1, 4])
eq('compRanks empty', compRanks([]), [])

const row = (o) => ({ settled_at: '2026-01-01T00:00:00Z', source: 'boost', sender_npub: null, sender_name: null, total_sats: 100, ...o })
const rows = [
  row({ episode_num: '001', sender_npub: 'npubA', total_sats: 500 }),
  row({ episode_num: '001', sender_npub: 'npubA', total_sats: 500 }),   // same supporter twice: 2 boosts, 1 supporter
  row({ episode_num: '001', sender_name: 'Fountain Fan', total_sats: 10 }),
  row({ episode_num: '001', total_sats: 7 }),                            // anonymous: a head of its own
  row({ episode_num: '001', total_sats: 1000, source: 'zap' }),          // sats only
  row({ episode_num: 2, sender_npub: 'npubB', total_sats: 3000 }),
  row({ episode_num: null, sender_npub: 'npubC', total_sats: 9999 }),    // show-level: skipped
  row({ episode_num: 'abc', sender_npub: 'npubC', total_sats: 9999 }),   // unparseable: skipped
  row({ episode_num: '0', sender_npub: 'npubC', total_sats: 9999 }),     // zero: skipped
  row({ episode_num: '003', sender_npub: 'npubD', total_sats: 1 }),
  row({ episode_num: '003', sender_npub: 'npubE', total_sats: 1 }),
  row({ episode_num: '003', sender_npub: 'npubF', total_sats: 1 }),
]
const totals = episodeTotals(rows).sort((a, b) => a.num - b.num)
eq('episodeTotals', totals, [
  { num: 1, sats: 2017, boosts: 4, supporters: 3 },
  { num: 2, sats: 3000, boosts: 1, supporters: 1 },
  { num: 3, sats: 3, boosts: 3, supporters: 3 },
])

// Ranks: sats 1→2, 2→1, 3→3; boosts 1→1, 2→3, 3→2; supporters 1→1, 2→3, 3→1.
// Scores: ep1 = 4, ep2 = 7, ep3 = 6 → 1, 3, 2.
const order = overallOrder(totals)
eq('overallOrder', order.map((e) => [e.num, e.rank, e.tied]), [[1, 1, false], [3, 2, false], [2, 3, false]])
eq('component ranks', order.map((e) => [e.rankSats, e.rankBoosts, e.rankSupporters]), [[2, 1, 1], [3, 2, 1], [1, 3, 3]])

// A full tie shares a place and the next distinct tuple skips the group.
const tied = overallOrder([
  { num: 5, sats: 10, boosts: 1, supporters: 1 },
  { num: 4, sats: 10, boosts: 1, supporters: 1 },
  { num: 6, sats: 1, boosts: 1, supporters: 1 },
])
eq('full tie shares a place, number breaks display order', tied.map((e) => [e.num, e.rank, rankChip(e)]), [[4, 1, 'T#1'], [5, 1, 'T#1'], [6, 3, '#3']])

// Tie break order on an equal score: supporters, then sats, then boosts.
const tb = overallOrder([
  { num: 1, sats: 100, boosts: 2, supporters: 1 },   // ranks 1,2,2 = 5
  { num: 2, sats: 50, boosts: 3, supporters: 2 },    // ranks 2,1,1 = 4
])
eq('tie break', tb.map((e) => e.num), [2, 1])

eq('topEpisodes cut', topEpisodes(rows, 2).map((e) => e.num), [1, 3])
eq('topEpisodes on nothing', topEpisodes([], 10), [])
eq('topEpisodes tolerates junk rows', topEpisodes([null, {}, { episode_num: '2', total_sats: 'x' }]).map((e) => [e.num, e.sats, e.boosts]), [[2, 0, 1]])

if (fails) { console.log(`\n${fails} failing`); process.exit(1) }
console.log('\nall green')
