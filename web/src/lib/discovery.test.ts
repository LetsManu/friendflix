import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeChips, browseQuery, clearRecent, isYear, loadRecent, parseBrowse, pushRecent } from './discovery';

const P = (s: string) => parseBrowse(new URLSearchParams(s));
const ID = 'a'.repeat(32);

describe('parseBrowse', () => {
  it('defaults', () => expect(P('')).toEqual({ genre: '', studio: '', sort: 'SortName', filter: '', decade: null, year: null, minRating: null, person: null, audio: null, subs: null }));
  it('validates audio/subs codes', () => {
    expect(P('audio=deu&subs=ENG')).toMatchObject({ audio: 'deu', subs: 'eng' });
    expect(P('audio=de&subs=english')).toMatchObject({ audio: null, subs: null });
  });
  it('allowlists sort and filter', () => {
    expect(P('sort=Evil&filter=x').sort).toBe('SortName');
    expect(P('sort=CommunityRating&filter=played')).toMatchObject({ sort: 'CommunityRating', filter: 'played' });
  });
  it('validates decade', () => {
    expect(P('decade=1990').decade).toBe(1990);
    expect(P('decade=1995').decade).toBeNull();
    expect(P('decade=1890').decade).toBeNull();
    expect(P('decade=2100').decade).toBeNull();
    expect(P('decade=abc').decade).toBeNull();
  });
  it('validates year and lets it win over decade', () => {
    expect(P('year=1899').year).toBeNull();
    expect(P('year=2100').year).toBe(2100);
    expect(P('year=1999&decade=1990')).toMatchObject({ year: 1999, decade: null });
  });
  it('minRating only 6/7/8', () => {
    expect(P('minRating=7').minRating).toBe(7);
    expect(P('minRating=5').minRating).toBeNull();
    expect(P('minRating=').minRating).toBeNull();
  });
  it('person must be 32 hex', () => {
    expect(P(`person=${ID}`).person).toBe(ID);
    expect(P(`person=${ID.toUpperCase()}`).person).toBe(ID);
    expect(P('person=abc').person).toBeNull();
  });
});

describe('browseQuery', () => {
  it('builds params with desc for date/rating sorts', () => {
    const q = browseQuery(P(`sort=PremiereDate&genre=Drama&decade=2010&minRating=8&person=${ID}&filter=unplayed`), 'Movie', 60, 30);
    expect(Object.fromEntries(q)).toEqual({ types: 'Movie', sort: 'PremiereDate', limit: '30', start: '60', desc: 'true', genre: 'Drama', decade: '2010', minRating: '8', person: ID, filter: 'unplayed' });
  });
  it('passes language params', () => {
    const q = browseQuery(P('audio=deu&subs=eng'), 'Movie', 0, 60);
    expect(q.get('audio')).toBe('deu');
    expect(q.get('subs')).toBe('eng');
    expect(browseQuery(P(''), 'Movie', 0, 60).has('audio')).toBe(false);
  });
  it('no desc for SortName, sends year not decade', () => {
    const q = browseQuery(P('year=2001&decade=2000'), 'Series', 0, 60);
    expect(q.has('desc')).toBe(false);
    expect(q.get('year')).toBe('2001');
    expect(q.has('decade')).toBe(false);
  });
});

describe('activeChips', () => {
  it('lists removable chips with person label', () => {
    const chips = activeChips(P(`genre=Drama&decade=1990&minRating=7&person=${ID}&filter=favorites&sort=DateCreated`), { person: 'Tom' });
    expect(chips.map((c) => c.key)).toEqual(['genre', 'decade', 'minRating', 'person', 'filter']);
    expect(chips.find((c) => c.key === 'person')?.label).toBe('Tom');
    expect(chips.find((c) => c.key === 'decade')?.label).toBe('1990er');
  });
  it('labels language chips in German', () => {
    const chips = activeChips(P('audio=deu&subs=eng'));
    expect(chips.map((c) => [c.key, c.label])).toEqual([['audio', 'Ton: Deutsch'], ['subs', 'UT: Englisch']]);
    expect(activeChips(P('audio=xyz'))[0]?.label).toBe('Ton: XYZ');
  });
  it('person falls back and nothing for defaults', () => {
    expect(activeChips(P(`person=${ID}`))[0]?.label).toBe('Person');
    expect(activeChips(P(''))).toEqual([]);
  });
});

describe('isYear', () => {
  it('accepts 1900..2100 four digits', () => {
    expect(isYear('1999')).toBe(true);
    expect(isYear(' 2100 ')).toBe(true);
    expect(isYear('1899')).toBe(false);
    expect(isYear('2101')).toBe(false);
    expect(isYear('199')).toBe(false);
    expect(isYear('abcd')).toBe(false);
  });
});

describe('recent searches', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  };
  it('dedupes case-insensitively, newest first, max 8', () => {
    store();
    for (const q of ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii']) pushRecent(q);
    expect(loadRecent()).toHaveLength(8);
    expect(pushRecent('EE')[0]).toBe('EE');
    expect(loadRecent().filter((x) => x.toLowerCase() === 'ee')).toHaveLength(1);
  });
  it('ignores short queries and clears', () => {
    store();
    pushRecent('a');
    expect(loadRecent()).toEqual([]);
    pushRecent('abc'); clearRecent();
    expect(loadRecent()).toEqual([]);
  });
  it('survives missing or throwing storage and bad JSON', () => {
    expect(loadRecent()).toEqual([]);
    expect(() => { pushRecent('abc'); clearRecent(); }).not.toThrow();
    vi.stubGlobal('localStorage', { getItem: () => '{oops', setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } });
    expect(loadRecent()).toEqual([]);
    expect(() => { pushRecent('abc'); clearRecent(); }).not.toThrow();
  });
});
