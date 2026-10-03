/**
 * Turning missions into activity.
 *
 * ## Only completion is recorded
 *
 * Not acceptance. Taking a mission is an intention, and a journal of intentions
 * is the parking-event problem again -- the 463 `Touchdown` entries that made
 * this feature unreadable and were removed. What a commander did is the mission
 * they finished, and that is also the event the payment arrives on.
 *
 * Failure and abandonment are not recorded either, for the same reason in
 * reverse: they are things that did not happen. The mission store tracks all
 * four outcomes for the live view; only one of them is history worth keeping.
 *
 * ## Nothing here is assumed to be present
 *
 * `MissionCompleted` carries a lot conditionally -- a donation mission has no
 * `Reward`, a courier run has no `MaterialsReward`, a mission for a minor
 * faction may carry no `Faction` this app can use. Only `MissionID` and `Name`
 * are required; every other field is read defensively and simply absent from
 * `data` when the game did not send it.
 *
 * This is deliberately NOT measured against the corpus the way the exobiology
 * rules were, because this container has no journal folder to measure against.
 * The presence rates are therefore unstated rather than guessed, and
 * `test/corpus.test.ts` is where they get established on a machine that has real
 * journals. Until then the code treats everything as optional, which is the
 * behaviour that is correct either way.
 *
 * ## The reward is the one the game paid
 *
 * Taken from `MissionCompleted.Reward`, not from the reward offered at
 * acceptance. They are not always the same -- bonuses, faction effects and
 * partial completions move it -- and the figure worth keeping is what actually
 * landed in the balance. When the event carries no `Reward` at all the entry
 * says nothing about payment rather than recording a zero, because "this paid
 * nothing" and "the game did not say" are different claims.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import type { ActivityContext, ActivityEntry } from './types.js';

function str(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' ? (o[k] as string) : null;
}

function num(o: Record<string, unknown>, k: string): number | null {
  return typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null;
}

/** `12,345,678 Cr`, grouped so a seven-figure payout is readable at a glance. */
function credits(value: number): string {
  return `${value.toLocaleString('en-GB')} Cr`;
}

/**
 * Items handed over as part of the reward.
 *
 * Both `MaterialsReward` and `CommodityReward` are arrays of
 * `{ Name, Name_Localised?, Count }`. Entries without a usable name or count are
 * dropped rather than recorded as partial, and a non-array is ignored outright:
 * the shape is documented but not verified here, so it is checked rather than
 * trusted.
 */
function rewardItems(
  raw: Record<string, unknown>,
  key: string,
): ReadonlyArray<{ name: string; count: number }> {
  const list = raw[key];
  if (!Array.isArray(list)) return [];

  const out: Array<{ name: string; count: number }> = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = str(row, 'Name_Localised') ?? str(row, 'Name');
    const count = num(row, 'Count');
    if (name === null || count === null) continue;
    out.push({ name, count });
  }
  return out;
}

/** `"2 Iron, 1 Nickel"`, or null when nothing usable was reported. */
function itemsLabel(items: ReadonlyArray<{ name: string; count: number }>): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `${i.count} ${i.name}`).join(', ');
}

/**
 * One entry for a mission that was handed in.
 *
 * The title is the mission's own localised name, which is what the commander saw
 * in the transaction panel -- "Kill Eurybia Blue Mafia faction Pirates" rather
 * than `Mission_Massacre_name`. The internal name is kept in `data` so the entry
 * can still be grouped by mission type later without re-parsing the prose.
 */
export function missionEntries(
  event: NormalizedEvent,
  ctx: ActivityContext,
): readonly ActivityEntry[] {
  if (event.source.event !== 'MissionCompleted') return [];
  const raw = event.source.raw as Record<string, unknown>;

  const missionId = num(raw, 'MissionID');
  const name = str(raw, 'Name');
  if (missionId === null || name === null) return [];

  /*
   * Rejects the colonisation pseudo-mission, which is not a mission the
   * commander accepted but how the game models a construction contribution --
   * 113 of them in the corpus. Its sentinel id is 2^64-1, which is beyond what a
   * JavaScript number holds exactly, so the precision check catches it.
   *
   * Tested this way rather than against the literal on purpose. Frontier's
   * MissionID is a u64 and JavaScript loses precision above 2^53, so ANY id that
   * arrives rounded is an id that cannot be matched back to its mission later.
   * Checking the property catches the sentinel and every other such id, instead
   * of one known value and nothing else.
   */
  if (!Number.isSafeInteger(missionId)) return [];

  const localised = str(raw, 'LocalisedName');
  const faction = str(raw, 'Faction');
  const reward = num(raw, 'Reward');
  const donation = num(raw, 'Donated') ?? num(raw, 'Donation');
  const materials = rewardItems(raw, 'MaterialsReward');
  const commodities = rewardItems(raw, 'CommodityReward');

  /*
   * Detail reads as a sentence fragment a person would say: who it was for and
   * what it paid. Anything the event did not report is simply left out, so the
   * line is short rather than padded with "Unknown".
   */
  const parts: string[] = [];
  if (faction !== null) parts.push(faction);
  if (reward !== null && reward > 0) parts.push(credits(reward));
  if (donation !== null && donation > 0) parts.push(`${credits(donation)} donated`);
  const items = itemsLabel([...materials, ...commodities]);
  if (items !== null) parts.push(items);

  const id = event.source.provenance.eventId;

  return [
    {
      id,
      commanderFid: ctx.commanderFid,
      occurredAt: event.source.provenance.timestamp,
      systemName: ctx.systemName,
      systemAddress: ctx.systemAddress,
      bodyName: null,
      bodyId: null,
      // Where it was handed in, when the game says. Not the mission's origin.
      locationName: str(raw, 'DestinationStation'),
      category: 'missions',
      subtype: 'mission-completed',
      title: localised ?? name,
      detail: parts.length > 0 ? parts.join(' · ') : null,
      data: {
        missionId,
        // The internal name, e.g. `Mission_Massacre_name`. Kept so missions can
        // be grouped by type without parsing the localised string.
        name,
        ...(localised !== null ? { localisedName: localised } : {}),
        ...(faction !== null ? { faction } : {}),
        ...(str(raw, 'TargetFaction') !== null ? { targetFaction: str(raw, 'TargetFaction') } : {}),
        // Absent rather than zero when the game reported no payment.
        ...(reward !== null ? { reward } : {}),
        ...(donation !== null ? { donation } : {}),
        ...(materials.length > 0 ? { materialsReward: materials } : {}),
        ...(commodities.length > 0 ? { commodityReward: commodities } : {}),
        ...(str(raw, 'DestinationSystem') !== null
          ? { destinationSystem: str(raw, 'DestinationSystem') }
          : {}),
      },
      sources: [id],
    },
  ];
}
