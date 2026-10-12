import { describe, expect, it } from 'vitest';
import { barTitles, firstInfoBody, speedLabel } from './bar';

describe('firstInfoBody', () => {
  it('sends saved quality and audio language, the detail-page pick wins', () => {
    expect(firstInfoBody({ quality: 4_000_000, audioLang: 'ger' })).toEqual({ maxBitrate: 4_000_000, audioLang: 'ger' });
    expect(firstInfoBody({ quality: 0, audioLang: 'ger' }, 'eng')).toEqual({ audioLang: 'eng' });
    expect(firstInfoBody({ quality: 0, audioLang: '' })).toEqual({});
    expect(firstInfoBody({ quality: 10 })).toEqual({}); // below the server minimum: auto
  });
});

describe('barTitles', () => {
  it('formats episodes and films', () => {
    expect(barTitles({ name: 'Pilot', seriesName: 'Breaking Bad', indexNumber: 1, parentIndexNumber: 1 })).toEqual({ title: 'Breaking Bad', sub: 'F1 Pilot' });
    expect(barTitles({ name: 'Inception', type: 'Movie' })).toEqual({ title: 'Inception', sub: '' });
    expect(barTitles(null)).toEqual({ title: '', sub: '' });
  });
  it('speed labels', () => {
    expect(speedLabel(1)).toBe('1× (Normal)');
    expect(speedLabel(1.25)).toBe('1,25×');
  });
});
