// Deterministic UI-eval metrics probe. Runs in the page (the browser driver's
// `eval <file>` command, or Playwright `page.evaluate`) and returns a JSON string.
// The thresholds that matter most on mobile (44px tap targets, 16px inputs to
// dodge iOS auto-zoom) are reported for every profile; the vision judge weights
// them by device profile but never re-measures them.
JSON.stringify(
  (() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docW = document.documentElement.scrollWidth;
    const overflow = docW - vw;
    const interactive = [
      ...document.querySelectorAll(
        'a,button,[role="button"],input,select,textarea,[onclick],[tabindex]:not([tabindex="-1"])',
      ),
    ];
    const small = interactive
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          tag: e.tagName,
          label: (e.innerText || e.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 32),
          w: Math.round(r.width),
          h: Math.round(r.height),
          vis: r.width > 0 && r.height > 0,
        };
      })
      .filter((t) => t.vis && (t.w < 44 || t.h < 44));
    const tinyInputs = [...document.querySelectorAll('input,textarea,select')]
      .filter((e) => {
        const fs = Number.parseFloat(getComputedStyle(e).fontSize);
        return fs && fs < 16;
      })
      .map((e) => ({
        tag: e.tagName,
        type: e.getAttribute('type') || '',
        fs: getComputedStyle(e).fontSize,
      }));
    const vp = document.querySelector('meta[name=viewport]')?.content ?? '';
    return {
      path: location.pathname,
      vw,
      vh,
      docW,
      overflow,
      hasHorizScroll: overflow > 1,
      smallTapTargets: small.length,
      smallSample: small.slice(0, 12),
      tinyInputs: tinyInputs.length,
      tinyInputSample: tinyInputs.slice(0, 6),
      viewportMeta: vp,
      viewportFitCover: /viewport-fit=cover/.test(vp),
      interactiveCount: interactive.length,
    };
  })(),
);
