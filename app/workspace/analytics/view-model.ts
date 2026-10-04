import type { Case1Hospital, Case1Region, Case1Signal } from "@/lib/case1-analytics";

export type HospitalSort = "referrals" | "refusal" | "long_wait" | "excess" | "name";
export type RegionSort = "referrals" | "refusal" | "long_wait" | "name";
export type SignalFilter = "all" | "any" | "both" | Case1Signal;

export interface HospitalFilters {
  query: string;
  regionCode: string;
  signal: SignalFilter;
  sort: HospitalSort;
}

function textCompare(left: string, right: string): number {
  return left.localeCompare(right, "ru-RU");
}

function descending(left: number | null | undefined, right: number | null | undefined): number {
  return (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY);
}

export function selectHospitals(hospitals: readonly Case1Hospital[], filters: HospitalFilters): Case1Hospital[] {
  const query = filters.query.trim().toLocaleLowerCase("ru-RU");
  return hospitals
    .filter((hospital) => !query || hospital.name.toLocaleLowerCase("ru-RU").includes(query))
    .filter((hospital) => !filters.regionCode || hospital.region_code === filters.regionCode)
    .filter((hospital) => {
      if (filters.signal === "all") return true;
      if (filters.signal === "any") return hospital.signals.length > 0;
      if (filters.signal === "both") return hospital.signals.length === 2;
      return hospital.signals.includes(filters.signal);
    })
    .sort((left, right) => {
      const ordered = filters.sort === "name" ? textCompare(left.name, right.name)
        : filters.sort === "referrals" ? descending(left.external_24h?.referrals, right.external_24h?.referrals)
          : filters.sort === "refusal" ? descending(left.external_24h?.refusal_pct, right.external_24h?.refusal_pct)
            : filters.sort === "long_wait" ? descending(left.external_24h?.wait_over_30_pct, right.external_24h?.wait_over_30_pct)
              : descending(left.refusal_vs_expected.excess, right.refusal_vs_expected.excess);
      return ordered || textCompare(left.name, right.name);
    });
}

export function sortRegions(regions: readonly Case1Region[], sort: RegionSort): Case1Region[] {
  return [...regions].sort((left, right) => {
    const ordered = sort === "name" ? textCompare(left.name, right.name)
      : sort === "referrals" ? descending(left.external_24h?.referrals, right.external_24h?.referrals)
        : sort === "refusal" ? descending(left.external_24h?.refusal_pct, right.external_24h?.refusal_pct)
          : descending(left.external_24h?.wait_over_30_pct, right.external_24h?.wait_over_30_pct);
    return ordered || textCompare(left.name, right.name);
  });
}
