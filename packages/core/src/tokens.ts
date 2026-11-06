// mag's design tokens (redesign-start-screen-big-composer.1), the one source for the app, every canvas and the
// exported review.html (prompts-use-the-models-to.7). Moved here unchanged from the app's styles.css: the redesign owns
// the names and values; this file only makes them reachable from core, where canvases are wrapped.

export const TOKENS_CSS = `
/*
 * One token set (redesign-start-screen-big-composer.1): colours for light and dark, a 4px spacing grid, radius 8 / 12,
 * one type scale. amber = waiting on you, green = an agent working / as planned, accent = the primary action.
 */
:root {
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-7: 28px; --sp-8: 32px;
  --r-sm: 6px; --r: 8px; --r-lg: 12px; --r-xl: 14px; --r-pill: 999px;
  --fs-xs: 11.5px; --fs-sm: 12.5px; --fs-md: 14px; --fs-lg: 15px; --fs-xl: 18px; --fs-2xl: 26px;
  --lh: 1.5;
  --shadow: 0 1px 2px rgba(0, 0, 0, .05), 0 4px 16px rgba(0, 0, 0, .06);
  --bg: #ffffff;
  --side: #f2f2f4;
  --line: #e4e5e9;
  --text: #17181c;
  --muted: #5f6470;
  --faint: #9096a1;
  --accent: #3b5bdb;
  --soft: #e6e9f7;
  --surface: #ffffff;
  --border: #dcdee3;
  --hover: #eef0f3;
  --row-line: #f0f1f3;
  --subtle: #f5f6f8;
  --code: #f0f1f3;
  --panel: #fafafb;
  --on-accent: #ffffff;
  --status: #f0f1f3;
  --badge: #c2410c;
  --on-badge: #ffffff;
  --scrim: rgba(21, 23, 28, .45);
  --amber-bg: #fff4de; --amber-fg: #9a5a00; --amber-line: #f0c77a;
  --violet-bg: #e3e0f7; --violet-fg: #44337a;
  --info-bg: #e6e9f7; --info-fg: #2c3a8c;
  --green-bg: #e5f4ea; --green-fg: #1f7a47;
  --danger-bg: #fdecea; --danger-fg: #b8352a; --danger-line: #f2c4c4;
  --warn-bg: #fff6e5; --warn-fg: #6b4a08; --warn-line: #f1d9a6;
  --notice-bg: #fdf0e9; --notice-fg: #8e2e07;
  --arch-app-bg: #f3f4f6; --arch-app-line: #c4c8d0; --arch-app-fg: #3d4250;
  --arch-service-bg: #eef1fd; --arch-service-line: #3451d1; --arch-service-fg: #23389c;
  --arch-client-bg: #fdf1e6; --arch-client-line: #c2410c; --arch-client-fg: #8e2e07;
  --arch-lib-bg: #edf6ef; --arch-lib-line: #1d8a4b; --arch-lib-fg: #1d6b3a;
  --arch-lane: #fafafb;
  --arch-edge: #9aa0ad; --arch-error: #c0392b; --arch-warning: #d68910;
  --diff-add: #2fa463; --diff-mod: #d6a23a; --diff-del: #d64545; --diff-move: #7c5ce0;
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, 'Inter Tight', system-ui, sans-serif;
  font-size: var(--fs-md);
  line-height: var(--lh);
  color: var(--text);
}
[data-theme='dark'] {
  color-scheme: dark;
  --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 6px 20px rgba(0, 0, 0, .35);
  --bg: #1a1b1f;
  --side: #17181b;
  --line: #2a2c32;
  --text: #e8e9ec;
  --muted: #a0a5b0;
  --faint: #6d727d;
  --accent: #7d95ff;
  --soft: #232a45;
  --surface: #1f2025;
  --border: #34363d;
  --hover: #26272d;
  --row-line: #24262b;
  --subtle: #222328;
  --code: #26272d;
  --panel: #18191d;
  --on-accent: #0f1220;
  --status: #26272d;
  --badge: #c2410c;
  --on-badge: #ffffff;
  --scrim: rgba(0, 0, 0, .6);
  --amber-bg: #33270f; --amber-fg: #f2b860; --amber-line: #6b5020;
  --violet-bg: #2e2846; --violet-fg: #c4b8f5;
  --info-bg: #232a45; --info-fg: #a9b8ff;
  --green-bg: #15301f; --green-fg: #62cf8f;
  --danger-bg: #3a1d1b; --danger-fg: #f07b6e; --danger-line: #5a2a2d;
  --warn-bg: #33290f; --warn-fg: #eacb85; --warn-line: #5a4718;
  --notice-bg: #3a2318; --notice-fg: #f0a77e;
  --arch-app-bg: #23262d; --arch-app-line: #5a606c; --arch-app-fg: #d5d8de;
  --arch-service-bg: #1c2340; --arch-service-line: #6f86ff; --arch-service-fg: #b4c1ff;
  --arch-client-bg: #33221a; --arch-client-line: #e8793f; --arch-client-fg: #f5b48f;
  --arch-lib-bg: #172a1f; --arch-lib-line: #3fbf73; --arch-lib-fg: #8fdcae;
  --arch-lane: #1b1e23;
  --arch-edge: #6b7180; --arch-error: #f06a5a; --arch-warning: #f0a83a;
  --diff-add: #4cc27f; --diff-mod: #e8b54e; --diff-del: #f06a6a; --diff-move: #a58bff;
}
`
