/**
 * The Activity Journal screen.
 *
 * Elite writes the machine journal. This is the other one: what the commander
 * did, in their own terms. A flat list of events is precisely what this must not
 * be, so entries are grouped system → body → activity, and a body that saw five
 * things says its name once.
 *
 * Read-only for now. Notes and sessions have schema and no editing UI yet; see
 * docs/ACTIVITY-JOURNAL.md for what is deferred and why.
 */

import { useMemo, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';

import { linksFor, type ActivityCategory, type ActivityGroup } from '@edfm/activity';

import type { CompanionSnapshot } from './lib/companion.js';

const FILTERS = ['All Activity', 'Exobiology', 'Exploration', 'Mining', 'Colonisation'] as const;
type Filter = (typeof FILTERS)[number];

const CATEGORY_OF: Record<Exclude<Filter, 'All Activity'>, ActivityCategory> = {
  Exobiology: 'exobiology',
  Exploration: 'exploration',
  Mining: 'mining',
  Colonisation: 'colonisation',
};

/** `2026-09-28 13:14`. Local time: the commander played in their own timezone. */
function when(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function Journal({ snap }: { snap: CompanionSnapshot }) {
  const [filter, setFilter] = useState<Filter>('All Activity');

  const groups = useMemo<readonly ActivityGroup[]>(() => {
    if (filter === 'All Activity') return snap.activity;
    const wanted = CATEGORY_OF[filter];
    return snap.activity
      .map((g) => ({ ...g, entries: g.entries.filter((e) => e.category === wanted) }))
      .filter((g) => g.entries.length > 0);
  }, [snap.activity, filter]);

  const total = groups.reduce((n, g) => n + g.entries.length, 0);

  return (
    <>
      <section className="card">
        <h2>Journal</h2>
        <p className="muted">
          What you have actually done, built from your game&apos;s journal. Kept on this
          machine and never uploaded.
        </p>

        <div className="row" role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={f === filter ? 'chip chip-on' : 'chip'}
              aria-pressed={f === filter}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </section>

      {total === 0 ? (
        <section className="card">
          <p className="muted">
            {snap.activity.length === 0
              ? 'Nothing recorded yet. Scan an organism, land on a body or map a ring, and it will appear here.'
              : `No ${filter.toLowerCase()} recorded yet.`}
          </p>
        </section>
      ) : (
        groups.map((group) => (
          <section className="card" key={`${group.systemName}|${group.bodyName}|${group.startedAt}`}>
            {/* The system and body are said once, not repeated per entry. */}
            <h2>{group.systemName ?? 'Unknown system'}</h2>
            {group.bodyName && <p className="muted">{group.bodyName}</p>}

            <ul className="activity">
              {group.entries.map((entry) => {
                const links = linksFor(entry);
                return (
                  <li key={entry.id} className="activity-entry">
                    <div className="activity-head">
                      <span className="activity-title">{entry.title}</span>
                      <span className="activity-time">{when(entry.occurredAt)}</span>
                    </div>
                    {entry.detail && <div className="activity-detail">{entry.detail}</div>}

                    {links.length > 0 && (
                      <div className="activity-links">
                        {links.map((link) => (
                          <button
                            key={link.url}
                            type="button"
                            className="link"
                            onClick={() => void openUrl(link.url).catch(() => undefined)}
                          >
                            {link.label}
                          </button>
                        ))}
                      </div>
                    )}

                    {/*
                      Provenance, stated rather than hidden. An entry that cannot
                      be traced back to the events that produced it is one nobody
                      can check -- including the person who wrote the processor.
                    */}
                    <div className="activity-source" title={entry.sources.join(', ')}>
                      from {entry.sources.length} journal{' '}
                      {entry.sources.length === 1 ? 'event' : 'events'}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
