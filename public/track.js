/* QuoteUnquote — order tracking portal (standalone, CSP-safe). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    attrs = attrs || {};
    for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) { if (kid == null) continue; n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); }
    return n;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = $('trackForm');
    form.addEventListener('submit', (e) => { e.preventDefault(); track($('trackToken').value.trim()); });

    const params = new URLSearchParams(location.search);
    const pre = params.get('order');
    if (pre) { $('trackToken').value = pre; track(pre); }
  });

  async function track(token) {
    const out = $('trackResult');
    if (!token) return;
    out.innerHTML = '';
    out.appendChild(el('p', { class: 'mono', text: 'Looking up ' + token + '…' }));
    try {
      const r = await fetch('/api/orders/track/' + encodeURIComponent(token));
      const data = await r.json();
      if (!r.ok) { out.innerHTML = ''; out.appendChild(el('div', { class: 'panel' }, el('p', { text: data.error || 'Order not found.' }))); return; }
      render(data);
    } catch (e) {
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'panel' }, el('p', { text: 'Could not reach the tracking service.' })));
    }
  }

  function render(data) {
    const out = $('trackResult');
    out.innerHTML = '';

    const statusChip = el('span', { class: 'chip solid', text: (data.status || 'pending').replace(/_/g, ' ').toUpperCase() });
    const head = el('div', { class: 'section-head', style: 'margin-bottom:16px' },
      el('div', {}, el('div', { class: 'eyebrow', text: '// Order ' + data.token }), el('h2', { style: 'font-size:28px', text: 'Status' })),
      statusChip
    );

    // Milestones
    const steps = el('div', { class: 'panel', style: 'margin-bottom:18px' });
    (data.milestones || []).forEach((m) => {
      const mark = el('div', {
        style: 'flex:0 0 auto;width:24px;height:24px;border:2px solid var(--ink);display:grid;place-items:center;'
          + (m.done ? 'background:var(--ink);color:#fff' : 'background:#fff;color:var(--ink)'),
        text: m.done ? '✓' : '•',
      });
      steps.appendChild(el('div', { style: 'display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:2px solid var(--line-soft)' },
        mark,
        el('div', {}, el('div', { style: 'font-weight:700;font-size:14px', text: m.label }),
          m.at ? el('div', { class: 'mono', style: 'font-size:11px;color:var(--ig-grey)', text: new Date(m.at).toLocaleString() }) : null)
      ));
    });

    // Tracking link
    if (data.tracking && data.tracking.number) {
      const t = data.tracking;
      steps.appendChild(el('div', { style: 'padding-top:12px' },
        el('div', { class: 'mono', style: 'font-size:12px;color:var(--ig-grey)', text: (t.carrier || 'Carrier') + ' · ' + t.number }),
        t.url ? el('a', { class: 'btn btn-ghost', href: t.url, target: '_blank', rel: 'noopener', style: 'margin-top:8px' }, 'Track Shipment') : null
      ));
    }

    // Items
    const items = el('div', { class: 'panel' });
    items.appendChild(el('h3', { style: 'margin:0 0 10px;text-transform:uppercase;font-size:16px', text: 'Items' }));
    (data.items || []).forEach((it) => {
      const row = el('div', { style: 'padding:8px 0;border-bottom:2px solid var(--line-soft)' },
        el('div', { style: 'font-weight:700', text: it.title + ' · ' + it.size + ' × ' + it.qty }));
      if (it.custom) {
        row.appendChild(el('div', { class: 'li-custom' },
          el('span', { class: 'li-handle', text: it.custom.handle + '  ' }),
          el('span', { text: it.custom.comment })));
      }
      items.appendChild(row);
    });

    out.appendChild(head);
    out.appendChild(steps);
    out.appendChild(items);
  }
})();
