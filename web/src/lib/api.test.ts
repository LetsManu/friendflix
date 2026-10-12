import { describe, expect, it } from 'vitest';
import { backdrop, CARD_WIDTHS, img, srcset } from './api';

const ID = 'a'.repeat(32);

describe('srcset', () => {
  it('builds w-descriptors using the same URLs as img()/backdrop()', () => {
    expect(srcset('Primary', ID, [320, 520])).toBe(`${img(ID, 320)} 320w, ${img(ID, 520)} 520w`);
    expect(srcset('Backdrop', ID, [800, 1280])).toBe(`${backdrop(ID, 800)} 800w, ${backdrop(ID, 1280)} 1280w`);
  });
  it('sorts, de-duplicates and drops invalid widths', () => {
    expect(srcset('Primary', ID, [520, 320, 520, 0, -4, NaN])).toBe(`${img(ID, 320)} 320w, ${img(ID, 520)} 520w`);
    expect(srcset('Primary', ID, [])).toBe('');
  });
  it('card default src (520) is one of the srcset candidates', () => {
    expect(srcset('Backdrop', ID, CARD_WIDTHS)).toContain(backdrop(ID, 520) + ' 520w');
    expect(srcset('Primary', ID, CARD_WIDTHS)).toContain(img(ID, 520) + ' 520w');
  });
});
