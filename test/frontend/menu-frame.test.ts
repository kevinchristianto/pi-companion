import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles.css', 'utf8');
// These are style-contract checks. jsdom cannot validate browser painting or layout.
const declarationsFor = (selector: string) => {
  const block = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selectors]) => selectors.replace(/\/\*[\s\S]*?\*\//g, '').trim().split(',').map(part => part.trim()).includes(selector));
  if (!block) throw new Error(`Missing stylesheet rule for ${selector}`);
  const element = document.createElement('div');
  element.style.cssText = block[2];
  return element.style;
};

describe('scrollable pixel frame contract', () => {
  it.each(['.office-menu', '.project-menu', '.choice-menu', '.project-options', '.guide'])
    ('keeps %s vertically scrollable with an actual outer border and no horizontal scrolling', selector => {
      const style = declarationsFor(selector);
      expect(style.overflowX).toBe('hidden');
      expect(style.overflowY).toBe('auto');
      expect(style.borderTopStyle).toBe('solid');
      expect(parseInt(style.borderTopWidth, 10)).toBeGreaterThan(0);
    });

  it('gives agent details a taller preferred height while preserving viewport space and a reachable close header', () => {
    const detail = declarationsFor('.detail');
    expect(detail.flexBasis).toBe('55%');
    expect(detail.flexShrink).toBe('1');
    expect(detail.minHeight).toBe('0');
    expect(detail.maxHeight).toBe('min(55%, calc(100dvh - 128px))');
    expect(detail.overflowY).toBe('auto');
    expect(detail.overflowX).toBe('hidden');
    const header = declarationsFor('.detail-head');
    expect(header.position).toBe('sticky');
    expect(header.top).toBe('0px');
    const title = declarationsFor('.detail h2');
    expect(title.maxHeight).toBe('28px');
    expect(title.overflow).toBe('hidden');
    expect(declarationsFor('.detail-head .quiet-button').flexShrink).toBe('0');
  });

  it('retains the intended thin in-flow section separators', () => {
    const style = declarationsFor("[data-slot='dropdown-menu-separator']");
    expect(style.height).toBe('2px');
    expect(style.position).not.toBe('absolute');
    expect(style.position).not.toBe('fixed');
  });
});
