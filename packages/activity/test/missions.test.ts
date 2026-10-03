/**
 * Missions in the Activity Journal.
 *
 * The fixtures here are shaped from Frontier's documented `MissionCompleted`
 * rather than lifted from the corpus, because the machine this was written on
 * has no journal folder. `test/corpus.test.ts` is where the real presence rates
 * get established; what these assert is the behaviour that must hold either
 * way -- that an absent field is absent rather than invented.
 */

import { describe, expect, it } from 'vitest';
import { JournalSessionContext, normalize, parseLine } from '@edfm/elite-journal';

import { ActivityEngine } from '../src/index.js';

const ctx = new JournalSessionContext();
let offset = 0;

function ev(line: string) {
  const parsed = parseLine(line, 'Journal.2026-09-28T120000.01.log', (offset += 100), ctx);
  if (!parsed?.ok) throw new Error('fixture failed to parse');
  return normalize(parsed.event);
}

function engine() {
  const e = new ActivityEngine({ commanderFid: 'F123456' });
  e.observe(
    ev(
      '{ "timestamp":"2026-09-28T12:00:00Z", "event":"FSDJump", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe FH-D d12-45", "SystemAddress":2833504080594, "StarPos":[1,2,3], "JumpDist":8.5, "FuelUsed":0.6, "FuelLevel":31.2 }',
    ),
  );
  return e;
}

const COMPLETED =
  '{ "timestamp":"2026-09-28T13:00:00Z", "event":"MissionCompleted", "Faction":"Eurybia Blue Mafia", "Name":"Mission_Massacre_name", "LocalisedName":"Kill Eurybia Blue Mafia faction Pirates", "MissionID":982745531, "TargetFaction":"Eurybia Blue Mafia", "KillCount":5, "DestinationSystem":"Wregoe FH-D d12-45", "DestinationStation":"Delsanti Hub", "Reward":1452300 }';

const ACCEPTED =
  '{ "timestamp":"2026-09-28T12:30:00Z", "event":"MissionAccepted", "Faction":"Eurybia Blue Mafia", "Name":"Mission_Massacre", "LocalisedName":"Kill Eurybia Blue Mafia faction Pirates", "MissionID":982745531, "KillCount":5, "Reward":1400000, "Expiry":"2026-09-30T12:00:00Z" }';

describe('what a mission records', () => {
  it('records the mission that was handed in, with what it paid', () => {
    const entries = engine().observe(ev(COMPLETED));

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.category).toBe('missions');
    expect(entry.subtype).toBe('mission-completed');
    // What the commander saw in the transaction panel, not `Mission_Massacre_name`.
    expect(entry.title).toBe('Kill Eurybia Blue Mafia faction Pirates');
    expect(entry.detail).toContain('Eurybia Blue Mafia');
    expect(entry.detail).toContain('1,452,300 Cr');
    expect(entry.data['reward']).toBe(1452300);
    expect(entry.data['missionId']).toBe(982745531);
    // The internal name survives, so missions can be grouped by type later.
    expect(entry.data['name']).toBe('Mission_Massacre_name');
  });

  it('records nothing when a mission is merely accepted', () => {
    /*
     * Taking a mission is an intention. A journal of intentions is the parking
     * problem the 463 removed `Touchdown` entries already taught, and the
     * payment is not known until it is handed in anyway.
     */
    expect(engine().observe(ev(ACCEPTED))).toHaveLength(0);
  });

  it('records nothing for a mission failed or abandoned', () => {
    // Things that did not happen are not history.
    const e = engine();
    expect(
      e.observe(
        ev(
          '{ "timestamp":"2026-09-28T13:00:00Z", "event":"MissionFailed", "Name":"Mission_Massacre_name", "MissionID":982745531 }',
        ),
      ),
    ).toHaveLength(0);
    expect(
      e.observe(
        ev(
          '{ "timestamp":"2026-09-28T13:01:00Z", "event":"MissionAbandoned", "Name":"Mission_Massacre_name", "MissionID":982745532 }',
        ),
      ),
    ).toHaveLength(0);
  });

  it('is scoped to the commander, like every other entry', () => {
    expect(engine().observe(ev(COMPLETED))[0]!.commanderFid).toBe('F123456');
  });

  it('derives a stable id from the event, so a replay cannot duplicate it', () => {
    // The entry id IS the journal event id, which is `sourceFile:byteOffset`.
    const entry = engine().observe(ev(COMPLETED))[0]!;
    expect(entry.id).toBe(entry.sources[0]);
    expect(entry.id).toContain('Journal.2026-09-28T120000.01.log');
  });
});

