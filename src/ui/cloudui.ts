import { cloudState, configFromEnv, friendlyError, onCloudChange, resetPassword, setCloudConfig, signIn, signOut, signUp, syncNow, cloudConfig } from '../data/cloud';
import { h, modal, field, toast } from './dom';

/** Self-updating cloud status button for top bars. */
export function cloudButton(): HTMLButtonElement {
  const b = h('button', { class: 'ghost cloud-btn' });
  const render = () => {
    const st = cloudState();
    b.className = `ghost cloud-btn ${st.status}`;
    if (st.status === 'off') {
      b.textContent = '☁ Cloud sync';
      b.title = 'Set up login & sync across devices';
    } else if (st.status === 'signed-out') {
      b.textContent = '☁ Sign in';
      b.title = 'Sign in to sync sessions across devices';
    } else {
      const who = st.user?.email?.split('@')[0] ?? 'you';
      const icon = st.status === 'syncing' ? '⟳' : st.status === 'error' ? '⚠' : '☁';
      b.textContent = `${icon} ${who}`;
      b.title = st.status === 'error' ? `Sync error: ${st.lastError}` : st.lastSync ? `Synced ${new Date(st.lastSync).toLocaleTimeString('en-GB')}` : 'Signed in';
    }
  };
  b.onclick = () => {
    const st = cloudState();
    if (st.status === 'off') setupModal();
    else if (st.status === 'signed-out') authModal();
    else accountModal();
  };
  const off = onCloudChange(() => {
    if (!b.isConnected && b.dataset.mounted) return off();
    render();
  });
  requestAnimationFrame(() => (b.dataset.mounted = '1'));
  render();
  return b;
}

export function setupModal() {
  const url = h('input', { placeholder: 'https://xxxxxxxx.supabase.co', value: cloudConfig()?.url ?? '' });
  const key = h('input', { placeholder: 'eyJhbGciOi… (anon / publishable key)', value: cloudConfig()?.key ?? '' });
  const save = h('button', { class: 'primary' }, 'Connect');
  const close = modal('Set up cloud sync', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Accounts and sync run on your own free Supabase project, so your data stays yours. One-time setup, about 3 minutes:'),
    h('ol', { class: 'steps' },
      h('li', { html: 'Create a free project at <a href="https://supabase.com/dashboard" target="_blank" rel="noopener">supabase.com</a>.' }),
      h('li', { html: 'Open <b>SQL Editor</b>, paste the contents of <code>supabase/schema.sql</code> from this repo and press <b>Run</b>.' }),
      h('li', { html: 'Open <b>Project Settings → API</b> and copy the <b>Project URL</b> and the <b>anon public</b> key below.' }),
    ),
    field('Project URL', url), field('Anon public key', key),
    h('p', { class: 'muted small' }, 'Tip: to give every visitor of your deployed site accounts without this step, set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY when building (see README).'),
    save,
  ), { wide: true });
  save.onclick = () => {
    if (!/^https?:\/\/.+/.test(url.value) || key.value.length < 20) return toast('Paste the Project URL and the anon key', 'err');
    setCloudConfig({ url: url.value, key: key.value });
    close();
    location.reload();
  };
}

export function authModal(mode: 'in' | 'up' = 'in') {
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
  const pass = h('input', { type: 'password', placeholder: 'At least 6 characters', autocomplete: mode === 'in' ? 'current-password' : 'new-password' });
  const go = h('button', { class: 'primary' }, mode === 'in' ? 'Sign in' : 'Create account');
  const swap = h('button', { class: 'ghost sm' }, mode === 'in' ? 'No account yet? Create one' : 'Have an account? Sign in');
  const forgot = h('button', { class: 'ghost sm' }, 'Forgot password?');
  const msg = h('div', { class: 'muted small' });
  const close = modal(mode === 'in' ? 'Sign in' : 'Create your account', h('form', { class: 'stack' },
    field('Email', email), field('Password', pass), msg, go,
    h('div', { class: 'row-btns' }, swap, mode === 'in' ? forgot : null),
    !configFromEnv() ? h('button', { type: 'button', class: 'ghost sm', onclick: () => { close(); setupModal(); } }, 'Cloud settings…') : null,
  ));
  swap.type = 'button';
  forgot.type = 'button';
  swap.onclick = () => {
    close();
    authModal(mode === 'in' ? 'up' : 'in');
  };
  forgot.onclick = async () => {
    if (!email.value) return toast('Enter your email first', 'err');
    try {
      await resetPassword(email.value);
      msg.textContent = 'Password reset email sent.';
    } catch (e) {
      msg.textContent = friendlyError(e);
    }
  };
  (go.closest('form') as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true;
    msg.textContent = '';
    try {
      if (mode === 'in') {
        await signIn(email.value, pass.value);
        toast('Signed in — syncing your sessions', 'ok');
        close();
      } else {
        const r = await signUp(email.value, pass.value);
        if (r === 'signed-in') {
          toast('Account created', 'ok');
          close();
        } else msg.textContent = 'Check your inbox and confirm your email, then sign in here.';
      }
    } catch (err) {
      msg.textContent = friendlyError(err);
    } finally {
      go.disabled = false;
    }
  };
}

function accountModal() {
  const status = h('div', { class: 'stack' });
  const renderStatus = () => {
    const s = cloudState();
    status.innerHTML = '';
    status.append(
      h('div', { class: 'kv' }, h('span', {}, 'Account'), h('b', {}, s.user?.email ?? '—')),
      h('div', { class: 'kv' }, h('span', {}, 'Status'), h('b', { class: s.status === 'error' ? 'dn' : '' }, s.status === 'error' ? `Error: ${s.lastError}` : s.status)),
      h('div', { class: 'kv' }, h('span', {}, 'Last sync'), h('b', {}, s.lastSync ? new Date(s.lastSync).toLocaleString('en-GB') : 'never')),
    );
  };
  renderStatus();
  const off = onCloudChange(renderStatus);
  const sync = h('button', { class: 'primary', onclick: async () => {
    const r = await syncNow();
    if (r) toast(`Synced: ${r.pushed.length} up, ${r.pulled.length} down`, 'ok');
  } }, '⟳ Sync now');
  const out = h('button', { class: 'ghost', onclick: async () => { await signOut(); close(); toast('Signed out. Local data stays on this device.'); } }, 'Sign out');
  const disconnect = !configFromEnv()
    ? h('button', { class: 'ghost danger', onclick: async () => {
        if (!confirm('Disconnect this browser from the cloud project? Local data is kept.')) return;
        await signOut();
        setCloudConfig(null);
        location.reload();
      } }, 'Disconnect project')
    : null;
  const close = modal('Cloud sync', h('div', { class: 'stack' },
    status,
    h('p', { class: 'muted small' }, 'Sessions, trades, drawings, journal notes and screenshots sync automatically. Market data is uploaded per symbol from the Data tab and downloaded automatically when a session needs it.'),
    h('div', { class: 'row-btns' }, sync, out, disconnect),
  ), { onClose: () => off() });
}
