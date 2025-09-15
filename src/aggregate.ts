// Aggregation that outputs raw counts (so we can accumulate across runs)
// and derives top items + probabilities.

export type Unit = { character_id: string; items: number[] };
export type Participant = { placement: number; units: Unit[] };
export type MatchInfo = { game_version: string; participants: Participant[] };

export type CompKey = string;

function normalizePatch(v: string): string {
  const m = v.match(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : v;
}

export function compSignature(units: Unit[]): CompKey {
  // Signature keeps per-unit item multiset so AD vs AP forks separate
  const sig = units
    .map(u => `${u.character_id}:${[...u.items].sort((a,b)=>a-b).join('.')}`)
    .sort()
    .join("|");
  return sig;
}

export function unitSet(units: Unit[]): string[] {
  return [...new Set(units.map(u => u.character_id))].sort();
}

type ItemCount = Map<number, number>;
type UnitBag = Map<string, ItemCount>;  // character_id -> itemId -> count

export type CompCounts = {
  patch: string;
  comp_key: CompKey;
  picks: number;
  wins: number;
  sumPlacement: number;
  units: UnitBag;
  unit_set: string[];
};

export type CompOutput = {
  patch: string;
  comp_key: CompKey;
  picks: number;
  avg_placement: number;
  winrate: number;
  unit_set: string[];
  units: Array<{
    character_id: string;
    top_items: number[];
    item_freq: Array<[number, number]>; // [itemId, probability]
  }>;
};

function inc(map: ItemCount, k: number, v = 1){ map.set(k, (map.get(k)||0)+v); }

function freqFromCounts(counts: ItemCount): Array<[number, number]> {
  let total = 0;
  for (const c of counts.values()) total += c;
  const out: Array<[number, number]> = [];
  for (const [id, c] of counts.entries()) out.push([id, total ? c/total : 0]);
  out.sort((a,b)=>b[1]-a[1]);
  return out;
}

export function aggregateCounts(matches: any[]): Map<string, CompCounts> {
  const buckets = new Map<string, CompCounts>(); // key: `${patch}::${comp_key}`

  for (const m of matches) {
    const info: MatchInfo = m.info;
    if (!info?.participants) continue;
    const patch = normalizePatch(info.game_version);

    for (const p of info.participants) {
      const units = (p.units||[]).map((u:any)=>({
        character_id: u.character_id,
        items: Array.isArray(u.items) ? (u.items as number[]) : []
      }));

      const key = `${patch}::${compSignature(units)}`;
      let bag = buckets.get(key);
      if (!bag) {
        bag = {
          patch,
          comp_key: key.split("::")[1],
          picks: 0,
          wins: 0,
          sumPlacement: 0,
          units: new Map(),
          unit_set: unitSet(units)
        };
        buckets.set(key, bag);
      }

      bag.picks += 1;
      if (p.placement === 1) bag.wins += 1;
      bag.sumPlacement += p.placement ?? 9;

      for (const u of units) {
        let itemBag = bag.units.get(u.character_id);
        if (!itemBag) { itemBag = new Map(); bag.units.set(u.character_id, itemBag); }
        for (const it of (u.items||[])) inc(itemBag, it);
      }
    }
  }
  return buckets;
}

export function finalizeOutput(counts: Map<string, CompCounts>, minPicks: number): CompOutput[] {
  const out: CompOutput[] = [];

  for (const [, c] of counts) {
    if (c.picks < minPicks) continue;
    const units = Array.from(c.units.entries()).map(([cid, bag])=>{
      const freq = freqFromCounts(bag);
      return {
        character_id: cid,
        top_items: freq.slice(0,3).map(([id])=>id),
        item_freq: freq
      };
    });

    out.push({
      patch: c.patch,
      comp_key: c.comp_key,
      picks: c.picks,
      avg_placement: +(c.sumPlacement / c.picks).toFixed(2),
      winrate: +(c.wins / c.picks * 100).toFixed(1),
      unit_set: c.unit_set,
      units
    });
  }

  out.sort((a,b)=> a.avg_placement - b.avg_placement || b.picks - a.picks);
  return out;
}

// Merge two CompCounts bags (for accumulation across runs)
export function mergeCounts(base: Map<string, CompCounts>, add: Map<string, CompCounts>) {
  for (const [k, c] of add) {
    const cur = base.get(k);
    if (!cur) { base.set(k, c); continue; }
    cur.picks += c.picks;
    cur.wins += c.wins;
    cur.sumPlacement += c.sumPlacement;
    // merge units
    for (const [cid, bag] of c.units) {
      let dest = cur.units.get(cid);
      if (!dest) { dest = new Map(); cur.units.set(cid, dest); }
      for (const [item, cnt] of bag) inc(dest, item, cnt);
    }
  }
  return base;
}
