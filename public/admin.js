/* QuoteUnquote — admin verification queue (consumes /api/admin/pending). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'qu_admin_token';

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
  const fmtMoney = (c) => '$' + (Number(c) / 100).toFixed(2);

  document.addEventListener('DOMContentLoaded', () => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) $('tokenInput').value = saved;
    $('loadBtn').addEventListener('click', load);
    $('refreshBtn').addEventListener('click', load);
    $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    if (saved) load();
  });

  async function load() {
    const token = ($('tokenInput').value || '').trim();
    if (!token) { setStatus('Enter your ADMIN_TOKEN.', true); return; }
    sessionStorage.setItem(TOKEN_KEY, token);
    setStatus('Loading…');
    try {
      const r = await fetch('/api/admin/pending?token=' + encodeURIComponent(token));
      if (r.status === 401) { setStatus('Unauthorized — wrong ADMIN_TOKEN.', true); $('queue').innerHTML = ''; return; }
      if (r.status === 503) { setStatus('Admin API disabled — set ADMIN_TOKEN in the server environment.', true); $('queue').innerHTML = ''; return; }
      if (!r.ok) { setStatus('Error ' + r.status + '.', true); return; }
      render(await r.json());
    } catch (e) {
      setStatus('Network error reaching the admin API.', true);
    }
  }

  function setStatus(msg, isErr) {
    const s = $('status');
    s.textContent = msg;
    s.style.color = isErr ? '#ffb4b4' : 'var(--text-faint)';
  }

  function render(data) {
    const q = $('queue');
    q.innerHTML = '';
    const draftNote = data.printifyDraftCount != null ? ' · ' + data.printifyDraftCount + ' draft(s) on Printify' : '';
    setStatus(data.count + ' order(s) awaiting review' + draftNote + '. Reviewed at ' + new Date().toLocaleTimeString() + '.');

    if (!data.count) {
      q.appendChild(el('div', { class: 'panel' }, el('p', { class: 'cart-empty', text: 'Queue is clear — nothing to approve.' })));
      return;
    }

    data.orders.forEach((o) => {
      const quarantined = o.status === 'quarantined';
      const card = el('div', { class: 'panel admin-order' });

      const head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px' },
        el('div', {},
          el('span', { class: 'chip' + (quarantined ? ' badge-quarantine' : ' solid'), text: o.status.replace(/_/g, ' ').toUpperCase() }),
          el('span', { class: 'mono', style: 'margin-left:10px;color:var(--text-faint);font-size:12px', text: o.orderId })
        ),
        el('span', { class: 'mono', style: 'color:var(--text-faint);font-size:12px', text: fmtMoney(o.amount) + ' · ' + new Date(o.createdAt).toLocaleString() })
      );
      card.appendChild(head);

      if (quarantined && o.quarantineReason) {
        card.appendChild(el('p', { style: 'color:#ffb4b4;font-size:13px;margin:6px 0', text: '⚠ Quarantined: ' + o.quarantineReason }));
      }
      if (o.printifyOrderIds && o.printifyOrderIds.length) {
        card.appendChild(el('p', { class: 'mono', style: 'font-size:11px;color:var(--text-faint);margin:4px 0', text: 'Printify: ' + o.printifyOrderIds.join(', ') }));
      }

      const adminToken = encodeURIComponent(sessionStorage.getItem(TOKEN_KEY) || '');

      (o.lines || []).forEach((ln) => {
        const mockFig = el('figure', {},
          el('img', { class: 'pv-mockup', alt: 'Printify mockup', loading: 'lazy' }),
          el('figcaption', { text: 'Printify mockup' })
        );
        const mockImg = mockFig.querySelector('img');
        mockImg.style.display = 'none';
        if (o.printifyOrderIds && o.printifyOrderIds.length) {
          fetch('/api/admin/mockup/' + encodeURIComponent(o.orderId) + '?token=' + adminToken)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d && d.url) { mockImg.src = d.url; mockImg.style.display = ''; } })
            .catch(() => {});
        }

        const imgs = el('div', { class: 'admin-imgs' },
          mockFig,
          el('figure', {}, el('img', { class: 'pv-print', src: ln.printUrl, alt: 'print', loading: 'lazy' }), el('figcaption', { text: 'Print file' })),
          el('figure', {}, el('img', { class: 'pv-avatar', src: ln.avatarUrl, alt: 'avatar', loading: 'lazy' }), el('figcaption', { text: 'Avatar' }))
        );
        // hide broken images (e.g. pruned by the retention sweeper)
        imgs.querySelectorAll('img').forEach((im) => { im.addEventListener('error', () => { im.style.display = 'none'; }); });

        const details = el('div', { class: 'admin-details' },
          el('div', { style: 'font-weight:700;font-size:15px', text: ln.handle }),
          el('div', { style: 'font-size:14px;color:var(--text-dim);margin:4px 0 10px', text: ln.comment }),
          el('div', { class: 'mono', style: 'font-size:12px;color:var(--text-faint)', text: 'Size ' + ln.size + ' × ' + ln.qty })
        );
        card.appendChild(el('div', { class: 'admin-line' }, imgs, details));
      });

      const foot = el('div', { style: 'margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        el('a', { class: 'btn btn-ghost', href: 'https://printify.com/app/orders', target: '_blank', rel: 'noopener', style: 'padding:10px 14px' }, 'Open Printify →'),
        el('span', { class: 'pay-note', style: 'margin:0', text: 'Verify, then Submit to Production in Printify.' })
      );
      card.appendChild(foot);
      q.appendChild(card);
    });
  }
})();
