import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import {
  Region, Platform,
  leagueEntriesPaged, leagueListMasterPlus, summonerById,
  matchIdsByPuuid, getMatch
} from "./riot.js";
import {
  aggregateCounts, finalizeOutput, mergeCounts, CompCounts
} from "./aggregate.js";

const {
  RIOT_API_KEY,
  PLATFORM = "NA1",
  REGION = "AMERICAS",
  TIER = "MASTER",
  DIVISION = "I",
  LADDER_PAGES = "5",
  SEED_SUMMONERS = "1000",
  MATCHES_PER = "20",
  MIN_PICKS = "50"
} = process.env as Record<string,string>;

if (!RIOT_API_KEY) { console.error("Missing RIOT_API_KEY"); process.exit(1); }

const outDir = "data";
const outName = `top_comps_${TIER}_${PLATFORM}.json`;
const outPath = path.join(outDir, outName);

// --- helpers ---

async function seedSummonerIds(platform: Platform, tier: string, division: string) {
  if (["CHALLENGER","GRANDMASTER","MASTER"].includes(tier)) {
    const entries = await leagueListMasterPlus(platform, tier as any, RIOT_API_KEY);
    return entries.map(e => e.summarId ?? e.summonerId);
  } else {
    const pages = Number(LADDER_PAGES);
    const ids: string[] = [];
    for (let p=1; p<=pages; p++) {
      const page = await leagueEntriesPaged(platform, tier as any, division as any, p, RIOT_API_KEY);
      for (const e of page) ids.push(e.summonerId);
    }
    return ids;
  }
}

async function toPuuids(platform: Platform, ids: string[], cap: number) {
  const limit = pLimit(12);
  const out = await Promise.all(ids.slice(0, cap).map(id =>
    limit(async () => {
      try { const s = await summonerById(platform, id, RIOT_API_KEY); return s.puuid; }
      catch { return null; }
    })
  ));
  return [...new Set(out.filter(Boolean) as string[])];
}

async function pullMatches(region: Region, puuids: string[], per: number) {
  const limitIds = pLimit(12);
  const idSet = new Set<string>();
  await Promise.all(puuids.map(puuid =>
    limitIds(async () => {
      try {
        const arr = await matchIdsByPuuid(region, puuid, per, RIOT_API_KEY);
        for (const id of arr) idSet.add(id);
      } catch {}
    })
  ));
  const limitMatch = pLimit(8);
  const matches = (await Promise.all([...idSet].map(id =>
    limitMatch(async () => {
      try { return await getMatch(region, id, RIOT_API_KEY); }
      catch { return null; }
    })
  ))).filter(Boolean);
  return matches as any[];
}

// Load previous counts (to accumulate)
async function loadPrevCounts(): Promise<Map<string, CompCounts> | null> {
  try {
    const raw = await fs.readFile(outPath, "utf8");
    const parsed = JSON.parse(raw) as any;
    // convert JSON back to CompCounts structure
    const map = new Map<string, CompCounts>();
    for (const row of parsed.__raw_counts ?? []) {
      const units = new Map<string, Map<number, number>>();
      for (const [cid, arr] of row.units as Array<[string, Array<[number, number]>]>) {
        units.set(cid, new Map<number, number>(arr));
      }
      map.set(`${row.patch}::${row.comp_key}`, {
        patch: row.patch,
        comp_key: row.comp_key,
        picks: row.picks,
        wins: row.wins,
        sumPlacement: row.sumPlacement,
        units,
        unit_set: row.unit_set
      });
    }
    return map;
  } catch { return null; }
}

async function saveSnapshot(counts: Map<string, CompCounts>) {
  await fs.mkdir(outDir, { recursive: true });
  const top = finalizeOutput(counts, Number(MIN_PICKS)).slice(0, 20);

  // persist raw counts for exact accumulation
  const raw_counts = [...counts.values()].map(c => ({
    patch: c.patch,
    comp_key: c.comp_key,
    picks: c.picks,
    wins: c.wins,
    sumPlacement: c.sumPlacement,
    unit_set: c.unit_set,
    units: [...c.units.entries()].map(([cid, bag]) => [cid, [...bag.entries()]])
  }));

  const payload = {
    generated_at: new Date().toISOString(),
    platform: PLATFORM,
    region: REGION,
    tier: TIER,
    division: DIVISION,
    min_picks: Number(MIN_PICKS),
    top20: top,
    __raw_counts: raw_counts
  };

  await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
}

// --- main ---

(async () => {
  console.log(`[Seed] ${TIER} ${DIVISION} on ${PLATFORM}`);
  const summonerIds = await seedSummonerIds(PLATFORM as Platform, TIER, DIVISION);
  const puuids = await toPuuids(PLATFORM as Platform, summonerIds, Number(SEED_SUMMONERS));
  console.log(`[PUUIDs] ${puuids.length}`);

  console.log(`[Pull] matches per puuid = ${MATCHES_PER}`);
  const matches = await pullMatches(REGION as Region, puuids, Number(MATCHES_PER));
  console.log(`[Matches] ${matches.length}`);

  console.log("[Aggregate] new batch");
  const newCounts = aggregateCounts(matches);

  console.log("[Accumulate] merging with previous snapshot (if any)");
  const prev = await loadPrevCounts();
  const merged = prev ? mergeCounts(prev, newCounts) : newCounts;

  console.log("[Save] writing snapshot");
  await saveSnapshot(merged);

  console.log(`[Done] data/${outName}`);
})().catch(e => { console.error(e); process.exit(1); });
