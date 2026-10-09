import type { Report } from '../analytics/report';
import { PILLARS } from '../analytics/score';
import { badges } from '../analytics/service';
import { h } from './dom';
import { howButton } from './layout';

const pillarColor = (p: number) => (p >= 70 ? 'var(--band-good)' : p >= 50 ? 'var(--band-warn)' : 'var(--band-bad)');

/** The Overflow Score block: number, grade, verdict, pillars, strengths, fixes and flags. */
export function scoreHero(r: Report, o: { filtered?: boolean; combined?: number; extraBox?: HTMLElement | null } = {}) {
  const sc = r.score;
  const left = h('div', { class: 'score-main' });
  const num = h('div', { class: 'score-num', 'aria-label': sc.score == null ? 'No score yet' : `Overflow Score ${sc.score} out of 100` });
  if (sc.score == null) num.textContent = '—';
  else num.append(String(sc.score), h('small', {}, '/100'));
  left.append(
    num,
    h('div', { class: 'score-tier' }, h('span', { class: 'grade' }, sc.grade), h('span', { class: 'tier-label' }, sc.label)),
    h('p', { class: 'verdict' }, sc.verdict),
    h('div', { class: 'worth' }, h('span', {}, 'Worth trading long-term?'), h('b', {}, sc.worthIt)),
  );
  const bs = badges(r);
  if (bs.length) left.append(h('div', { class: 'badges' }, ...bs.map((b) => h('span', { class: `badge${b.id === 'allweather' ? ' accent' : ''}`, title: b.title }, b.label))));
  const howMount = h('div', {});
  left.append(
    h('div', { class: 'row-btns' }, howButton('score', 'score-hero', (p) => { howMount.innerHTML = ''; if (p) howMount.append(p); }), h('a', { href: '#/methodology', class: 'small' }, 'How the score works →')),
    howMount,
  );

  // pillars
  const pillHow = h('div', {});
  const pillars = h('div', { class: 'pillars' });
  for (const p of sc.pillars) {
    const def = PILLARS.find((d) => d.id === p.id);
    const pts = p.points;
    const wrap = h('div', { class: 'pillar' });
    const btn = h('button', { type: 'button', 'aria-expanded': 'false' },
      h('span', {}, p.label, h('em', {}, `${p.weight}%`)),
      h('span', { class: 'bar' }, h('i', { style: `width:${pts == null ? 0 : Math.max(2, pts)}%;--c:${pillarColor(pts ?? 0)}` })),
      h('span', { class: 'pts' }, pts == null ? '—' : String(Math.round(pts))),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '▶'),
    );
    const rows = p.metrics.map((m) => {
      const md = def?.metrics.find((x) => x.id === m.id);
      return h('tr', {},
        h('td', { title: md?.about ?? '' }, m.label),
        h('td', { class: m.points == null ? 'na' : '' }, m.points == null ? (md?.requires ? `needs ${md.requires}` : '—') : m.display),
        h('td', { class: m.points == null ? 'na' : '' }, m.points == null ? 'n/a' : `${Math.round(m.points)} pts`),
        h('td', { class: 'na' }, `${Math.round(m.weight * 100)}%`));
    });
    const detail = h('div', { class: 'pillar-detail' },
      h('p', {}, p.question + (pts == null ? ' Not enough data yet — this pillar is left out of the score for now.' : '')),
      h('table', {}, h('tbody', {}, ...rows)));
    btn.onclick = () => {
      const open = wrap.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    };
    wrap.append(btn, detail);
    pillars.append(wrap);
  }

  const li = (s: string, c = '') => h('li', { class: c }, s);
  const strengths = h('div', { class: 'score-box good' }, h('h5', {}, 'Strengths'),
    sc.strengths.length ? h('ul', {}, ...sc.strengths.map((s) => li(s))) : h('p', { class: 'empty' }, 'No standout pillar yet (80+ points).'));
  const todo = h('div', { class: 'score-box todo' }, h('h5', {}, 'What to improve'),
    sc.suggestions.length ? h('ul', {}, ...sc.suggestions.map((s) => li(s))) : h('p', { class: 'empty' }, 'Nothing urgent — keep collecting trades.'));
  const hit = sc.gates.filter((g) => g.hit);
  const binding = sc.raw != null && sc.score != null ? hit.filter((g) => g.cap < sc.raw!) : [];
  const flagsHow = h('div', {});
  const flags = h('div', { class: 'score-box flags' },
    h('div', { class: 'card-title' }, h('h5', {}, 'Caps & flags'), h('div', { class: 'tools-r' }, howButton('gates', 'score-gates', (p) => { flagsHow.innerHTML = ''; if (p) flagsHow.append(p); }))),
    flagsHow,
    hit.length
      ? h('ul', {}, ...hit.map((g) => {
          const capTxt = binding.includes(g) ? ` Caps the score at ${g.cap}.` : '';
          return h('li', { class: 'hit' }, h('b', {}, g.label), ` — ${g.detail}${capTxt}`);
        }))
      : h('p', { class: 'empty' }, `No caps or flags — all ${sc.gates.length} hard checks passed.`),
    hit.length ? h('p', { class: 'empty', style: 'margin-top:.75rem' }, `${sc.gates.length - hit.length} of ${sc.gates.length} hard checks passed.`) : null,
  );

  const notes: string[] = [];
  notes.push(r.unit === 'R' ? 'Results are in R — multiples of the amount risked at the initial stop.' : 'Most trades have no stop loss, so results are in average-loss units (ALU) instead of R.');
  if (o.combined && o.combined > 1) notes.push(`${o.combined} sessions combined on a $${Math.round(r.initial).toLocaleString('en-US')} reference account; returns compound by % of equity.`);
  const untagged = r.trades.filter((t) => t.trend == null || t.vol == null).length;
  if (untagged) notes.push(`Market regime known for ${r.n - untagged} of ${r.n} trades (see Market regimes).`);
  if (r.synthetic === 'all') notes.push('Synthetic practice data: scored, but never ranked on the leaderboard.');
  else if (r.synthetic === 'some') notes.push('Some trades use synthetic practice data.');
  if (o.filtered) notes.push('Filtered view: the score covers only the trades that match the filters.');

  const side = h('div', { class: 'score-side' },
    h('div', {},
      h('div', { class: 'card-title' }, h('h5', {}, 'Score breakdown'), h('div', { class: 'tools-r' }, howButton('pillars', 'score-pillars', (p) => { pillHow.innerHTML = ''; if (p) pillHow.append(p); }))),
      pillHow,
      pillars),
    h('div', { class: 'score-cols' }, strengths, todo),
    h('div', { class: 'score-cols' }, flags, o.extraBox ?? null),
    h('div', { class: 'score-notes' }, ...notes.map((n) => h('span', {}, n))),
  );
  return h('div', { class: `score-hero g-${sc.tier}` }, left, side);
}
