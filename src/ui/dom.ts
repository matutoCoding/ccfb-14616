// 简易 DOM 构造工具
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export function numField(label: string, value: number, step: number, onChange: (v: number) => void, unit = '') {
  const wrap = h('div', { class: 'field' });
  wrap.append(h('label', {}, `${label}${unit ? ` (${unit})` : ''}`));
  const inp = h('input', { type: 'number', step: String(step), value: String(value) }) as HTMLInputElement;
  inp.addEventListener('change', () => onChange(Number(inp.value)));
  wrap.append(inp);
  return wrap;
}

export function toast(msg: string, ms = 2600) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export function download(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
