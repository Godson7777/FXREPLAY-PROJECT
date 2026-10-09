import type { Session } from '../engine/replay';
import { listSessions } from '../data/sessions';
import { deleteStrategy, getAuthor, listStrategies, saveStrategy, setAuthor, type Strategy } from '../data/strategies';
import { buildBoard, RANK_MIN_DAYS, RANK_MIN_TRADES, RANK_RULES, type BoardEntry } from '../analytics/service';
import { h, field, modal, toast, uid, money } from './dom';
import { pageHead, pageShell, scoreBadge } from './layout';
import { pctTxt } from './an-widgets';

const fmtDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

// ---- create / edit ----------------------------------------------------------------------

/** Create or edit a strategy. `preselect` ticks sessions for a new strategy. */
export function strategyModal(existing: Strategy | null, sessions: Session[], done: (st: Strategy) => void, preselect: string[] = []) {
  const name = h('input', { value: existing?.name ?? '', maxlength: 80, placeholder: 'e.g. London breakout' });
  const author = h('input', { value: existing?.author ?? getAuthor(), maxlength: 60, placeholder: 'Your name or handle' });
  const tf = h('input', { value: existing?.timeframe ?? '', maxlength: 40, placeholder: 'e.g. M15 entries, H4 bias' });
  const desc = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'Entry, exit and risk rules in a few lines — readers see this on the leaderboard.' }, existing?.description ?? '');
  const chosen = new Set(existing ? existing.sessionIds : preselect);
  const boxes = sessions.map((s) => ({ s, cb: h('input', { type: 'checkbox', checked: chosen.has(s.id) }) }));
  const list = boxes.length
    ? h('div', { class: 'sym-list' }, ...boxes.map(({ s, cb }) =>
        h('label', { class: 'check' }, cb, h('span', {}, ` ${s.name} `, h('small', { class: 'muted' }, `${s.symbols.join(', ')} · ${s.state.broker.trades.length} trades · from ${fmtDay(s.start)}`)))))
    : h('p', { class: 'muted small' }, 'No sessions yet — create one first, then add it here.');
  const publish = h('input', { type: 'checkbox', checked: existing?.published ?? false });
  const save = h('button', { class: 'primary' }, existing ? 'Save strategy' : 'Create strategy');
  const close = modal(existing ? 'Edit strategy' : 'New strategy', h('div', { class: 'stack' },
    h('div', { class: 'row2' }, field('Strategy name', name), field('Author', author, 'Shown on the leaderboard.')),
    field('Timeframe', tf),
    field('Description', desc),
    field('Sessions in this strategy', list, 'Only sessions where you traded the same rules — they are combined into one track record.'),
    h('label', { class: 'check' }, publish, ' Publish to the leaderboard'),
    h('p', { class: 'muted small' }, RANK_RULES),
    save,
  ), { wide: true });
  save.onclick = async () => {
    const nm = name.value.trim(), au = author.value.trim();
    if (!nm) return toast('Give the strategy a name', 'err');
    if (!au) return toast('Add an author name (it is shown on the leaderboard)', 'err');
    const now = Date.now();
    const st: Strategy = {
      id: existing?.id ?? uid(), name: nm, author: au, timeframe: tf.value.trim(), description: desc.value.trim(),
      sessionIds: boxes.filter((b) => b.cb.checked).map((b) => b.s.id), published: publish.checked,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    save.disabled = true;
    try {
      await saveStrategy(st);
      setAuthor(au);
      close();
      toast(existing ? 'Strategy saved' : 'Strategy created', 'ok');
      done(st);
    } catch (e) {
      save.disabled = false;
      toast(String((e as Error).message ?? e), 'err');
    }
  };
}

/** Tick the strategies a session belongs to (or start a new one with it). */
export async function addToStrategyModal(s: Session, sessions: Session[], done: () => void) {
  const strategies = await listStrategies();
  if (!strategies.length) return strategyModal(null, sessions, () => done(), [s.id]);
  const boxes = strategies.map((st) => ({ st, cb: h('input', { type: 'checkbox', checked: st.sessionIds.includes(s.id) }) }));
  const save = h('button', { class: 'primary' }, 'Save');
  const create = h('button', { class: 'ghost' }, 'New strategy…');
  const close = modal(`Add “${s.name}” to a strategy`, h('div', { class: 'stack' },
    h('div', { class: 'sym-list' }, ...boxes.map(({ st, cb }) =>
      h('label', { class: 'check' }, cb, h('span', {}, ` ${st.name} `, h('small', { class: 'muted' }, `by ${st.author || 'Anonymous'} · ${st.sessionIds.length} session${st.sessionIds.length === 1 ? '' : 's'}${st.published ? ' · published' : ''}`))))),
    h('div', { class: 'row-btns' }, save, create),
  ));
  create.onclick = () => {
    close();
    strategyModal(null, sessions, () => done(), [s.id]);
  };
  save.onclick = async () => {
    save.disabled = true;
    try {
      let n = 0;
      for (const { st, cb } of boxes) {
        const has = st.sessionIds.includes(s.id);
        if (cb.checked === has) continue;
        await saveStrategy({ ...st, sessionIds: cb.checked ? [...st.sessionIds, s.id] : st.sessionIds.filter((x) => x !== s.id), updatedAt: Date.now() });
        n++;
      }
      close();
      if (n) toast('Strategies updated', 'ok');
      done();
    } catch (e) {
      save.disabled = false;
      toast(String((e as Error).message ?? e), 'err');
    }
  };
}

// ---- page -------------------------------------------------------------------------------