describe('what it refuses to invent', () => {
  it('says nothing about payment when the game reported none', () => {
    /*
     * A donation mission carries no `Reward`. Recording zero would claim the
     * mission paid nothing, which is a different statement from the game not
     * having said -- the distinction this whole journal is built on.
     */
    const noReward = COMPLETED.replace(', "Reward":1452300', '');
    const entry = engine().observe(ev(noReward))[0]!;

    expect(entry.data['reward']).toBeUndefined();
    expect(entry.detail).not.toContain('Cr');
    expect(entry.detail).not.toContain('0');
  });

  it('omits a faction the event did not carry rather than guessing one', () => {
    const noFaction = COMPLETED.replace('"Faction":"Eurybia Blue Mafia", ', '');
    const entry = engine().observe(ev(noFaction))[0]!;
    expect(entry.data['faction']).toBeUndefined();
    expect(entry.detail).toBe('1,452,300 Cr');
  });

  it('falls back to the internal name when there is no localised one', () => {
    const noLocalised = COMPLETED.replace(
      ' "LocalisedName":"Kill Eurybia Blue Mafia faction Pirates",',
      '',
    );
    expect(engine().observe(ev(noLocalised))[0]!.title).toBe('Mission_Massacre_name');
  });

  it('records material and commodity rewards when they are there', () => {
    const withItems = COMPLETED.replace(
      '"Reward":1452300',
      '"Reward":1452300, "MaterialsReward":[ { "Name":"iron", "Name_Localised":"Iron", "Category":"$MICRORESOURCE_CATEGORY_Raw;", "Count":3 } ]',
    );
    const entry = engine().observe(ev(withItems))[0]!;

    expect(entry.data['materialsReward']).toEqual([{ name: 'Iron', count: 3 }]);
    expect(entry.detail).toContain('3 Iron');
  });

  it('drops a reward item with no usable name or count', () => {
    // Half a record is worse than none: it would read as a complete reward.
    const malformed = COMPLETED.replace(
      '"Reward":1452300',
      '"Reward":1452300, "MaterialsReward":[ { "Name":"iron", "Count":"three" }, { "Count":2 } ]',
    );
    expect(engine().observe(ev(malformed))[0]!.data['materialsReward']).toBeUndefined();
  });

  it('ignores a MaterialsReward that is not a list at all', () => {
    const wrongShape = COMPLETED.replace('"Reward":1452300', '"Reward":1452300, "MaterialsReward":5');
    expect(() => engine().observe(ev(wrongShape))).not.toThrow();
    expect(engine().observe(ev(wrongShape))[0]!.data['materialsReward']).toBeUndefined();
  });
});

describe('the colonisation pseudo-mission is not a mission', () => {
  it('is refused, because its id cannot survive being a JavaScript number', () => {
    /*
     * Construction contributions arrive as MissionCompleted with the sentinel
     * id 2^64-1 -- 113 of them in the corpus. It is beyond 2^53, so it is
     * tested by the property rather than the literal: an id that arrived
     * rounded cannot be matched back to its mission, whatever its value.
     */
    const sentinel = COMPLETED.replace('"MissionID":982745531', '"MissionID":18446744073709551615');
    expect(engine().observe(ev(sentinel))).toHaveLength(0);
  });

  it('still accepts an ordinary large mission id', () => {
    const big = COMPLETED.replace('"MissionID":982745531', '"MissionID":9007199254740991');
    expect(engine().observe(ev(big))).toHaveLength(1);
  });
});
