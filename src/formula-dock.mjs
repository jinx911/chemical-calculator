import { mountFormulaCalculator } from './formula-page.mjs';

const launch = document.getElementById('open-formulas');
const panel = document.getElementById('formula-dock');
const close = document.getElementById('close-formulas');
const body = document.getElementById('formula-dock-body');
let calculator;

function revealResult(result) {
  const output = result.getBoundingClientRect();
  const viewport = body.getBoundingClientRect();
  if (output.top > viewport.bottom - 85) {
    body.scrollTop += output.top - viewport.top - 12;
  }
}

function toggle(open) {
  launch.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
  if (open) {
    if (!calculator) {
      calculator = mountFormulaCalculator(body, { revealResult });
      calculator.focus();
    } else {
      close.focus({ preventScroll: true });
    }
  } else {
    launch.focus({ preventScroll: true });
  }
}

launch.addEventListener('click', () => toggle(panel.hidden));
close.addEventListener('click', () => toggle(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden && (panel.contains(event.target) || event.target === launch)) {
    event.preventDefault();
    toggle(false);
  }
});
launch.hidden = false;
