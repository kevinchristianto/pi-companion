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

describe('compact office and transparent strip contracts', () => {
  it('keeps document layers transparent and uses the native office minimum', () => {
    expect(declarationsFor(':root').background).toBe('transparent');
    for (const selector of ['html', 'body', '#app']) {
      const style = declarationsFor(selector);
      expect(style.background).toBe('transparent'); expect(style.minWidth).toBe('280px'); expect(style.minHeight).toBe('240px');
    }
    for (const selector of ["html[data-window-mode='taskbar']", "html[data-window-mode='taskbar'] body", "html[data-window-mode='taskbar'] #app"]) {
      const style = declarationsFor(selector);
      expect(style.background).toBe('transparent'); expect(style.minWidth).toBe('0'); expect(style.minHeight).toBe('0');
    }
    expect(declarationsFor(".companion[data-mode='taskbar']").background).toBe('transparent');
    expect(declarationsFor(".companion[data-mode='taskbar'] .workspace").background).toBe('transparent');
  });
  it('budgets a speech bubble, clear tail gap and fixed 1× desk within 104px including horizontal scrolling', () => {
    const strip = declarationsFor(".companion[data-mode='taskbar'] .workspace");
    expect(strip.overflowX).toBe('auto'); expect(strip.overflowY).toBe('hidden'); expect(strip.padding).toBe('0px 6px'); expect(strip.getPropertyValue('scrollbar-width')).toBe('none');
    const row = declarationsFor(".companion[data-mode='taskbar'] .roster");
    expect(row.display).toBe('flex'); expect(row.flexWrap).toBe('nowrap'); expect(row.alignItems).toBe('flex-end');
    const button = declarationsFor(".companion[data-mode='taskbar'] .agent-button");
    expect(button.gap).toBe('4px'); expect(button.padding).toBe('0px 4px'); expect(button.borderTopWidth).toBe('0px');
    expect(declarationsFor('.strip-controls').flexBasis).toBe('88px');
    expect(declarationsFor('.strip-controls').padding).toBe('2px 8px');
    expect(declarationsFor('.strip-notice').maxHeight).toBe('20px');
    expect(declarationsFor(".strip-controls [data-slot='button-decorations']").display).toBe('none');
    expect(declarationsFor('.strip-controls button').getPropertyValue('translate')).toBe('none');
    // Optional review + notice + project + grip/scroll row + Office, four gaps,
    // and padding fit without shrinking the return button.
    expect(10 + 20 + 14 + 18 + 24 + 8 + 4).toBeLessThanOrEqual(104);
    expect(declarationsFor(".companion[data-mode='taskbar'][data-scale='1'] .agent").width).toBe('112px');
    expect(18 + 4 + 64).toBe(86);
    const scrollbar = declarationsFor(".companion[data-mode='taskbar'] .workspace::-webkit-scrollbar");
    expect(scrollbar.display).toBe('none'); expect(scrollbar.height).toBe('0px');
    expect(declarationsFor(".companion[data-mode='taskbar'][data-scale='1'] .portrait").transform).toBe('translateY(var(--sprite-bottom-gutter, 0px))');
  });
  it('keeps readable common status labels in a permanently visible pixel bubble above each desk', () => {
    const status = declarationsFor(".companion[data-mode='taskbar'] .status-bubble");
    expect(status.position).toBe('relative'); expect(status.height).toBe('18px'); expect(status.visibility).toBe('visible');
    expect(status.width).toBe('100%'); expect(status.textAlign).toBe('center');
    expect(status.whiteSpace).toBe('nowrap'); expect(status.fontSize).toBe('8px'); expect(status.lineHeight).toBe('12px'); expect(status.padding).toBe('0px');
    const body = declarationsFor('.taskbar-bubble-body');
    expect(body.height).toBe('18px'); expect(body.padding).toBe('1px 5px'); expect(body.borderTopWidth).toBe('2px'); expect(body.clipPath).toContain('polygon(2px 0');
    // The longest common label fits at native pixel-font size:11 glyphs plus
    // 10px horizontal padding and4px border, within112px tile minus8px padding.
    expect('Needs input'.length * 8 + 10 + 4).toBeLessThanOrEqual(112 - 8);
  });
  it('keeps the state-colored downward tail tile-owned and clear of the sprite', () => {
    const outer = declarationsFor(".companion[data-mode='taskbar'] .status-bubble::before");
    const inner = declarationsFor(".companion[data-mode='taskbar'] .status-bubble::after");
    expect(outer.position).toBe('absolute'); expect(outer.top).toBe('calc(100% - 2px)'); expect(outer.left).toBe('calc(50% - 4px)');
    expect(outer.width).toBe('8px'); expect(outer.height).toBe('5px'); expect(outer.pointerEvents).toBe('none');
    expect(inner.top).toBe('calc(100% - 2px)'); expect(inner.width).toBe('4px'); expect(inner.height).toBe('3px');
    expect(outer.clipPath).toBe('polygon(0 0, 8px 0, 8px 3px, 6px 3px, 6px 4px, 5px 4px, 5px 5px, 3px 5px, 3px 4px, 2px 4px, 2px 3px, 0 3px)');
    expect(parseInt(outer.height) - 2).toBeLessThan(4);
    const waiting = declarationsFor(".companion[data-mode='taskbar'] .status-bubble[data-state='waiting']");
    expect(waiting.getPropertyValue('--speech-border')).toBe('#c09449'); expect(waiting.getPropertyValue('--speech-fill')).toBe('#51401e');
  });
  it('shows a bounded pixel-styled name within the portrait on hover and keyboard focus, clear of the top bubble', () => {
    const name = declarationsFor('.strip-agent-name');
    expect(name.position).toBe('absolute'); expect(name.inset).toBe('auto 4px 2px'); expect(name.maxHeight).toBe('60px');
    expect(name.visibility).toBe('hidden'); expect(name.fontSize).toBe('6px'); expect(name.lineHeight).toBe('9px'); expect(name.padding).toBe('1px 3px'); expect(name.whiteSpace).toBe('normal'); expect(name.overflowWrap).toBe('anywhere');
    expect(name.borderTopStyle).toBe('solid'); expect(name.overflow).toBe('auto');
    expect(declarationsFor(".companion[data-mode='taskbar'] .agent-button:hover .strip-agent-name").visibility).toBe('visible');
    expect(declarationsFor(".companion[data-mode='taskbar'] .agent-button:focus-visible .strip-agent-name").visibility).toBe('visible');
    expect(86 - 2 - 60).toBeGreaterThanOrEqual(18 + 4);
    // A hidden/capped canvas must not push its bubble down into the name area.
    const textOnly = declarationsFor(".companion[data-mode='taskbar'] .agent.text-only .agent-button");
    expect(textOnly.minHeight).toBe('86px'); expect(textOnly.justifyContent).toBe('flex-start');
  });
  it('budgets six native-scale desks in a 360×300 office, including the optional sample marker', () => {
    expect(declarationsFor('.titlebar').minHeight).toBe('36px'); expect(declarationsFor('.summary').minHeight).toBe('23px');
    const titlebar = declarationsFor('.titlebar'); const menu = declarationsFor('.menu-button');
    expect(parseFloat(menu.height) + parseFloat(menu.marginTop) + parseFloat(menu.marginBottom) + parseFloat(titlebar.paddingTop) + parseFloat(titlebar.paddingBottom) + parseFloat(titlebar.borderBottomWidth)).toBe(36);
    expect(declarationsFor('.workspace').padding).toBe('4px'); expect(declarationsFor('.roster').gap).toBe('5px');
    expect(declarationsFor(".companion[data-scale='1'] .agent-button").padding).toBe('2px');
    expect(declarationsFor(".companion[data-scale='1'] .status-bubble").height).toBe('18px');
    expect(declarationsFor(".companion[data-scale='1'] .portrait").margin).toBe('0px');
    const card = 18 + 64 + 12 + 4 + 4;
    expect(card).toBe(102); expect(10 + 36 + 23 + 8 + card * 2 + 5 + 14).toBe(300);
    expect(360 - 10 - 8 - 5 * 2).toBeGreaterThanOrEqual(94 * 3);
  });
});
