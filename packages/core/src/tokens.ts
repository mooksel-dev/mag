// mag's design tokens, the one source for the app, every canvas and the exported review.html. The v2 set
// (design-system-refresh-tokens-icon.1, docs/workspace-vision-v2.html): grey by default, amber = waits on you,
// accent = the primary or outbound action; neutrals step chrome < canvas < surface < raised.

/** Project colors, readable on light and dark backgrounds; stored on a project as its hex, so the values stay. */
export const PROJECT_COLORS: string[] = ['#e5484d', '#f76b15', '#d6a000', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#7d7d86']

const projectTokens = PROJECT_COLORS.map((c, i) => `--proj-${i + 1}: ${c};`).join(' ')

export const TOKENS_CSS = `
/*
 * v2 tokens: 4px grid, radius 4 / 6 / 8 / 12, 13px text, theme-aware shadows, 5 semantic colours (acc, amber, green,
 * red, blue) with a tint each (-t). The names before v2 (--text, --muted, --accent, --amber-bg…) are aliases at the end
 * of :root, kept for one release so canvases written on them keep rendering.
 */
:root {
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-7: 28px; --sp-8: 32px; --sp-12: 48px;
  --r-xs: 4px; --r-sm: 6px; --r: 8px; --r-md: 8px; --r-lg: 12px; --r-xl: 14px; --r-pill: 999px;
  --fs-xs: 11.5px; --fs-sm: 12px; --fs-md: 13px; --fs-lg: 15px; --fs-xl: 18px; --fs-2xl: 24px;
  --lh: 1.5;
  --row-h: 28px;
  --sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter Tight', 'Segoe UI', system-ui, sans-serif;
  --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
  /* A chevron as a CSS mask, for carets drawn in CSS (::before); its colour is the background under the mask. */
  --icon-chev-r: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m8 5 5 5-5 5'/%3E%3C/svg%3E");
  ${projectTokens}

  --page: #f3f3f5; --chrome: #ececef; --canvas: #ffffff; --surface: #ffffff; --surface-2: #f6f6f8; --raised: #ffffff;
  --line: rgba(16, 18, 30, .08); --line-2: rgba(16, 18, 30, .13); --line-3: rgba(16, 18, 30, .22);
  --hover: rgba(16, 18, 30, .04); --select: rgba(16, 18, 30, .07);
  --t1: #16171b; --t2: #55585f; --t3: #868992; --t4: #b5b7be;
  --acc: #5a51e6; --acc-fg: #4b42d4; --acc-t: rgba(90, 81, 230, .1); --acc-line: rgba(90, 81, 230, .42); --on-acc: #ffffff;
  --amber: #9e5b00; --amber-t: rgba(214, 140, 20, .14);
  --green: #147a46; --green-t: rgba(30, 150, 90, .12);
  --red: #bf372d; --red-t: rgba(210, 60, 50, .1);
  --blue: #2260c4; --blue-t: rgba(37, 99, 201, .1);
  --sh-1: 0 0 0 1px var(--line), 0 1px 2px rgba(16, 18, 30, .05);
  --sh-2: 0 0 0 1px var(--line-2), 0 12px 32px rgba(16, 18, 30, .14);
  --sh-win: 0 0 0 1px rgba(16, 18, 30, .1), 0 24px 64px rgba(16, 18, 30, .16);
  --hi: none;
  --scrim: rgba(21, 23, 28, .45);
  --arch-app-bg: #f3f4f6; --arch-app-line: #c4c8d0; --arch-app-fg: #3d4250;
  --arch-service-bg: #eef1fd; --arch-service-line: #3451d1; --arch-service-fg: #23389c;
  --arch-client-bg: #fdf1e6; --arch-client-line: #c2410c; --arch-client-fg: #8e2e07;
  --arch-lib-bg: #edf6ef; --arch-lib-line: #1d8a4b; --arch-lib-fg: #1d6b3a;
  --arch-lane: #fafafb;
  --arch-edge: #9aa0ad; --arch-error: #c0392b; --arch-warning: #d68910;
  --diff-add: #2fa463; --diff-mod: #d6a23a; --diff-del: #d64545; --diff-move: #7c5ce0;

  /* Aliases of the names before v2: computed on :root, so they follow [data-theme] there. */
  --bg: var(--canvas); --side: var(--chrome); --panel: var(--surface); --subtle: var(--surface-2); --code: var(--surface-2);
  --border: var(--line-2); --row-line: var(--line);
  --text: var(--t1); --muted: var(--t2); --faint: var(--t3);
  --accent: var(--acc); --soft: var(--acc-t); --on-accent: var(--on-acc);
  --status: var(--select); --badge: var(--amber); --on-badge: var(--canvas);
  --shadow: var(--sh-1);
  --amber-bg: var(--amber-t); --amber-fg: var(--amber); --amber-line: color-mix(in srgb, var(--amber) 40%, transparent);
  --violet-bg: var(--acc-t); --violet-fg: var(--acc-fg);
  --info-bg: var(--blue-t); --info-fg: var(--blue);
  --green-bg: var(--green-t); --green-fg: var(--green);
  --danger-bg: var(--red-t); --danger-fg: var(--red); --danger-line: color-mix(in srgb, var(--red) 35%, transparent);
  --warn-bg: var(--amber-t); --warn-fg: var(--amber); --warn-line: var(--amber-line);
  --notice-bg: var(--amber-t); --notice-fg: var(--amber);

  color-scheme: light;
  font-family: var(--sans);
  font-size: var(--fs-md);
  line-height: var(--lh);
  color: var(--t1);
}
[data-theme='dark'] {
  color-scheme: dark;
  --page: #0d0e11; --chrome: #0b0c0e; --canvas: #121316; --surface: #17181c; --surface-2: #1d1e23; --raised: #212228;
  --line: rgba(255, 255, 255, .07); --line-2: rgba(255, 255, 255, .11); --line-3: rgba(255, 255, 255, .18);
  --hover: rgba(255, 255, 255, .04); --select: rgba(255, 255, 255, .075);
  --t1: #edeef1; --t2: #a6a9b2; --t3: #71747d; --t4: #4b4e56;
  --acc: #7c75ff; --acc-fg: #a7a2ff; --acc-t: rgba(124, 117, 255, .15); --acc-line: rgba(124, 117, 255, .5); --on-acc: #ffffff;
  --amber: #f0b45a; --amber-t: rgba(240, 180, 90, .13);
  --green: #4cc98a; --green-t: rgba(76, 201, 138, .13);
  --red: #f0716b; --red-t: rgba(240, 113, 107, .14);
  --blue: #6aacf6; --blue-t: rgba(106, 172, 246, .13);
  --sh-1: 0 0 0 1px var(--line), 0 1px 2px rgba(0, 0, 0, .35);
  --sh-2: 0 0 0 1px var(--line-2), 0 12px 32px rgba(0, 0, 0, .5);
  --sh-win: 0 0 0 1px rgba(255, 255, 255, .08), 0 30px 80px rgba(0, 0, 0, .6);
  --hi: inset 0 1px 0 rgba(255, 255, 255, .035);
  --scrim: rgba(0, 0, 0, .6);
  --arch-app-bg: #23262d; --arch-app-line: #5a606c; --arch-app-fg: #d5d8de;
  --arch-service-bg: #1c2340; --arch-service-line: #6f86ff; --arch-service-fg: #b4c1ff;
  --arch-client-bg: #33221a; --arch-client-line: #e8793f; --arch-client-fg: #f5b48f;
  --arch-lib-bg: #172a1f; --arch-lib-line: #3fbf73; --arch-lib-fg: #8fdcae;
  --arch-lane: #1b1e23;
  --arch-edge: #6b7180; --arch-error: #f06a5a; --arch-warning: #f0a83a;
  --diff-add: #4cc27f; --diff-mod: #e8b54e; --diff-del: #f06a6a; --diff-move: #a58bff;
}
`
