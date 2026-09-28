/**
 * What the Activity Journal makes of a real corpus.
 *
 * Not a test -- a measurement, for checking that the processors still reduce a
 * journal to something a person would read rather than a second copy of it.
 *
 *   npx tsx packages/activity/tools/stats.mts
 *
 * Reads the local journal folder and prints counts only. No entry content is
 * printed: titles carry system names, body names and organism discoveries.
 */
import { listJournalFiles, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';
import { ActivityEngine, groupActivity } from '@edfm/activity';
import { join } from 'node:path';

const DIR = join(process.env.USERPROFILE!, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
const files = (await listJournalFiles(DIR)).filter((f) => f.sizeBytes > 0);
const engine = new ActivityEngine({ commanderFid: 'F-TEST' });
const entries: any[] = [];
let events = 0;
for (const f of files) {
  const r = await replayFile(f.fullPath);
  events += r.events.length;
  for (const e of r.events) entries.push(...engine.observe(e));
}
const by: Record<string, number> = {};
for (const e of entries) by[e.subtype] = (by[e.subtype] ?? 0) + 1;
console.log('journal files replayed :', files.length);
console.log('journal events         :', events.toLocaleString());
console.log('activity entries       :', entries.length);
console.log('by subtype             :', JSON.stringify(by));
console.log('groups (system/body)   :', groupActivity(entries).length);
console.log('unique ids             :', new Set(entries.map((e) => e.id)).size);
const named = entries.filter((e) => e.subtype === 'sample-completed' && e.bodyName);
const samples = entries.filter((e) => e.subtype === 'sample-completed');
console.log('samples with body name :', `${named.length}/${samples.length}`);