export function eligibilityBars(e: BoardEntry) {
  const prog = (label: string, v: number, max: number, txt: string) =>
    h('div', { class: 'prog-row' }, h('span', {}, label), h('div', { class: 'prog' }, h('i', { style: `width:${Math.min(100, (v / max) * 100).toFixed(1)}%` })), h('span', {}, txt));
  return h('div', { class: 'stack', style: 'gap:.4rem' },
    prog('Trades', e.elig.trades, RANK_MIN_TRADES, `${e.elig.trades} / ${RANK_MIN_TRADES}`),
    prog('History', e.elig.days, RANK_MIN_DAYS, `${Math.floor(e.elig.days)} / ${RANK_MIN_DAYS} days`));
}

export async function renderStrategies(root: HTMLElement, nav: (hash: string) => void) {
  const [sessions, strategies] = await Promise.all([listSessions(), listStrategies()]);
  const { page, main } = pageShell('strategies');
  root.replaceChildren(page);
  const refresh = () => nav('#/strategies');
  const newBtn = h('button', { class: 'primary', onclick: () => strategyModal(null, sessions, (st) => nav(`#/strategy/${st.id}`)) }, '+ New strategy');
  main.append(pageHead({
    eyebrow: 'Strategies', titleHtml: 'Group sessions into a <em>strategy</em>.', compact: true,
    lead: 'A strategy combines every session where you traded the same rules — any symbols, any periods — into one track record and one Overflow Score. Publish it to compete on the leaderboard.',
    actions: [newBtn, h('button', { class: 'ghost', onclick: () => nav('#/leaderboard') }, 'Leaderboard'), h('button', { class: 'ghost', onclick: () => nav('#/methodology') }, 'How scoring works')],
  }));
  const body = h('div', { class: 'wrap page-body' });
  main.append(body);
  if (!strategies.length) {
    body.append(h('div', { class: 'card empty-state' },
      h('h3', {}, 'No strategies yet'),
      h('p', {}, sessions.length ? 'Create your first strategy and tick the sessions that belong to it. You can also use “Add to strategy” on any session card.' : 'Create a backtesting session first, trade it, then group sessions into a strategy here.'),
      h('div', { class: 'actions' }, sessions.length ? h('button', { class: 'primary', onclick: () => newBtn.click() }, 'Create a strategy') : h('button', { class: 'primary', onclick: () => nav('#/') }, 'Go to sessions'))));
    return;
  }
  const grid = h('div', { class: 'cards' });
  body.append(grid);
  const slots = new Map<string, { badge: HTMLElement; stats: HTMLElement; extra: HTMLElement }>();
  for (const st of strategies) {
    const badge = h('span', {}, scoreBadge(null, '', 'loading'));
    const stats = h('div', { class: 'scard-stats' }, h('div', {}, h('span', {}, 'Sessions'), h('b', {}, String(st.sessionIds.length))));
    const extra = h('div', {});
    slots.set(st.id, { badge, stats, extra });
    grid.append(h('article', { class: 'scard' },
      h('div', { class: 'scard-head' }, h('div', {}, h('h3', {}, st.name), h('div', { class: 'by' }, `by ${st.author || 'Anonymous'}${st.timeframe ? ` · ${st.timeframe}` : ''}`)), badge),
      h('div', { class: 'badges' }, h('span', { class: `badge${st.published ? ' accent' : ''}` }, st.published ? 'Published' : 'Private')),
      stats, extra,
      h('div', { class: 'scard-actions' },
        h('button', { class: 'primary', onclick: () => nav(`#/strategy/${st.id}`) }, 'Open'),
        h('button', { class: 'ghost', onclick: () => strategyModal(st, sessions, refresh) }, 'Edit'),
        h('button', { class: 'ghost danger', title: 'Delete strategy (sessions are kept)', onclick: async () => {
          if (!confirm(`Delete strategy “${st.name}”? Its sessions and trades are kept.`)) return;
          await deleteStrategy(st.id);
          toast('Strategy deleted', 'ok');
          refresh();
        } }, 'Delete'),
      )));
  }
  try {
    const board = await buildBoard(sessions, strategies);
    for (const e of board) {
      const slot = slots.get(e.strategy.id);
      if (!slot || !slot.badge.isConnected) continue;
      const r = e.report;
      slot.badge.replaceChildren(r ? scoreBadge(r.score.score, r.score.grade, r.score.tier, r.score.label) : scoreBadge(null, '—', 'insufficient'));
      slot.stats.replaceChildren(
        h('div', {}, h('span', {}, 'Sessions'), h('b', {}, String(e.sessions.length))),
        h('div', {}, h('span', {}, 'Trades'), h('b', {}, String(r?.n ?? 0))),
        h('div', {}, h('span', {}, 'Return'), h('b', { class: r ? (r.returnPct >= 0 ? 'up' : 'dn') : '' }, r ? pctTxt(r.returnPct, 1, true) : '—')),
        h('div', {}, h('span', {}, 'Max DD'), h('b', {}, r ? pctTxt(-r.risk.maxDD, 1) : '—')),
        h('div', {}, h('span', {}, 'Rank'), h('b', {}, e.rank != null ? `#${e.rank}` : '—')),
      );
      slot.extra.replaceChildren(e.elig.ranked ? h('p', { class: 'muted small' }, `Ranked #${e.rank} on the leaderboard · ${money(r?.netPnl ?? 0, true)} on the reference account`) : h('div', { class: 'stack', style: 'gap:.5rem' }, eligibilityBars(e), h('p', { class: 'muted small' }, e.elig.reasons[0] ?? '')));
    }
  } catch (err) {
    console.error(err);
    toast('Could not score strategies: ' + String((err as Error).message ?? err), 'err');
  }
}
