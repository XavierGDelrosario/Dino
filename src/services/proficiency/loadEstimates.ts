// The one fetch behind services/proficiency/estimate.ts — kept out of the pure module so
// the proficiency facade (and its tests) never import the Supabase client.
import { supabase } from "../../config/supabaseClient";
import { setLevelEstimateBins } from "./estimate";

let loading: Promise<void> | null = null;

/**
 * Fetch the estimate bin table once per app session. Never rejects and never blocks longer
 * than `timeoutMs`: startup waits on it (so the first render already has estimates), but a
 * slow or failing read must not hold the app — it just starts with curated levels only.
 */
export function loadLevelEstimates(timeoutMs = 2500): Promise<void> {
  if (!loading) {
    const fetch = (async () => {
      try {
        const { data, error } = await supabase.rpc("level_estimate_bins");
        if (!error && Array.isArray(data)) setLevelEstimateBins(data);
      } catch {
        // Offline / un-migrated database: curated levels only.
      }
    })();
    loading = Promise.race([fetch, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }
  return loading;
}
