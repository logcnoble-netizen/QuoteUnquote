/* =============================================================================
   QuoteUnquote — storefront client (100% Custom POD, single product)
   Vanilla ES6, no build step, no inline handlers (CSP-safe).
   Live mockup + char caps + avatar upload/crop (cropper.js) + cart + Stripe.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const money = (cents) => '$' + (Number(cents) / 100).toFixed(2);
  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : 'u' + Math.random().toString(36).slice(2) + Date.now());

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    attrs = attrs || {};
    for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return n;
  }

  // ---- state ----------------------------------------------------------------
  const CART_KEY = 'qu_cart_v1';
  const AVATAR_EXPORT = 448; // px, square -> circular PNG
  let CONFIG = { handleMax: 15, commentMax: 150, timeMax: 8, timeDefault: '2h', sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'], colors: ['Black', 'White'], shipping: { FLAT_CENTS: 0, FREE_THRESHOLD_CENTS: 0 }, paymentsEnabled: false, currency: 'usd', country: 'US', brand: 'QuoteUnquote', stripePublishableKey: '' };
  let PRODUCT = { id: 'custom-comment', price: 3499 };
  let cart = loadCart();

  // builder
  let selectedSize = null;
  let selectedColor = 'Black';
  let avatarDataUrl = null;

  // cropper
  let cropper = null;
  let cropObjectUrl = null;

  // stripe
  let stripe = null;
  let elements = null;
  let cardEl = null;
  let paymentRequest = null;
  let prButton = null;
  let clientSecret = null;
  let orderToken = null;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const y = $('year'); if (y) y.textContent = String(new Date().getFullYear());
    await loadConfig();
    buildSizeSelector();
    buildColorSelector();
    wireBuilder();
    wireAvatar();
    wireCart();
    wireModals();
    initStripe();
    renderCart();
    fitMockHandle();
    await loadProduct();
  }

  // ===========================================================================
  // Config + product
  // ===========================================================================
  async function loadConfig() {
    try {
      const r = await fetch('/api/config');
      if (r.ok) CONFIG = Object.assign(CONFIG, await r.json());
    } catch (e) { /* keep defaults */ }
    const hi = $('handleInput'); if (hi) hi.maxLength = CONFIG.handleMax;
    const ci = $('commentInput'); if (ci) ci.maxLength = CONFIG.commentMax;
    const ti = $('timeInput'); if (ti) ti.maxLength = CONFIG.timeMax || 8;
    updateCounter('handleCount', 0, CONFIG.handleMax);
    updateCounter('commentCount', 0, CONFIG.commentMax);
  }

  async function loadProduct() {
    try {
      const r = await fetch('/api/product');
      const data = await r.json();
      if (data.product) {
        PRODUCT = data.product;
        $('addCustomBtn').textContent = 'Add Custom Tee — ' + money(PRODUCT.price);
      }
    } catch (e) { /* keep default price */ }
  }

  // ===========================================================================
  // Builder
  // ===========================================================================
  function buildSizeSelector() {
    const wrap = $('sizeSelector');
    if (!wrap) return;
    wrap.innerHTML = '';
    CONFIG.sizes.forEach((s) => {
      wrap.appendChild(el('button', {
        type: 'button', class: 'size-btn', 'data-size': s, 'aria-pressed': 'false',
        onclick: () => selectSize(s),
      }, s));
    });
  }

  function selectSize(s) {
    selectedSize = s;
    document.querySelectorAll('#sizeSelector .size-btn').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-size') === s));
    });
    validateBuilder();
  }

  function buildColorSelector() {
    const wrap = $('colorSelector');
    if (!wrap) return;
    wrap.innerHTML = '';
    (CONFIG.colors || ['Black']).forEach((c) => {
      wrap.appendChild(el('button', {
        type: 'button', class: 'size-btn', 'data-color': c, 'aria-pressed': String(c === selectedColor),
        onclick: () => selectColor(c),
      }, c));
    });
    applyMockColor();
  }

  function selectColor(c) {
    selectedColor = c;
    document.querySelectorAll('#colorSelector .size-btn').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-color') === c));
    });
    applyMockColor();
  }

  /** Swap the tee mockup between the dark (Black) and light (White) looks. */
  function applyMockColor() {
    const stage = document.querySelector('.stage');
    if (!stage) return;
    stage.classList.toggle('tee-white', selectedColor === 'White');
    stage.classList.toggle('tee-dark', selectedColor !== 'White');
  }

  function updateCounter(id, len, max) {
    const c = $(id);
    if (!c) return;
    c.textContent = len + '/' + max;
    c.classList.toggle('warn', len >= max * 0.9);
  }

  function wireBuilder() {
    const handle = $('handleInput');
    const comment = $('commentInput');
    const waiver = $('waiverCheck');

    if (handle) handle.addEventListener('input', () => {
      const v = handle.value.slice(0, CONFIG.handleMax);
      if (v !== handle.value) handle.value = v;
      updateCounter('handleCount', v.length, CONFIG.handleMax);
      const clean = v.replace(/^@+/, '');
      $('mockHandle').textContent = clean ? '@' + clean : '@yourhandle';
      fitMockHandle();
      updateMockAvatar();
      validateBuilder();
    });

    if (comment) comment.addEventListener('input', () => {
      const v = comment.value.slice(0, CONFIG.commentMax);
      if (v !== comment.value) comment.value = v;
      updateCounter('commentCount', v.length, CONFIG.commentMax);
      $('mockText').textContent = v.trim() ? v : 'your comment goes here';
      validateBuilder();
    });

    const likesEl = $('likesInput');
    if (likesEl) likesEl.addEventListener('input', updateMockLikes);

    const timeEl = $('timeInput');
    if (timeEl) timeEl.addEventListener('input', () => {
      $('mockTime').textContent = timeValue();
      fitMockHandle(); // a longer time string changes what fits on the handle line
    });

    if (waiver) waiver.addEventListener('change', validateBuilder);
    $('addCustomBtn').addEventListener('click', addCustomToCart);
  }

  function likesValue() {
    return Math.max(0, Math.min(100000000, Math.floor(Number(($('likesInput') || {}).value) || 0)));
  }

  function timeValue() {
    const raw = (($('timeInput') || {}).value || '').replace(/\s+/g, ' ').trim();
    return raw.slice(0, CONFIG.timeMax || 8) || (CONFIG.timeDefault || '2h');
  }

  function formatLikeCount(n) {
    n = Math.max(0, Math.floor(n));
    if (n < 10000) return n.toLocaleString('en-US');
    if (n < 1000000) { const k = Math.round(n / 100) / 10; return (Number.isInteger(k) ? k : k.toFixed(1)) + 'k'; }
    const m = Math.round(n / 100000) / 10;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + 'M';
  }

  function updateMockLikes() {
    const n = likesValue();
    const el = $('mockLikes');
    if (!el) return;
    if (n > 0) { el.textContent = formatLikeCount(n); el.hidden = false; }
    else el.hidden = true;
  }

  function builderValues() {
    const raw = ($('handleInput').value || '').replace(/^@+/, '').trim();
    return {
      handle: raw ? '@' + raw : '',
      comment: ($('commentInput').value || '').trim(),
      likes: likesValue(),
      time: timeValue(),
      waiver: $('waiverCheck').checked,
    };
  }

  function validateBuilder() {
    const v = builderValues();
    const ok = !!(avatarDataUrl && v.handle && v.comment && selectedSize && v.waiver);
    $('addCustomBtn').disabled = !ok;
    const hint = $('builderHint');
    if (!avatarDataUrl) hint.textContent = 'Upload & crop a profile photo to continue.';
    else if (!v.handle || !v.comment) hint.textContent = 'Enter a handle & comment to continue.';
    else if (!selectedSize) hint.textContent = 'Pick a size to continue.';
    else if (!v.waiver) hint.textContent = 'Please accept the custom-text waiver to continue.';
    else hint.textContent = 'Looks good — add it to your cart.';
    return ok;
  }

  // Shrink the handle line's font until "@handle 2h" fits on one line
  // (mirrors the print engine, which scales the handle instead of wrapping).
  function fitMockHandle() {
    const line = document.querySelector('.ig-line');
    if (!line) return;
    line.style.fontSize = ''; // reset to the CSS cqw base before measuring
    let fs = parseFloat(getComputedStyle(line).fontSize);
    let guard = 0;
    while (line.scrollWidth > line.clientWidth + 0.5 && fs > 4 && guard++ < 40) {
      fs *= 0.94;
      line.style.fontSize = fs.toFixed(2) + 'px';
    }
  }
  window.addEventListener('resize', fitMockHandle);

  function updateMockAvatar() {
    const a = $('mockAvatar');
    if (avatarDataUrl) {
      a.style.backgroundImage = 'url(' + avatarDataUrl + ')';
      a.style.backgroundSize = 'cover';
      a.style.backgroundPosition = 'center';
      a.textContent = '';
    } else {
      a.style.backgroundImage = '';
      const clean = ($('handleInput').value || '').replace(/^@+/, '');
      a.textContent = (clean[0] || 'U').toUpperCase();
    }
  }

  function addCustomToCart() {
    if (!validateBuilder()) return;
    const v = builderValues();
    cart.push({
      uid: uid(), id: PRODUCT.id, title: 'Custom Comment Tee', size: selectedSize, color: selectedColor, qty: 1,
      unitPrice: PRODUCT.price, custom: { handle: v.handle, comment: v.comment, likes: v.likes, time: v.time }, avatarDataUrl,
    });
    if (!saveCart()) { toast('Cart is full (browser storage limit). Remove an item or check out.', true); cart.pop(); return; }
    resetPayment();
    renderCart();
    openCart();
    toast('Added your custom tee to the cart.');
    $('waiverCheck').checked = false;
    validateBuilder();
  }

  // ===========================================================================
  // Avatar upload + circular crop (cropper.js)
  // ===========================================================================
  function wireAvatar() {
    const input = $('avatarInput');
    $('avatarUploadBtn').addEventListener('click', () => input.click());
    input.addEventListener('change', onAvatarFile);
    $('avatarClearBtn').addEventListener('click', clearAvatar);
    $('cropCancel').addEventListener('click', closeCrop);
    $('cropApply').addEventListener('click', applyCrop);
    $('cropModal').addEventListener('click', (e) => { if (e.target === $('cropModal')) closeCrop(); });
    $('cropZoomIn').addEventListener('click', () => cropper && cropper.zoom(0.1));
    $('cropZoomOut').addEventListener('click', () => cropper && cropper.zoom(-0.1));
    $('cropRotate').addEventListener('click', () => cropper && cropper.rotate(90));
  }

  function onAvatarFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Please choose a PNG, JPEG, or WebP image.', true); return; }
    if (file.size > 10 * 1024 * 1024) { toast('That image is too large (max 10MB).', true); return; }
    if (typeof Cropper === 'undefined') { toast('Cropper failed to load — please refresh.', true); return; }

    if (cropObjectUrl) URL.revokeObjectURL(cropObjectUrl);
    cropObjectUrl = URL.createObjectURL(file);
    const img = $('cropImage');
    img.src = cropObjectUrl;
    $('cropModal').classList.add('open');

    if (cropper) { cropper.destroy(); cropper = null; }
    // init once the image is decoded so Cropper measures correctly
    img.onload = () => {
      if (cropper) cropper.destroy();
      cropper = new Cropper(img, {
        aspectRatio: 1,
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 1,
        background: false,
        cropBoxResizable: false,
        cropBoxMovable: false,
        toggleDragModeOnDblclick: false,
        guides: false,
        center: true,
      });
    };
  }

  function applyCrop() {
    if (!cropper) return;
    const square = cropper.getCroppedCanvas({
      width: AVATAR_EXPORT, height: AVATAR_EXPORT,
      imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
    });
    if (!square) { toast('Could not crop that image — try another.', true); return; }

    // Mask the square crop into a circle (transparent corners) -> PNG data URL.
    const c = document.createElement('canvas');
    c.width = AVATAR_EXPORT; c.height = AVATAR_EXPORT;
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_EXPORT / 2, AVATAR_EXPORT / 2, AVATAR_EXPORT / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(square, 0, 0, AVATAR_EXPORT, AVATAR_EXPORT);
    ctx.restore();

    avatarDataUrl = c.toDataURL('image/png');
    updateMockAvatar();
    paintAvatarPreview();
    closeCrop();
    validateBuilder();
  }

  function paintAvatarPreview() {
    const p = $('avatarPreview');
    const letter = $('avatarPreviewLetter');
    if (avatarDataUrl) {
      p.style.backgroundImage = 'url(' + avatarDataUrl + ')';
      p.style.backgroundSize = 'cover';
      p.style.backgroundPosition = 'center';
      if (letter) letter.style.display = 'none';
      $('avatarClearBtn').hidden = false;
    } else {
      p.style.backgroundImage = '';
      if (letter) letter.style.display = '';
      $('avatarClearBtn').hidden = true;
    }
  }

  function clearAvatar() {
    avatarDataUrl = null;
    updateMockAvatar();
    paintAvatarPreview();
    validateBuilder();
  }

  function closeCrop() {
    $('cropModal').classList.remove('open');
    if (cropper) { cropper.destroy(); cropper = null; }
    if (cropObjectUrl) { URL.revokeObjectURL(cropObjectUrl); cropObjectUrl = null; }
  }

  // ===========================================================================
  // Cart drawer
  // ===========================================================================
  function loadCart() {
    try { const v = JSON.parse(localStorage.getItem(CART_KEY)); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); return true; }
    catch (e) { return false; }
  }

  function cartCount() { return cart.reduce((n, it) => n + it.qty, 0); }
  function cartSubtotal() { return cart.reduce((n, it) => n + it.unitPrice * it.qty, 0); }
  function cartShipping(sub) { return sub >= CONFIG.shipping.FREE_THRESHOLD_CENTS ? 0 : (sub > 0 ? CONFIG.shipping.FLAT_CENTS : 0); }

  function wireCart() {
    $('cartOpen').addEventListener('click', openCart);
    $('cartClose').addEventListener('click', closeCart);
    $('drawerBackdrop').addEventListener('click', closeCart);
    $('checkoutBtn').addEventListener('click', startCheckout);
    const pay = $('payNowBtn'); if (pay) pay.addEventListener('click', payWithCard);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCart(); closeModal('sizeModal'); closeCrop(); } });
  }

  function openCart() {
    $('cartDrawer').classList.add('open');
    $('cartDrawer').setAttribute('aria-hidden', 'false');
    $('drawerBackdrop').classList.add('open');
    document.body.classList.add('no-scroll'); // lock the page behind the drawer
  }
  function closeCart() {
    $('cartDrawer').classList.remove('open');
    $('cartDrawer').setAttribute('aria-hidden', 'true');
    $('drawerBackdrop').classList.remove('open');
    document.body.classList.remove('no-scroll');
  }

  function renderCart() {
    $('cartCount').textContent = String(cartCount());
    const body = $('cartItems');
    body.innerHTML = '';

    if (!cart.length) {
      body.appendChild(el('p', { class: 'cart-empty', text: 'Your cart is empty.' }));
      $('cartTotals').hidden = true;
      $('checkoutBtn').disabled = true;
      return;
    }

    cart.forEach((it) => {
      const thumb = el('div', { class: 'li-thumb' });
      if (it.avatarDataUrl) {
        thumb.style.backgroundImage = 'url(' + it.avatarDataUrl + ')';
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';
      } else {
        thumb.appendChild(el('span', { class: 'mono', style: 'font-size:10px;color:var(--text-faint)', text: 'TEE' }));
      }

      const info = el('div', {},
        el('h4', { text: it.title }),
        el('div', { class: 'mono', style: 'font-size:12px;color:var(--text-faint)', text: 'Size ' + it.size + ' · ' + (it.color || 'Black') + ' · Print on demand' })
      );
      if (it.custom) {
        info.appendChild(el('div', { class: 'li-custom' },
          el('span', { class: 'li-handle', text: it.custom.handle + '  ' }),
          el('span', { text: it.custom.comment })
        ));
      }
      info.appendChild(el('div', { class: 'li-controls' },
        el('button', { class: 'qty-btn', 'aria-label': 'Decrease quantity', onclick: () => changeQty(it.uid, -1) }, '−'),
        el('span', { class: 'mono', text: String(it.qty) }),
        el('button', { class: 'qty-btn', 'aria-label': 'Increase quantity', onclick: () => changeQty(it.uid, 1) }, '+'),
        el('button', { class: 'li-remove', onclick: () => removeItem(it.uid) }, 'Remove')
      ));

      body.appendChild(el('div', { class: 'line-item' }, thumb, info, el('div', { class: 'li-price', text: money(it.unitPrice * it.qty) })));
    });

    const sub = cartSubtotal();
    const ship = cartShipping(sub);
    $('cartSubtotal').textContent = money(sub);
    $('cartShipping').textContent = ship === 0 ? 'FREE' : money(ship);
    $('cartTotal').textContent = money(sub + ship);
    $('cartTotals').hidden = false;
    $('checkoutBtn').disabled = false;
  }

  function changeQty(id, delta) {
    const it = cart.find((x) => x.uid === id);
    if (!it) return;
    it.qty = Math.max(1, Math.min(10, it.qty + delta));
    saveCart(); resetPayment(); renderCart();
  }
  function removeItem(id) {
    cart = cart.filter((x) => x.uid !== id);
    saveCart(); resetPayment(); renderCart();
  }

  // ===========================================================================
  // Stripe checkout (Payment Request Button + Card fallback)
  // ===========================================================================
  function initStripe() {
    if (!CONFIG.paymentsEnabled || !CONFIG.stripePublishableKey || typeof Stripe === 'undefined') return;
    try { stripe = Stripe(CONFIG.stripePublishableKey); elements = stripe.elements(); }
    catch (e) { stripe = null; }
  }

  function resetPayment() {
    clientSecret = null; orderToken = null;
    $('paymentSection').hidden = true;
    $('checkoutBtn').hidden = false;
    if (prButton) { try { prButton.unmount(); } catch (e) {} prButton = null; }
    paymentRequest = null;
  }

  async function startCheckout() {
    if (!cart.length) return;
    if (!CONFIG.paymentsEnabled || !stripe) {
      toast('Payments aren’t configured yet. Add your Stripe keys to .env.', true);
      return;
    }
    const btn = $('checkoutBtn');
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const r = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((it) => ({ id: it.id, size: it.size, color: it.color || 'Black', qty: it.qty, custom: it.custom, avatarDataUrl: it.avatarDataUrl })),
          waiverAccepted: true,
          email: ($('payEmail') && $('payEmail').value) || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) { toast((data.details && data.details[0]) || data.error || 'Checkout failed.', true); return; }
      clientSecret = data.clientSecret;
      orderToken = data.orderToken;
      $('cartSubtotal').textContent = money(data.breakdown.subtotal);
      $('cartShipping').textContent = data.breakdown.shipping === 0 ? 'FREE' : money(data.breakdown.shipping);
      $('cartTotal').textContent = money(data.amount);
      revealPayment(data.amount, data.breakdown.shipping);
    } catch (e) {
      toast('Network error starting checkout.', true);
    } finally {
      btn.disabled = false; btn.textContent = 'Checkout';
    }
  }

  function revealPayment(amount, shippingAmount) {
    $('checkoutBtn').hidden = true;
    $('paymentSection').hidden = false;

    if (!cardEl) {
      cardEl = elements.create('card', { style: { base: { fontSize: '16px', color: '#f4f4f5', fontFamily: 'Inter, sans-serif', '::placeholder': { color: '#6b6b73' } } } });
      cardEl.mount('#card-element');
    }

    paymentRequest = stripe.paymentRequest({
      country: CONFIG.country || 'US',
      currency: CONFIG.currency || 'usd',
      total: { label: CONFIG.brand || 'QuoteUnquote', amount },
      requestPayerName: true, requestPayerEmail: true, requestPayerPhone: true, requestShipping: true,
      shippingOptions: [{ id: 'standard', label: 'Standard (Made On Demand)', detail: '3–5 business days production, then shipped', amount: shippingAmount }],
    });

    paymentRequest.canMakePayment().then((result) => {
      if (result) {
        prButton = elements.create('paymentRequestButton', { paymentRequest });
        prButton.mount('#payment-request-button');
      } else {
        $('payment-request-button').style.display = 'none';
        $('paySep').textContent = '— pay by card —';
      }
    }).catch(() => { $('payment-request-button').style.display = 'none'; });

    paymentRequest.on('shippingaddresschange', (ev) => ev.updateWith({ status: 'success' }));

    paymentRequest.on('paymentmethod', async (ev) => {
      const shipping = mapPRShipping(ev);
      const { error, paymentIntent } = await stripe.confirmCardPayment(
        clientSecret, { payment_method: ev.paymentMethod.id, shipping, receipt_email: ev.payerEmail }, { handleActions: false }
      );
      if (error) { ev.complete('fail'); toast(error.message || 'Payment failed.', true); return; }
      ev.complete('success');
      if (paymentIntent.status === 'requires_action') {
        const res = await stripe.confirmCardPayment(clientSecret);
        if (res.error) { toast(res.error.message, true); return; }
      }
      onPaid();
    });
  }

  function mapPRShipping(ev) {
    const a = ev.shippingAddress || {};
    return {
      name: ev.payerName || a.recipient || 'Customer',
      phone: ev.payerPhone || '',
      address: {
        line1: (a.addressLine && a.addressLine[0]) || '', line2: (a.addressLine && a.addressLine[1]) || '',
        city: a.city || '', state: a.region || '', postal_code: a.postalCode || '', country: a.country || 'US',
      },
    };
  }

  async function payWithCard() {
    if (!stripe || !clientSecret || !cardEl) return;
    const name = ($('payName').value || '').trim();
    const email = ($('payEmail').value || '').trim();
    const line1 = ($('payAddress').value || '').trim();
    const city = ($('payCity').value || '').trim();
    const state = ($('payState').value || '').trim();
    const zip = ($('payZip').value || '').trim();
    const country = (($('payCountry').value || 'US').trim() || 'US').toUpperCase().slice(0, 2);
    if (!name || !email || !line1 || !city || !zip) { toast('Please fill in name, email, and shipping address.', true); return; }

    const btn = $('payNowBtn');
    btn.disabled = true; btn.textContent = 'Processing…';
    try {
      const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card: cardEl, billing_details: { name, email } },
        receipt_email: email,
        shipping: { name, address: { line1, city, state, postal_code: zip, country } },
      });
      if (error) { toast(error.message || 'Payment failed.', true); return; }
      if (paymentIntent && paymentIntent.status === 'succeeded') onPaid();
    } catch (e) {
      toast('Payment error. Please try again.', true);
    } finally {
      btn.disabled = false; btn.textContent = 'Pay Now';
    }
  }

  function onPaid() {
    const token = orderToken;
    cart = []; saveCart(); renderCart();
    toast('Payment received — thank you!');
    closeCart();
    setTimeout(() => { window.location.href = '/track' + (token ? '?order=' + encodeURIComponent(token) : ''); }, 1200);
  }

  // ===========================================================================
  // Modals + toasts
  // ===========================================================================
  function wireModals() {
    const open = $('sizeChartOpen');
    if (open) open.addEventListener('click', () => $('sizeModal').classList.add('open'));
    const close = $('sizeModalClose');
    if (close) close.addEventListener('click', () => closeModal('sizeModal'));
    $('sizeModal').addEventListener('click', (e) => { if (e.target === $('sizeModal')) closeModal('sizeModal'); });
  }
  function closeModal(id) { const m = $(id); if (m) m.classList.remove('open'); }

  function toast(msg, isErr) {
    const wrap = $('toasts');
    const t = el('div', { class: 'toast' + (isErr ? ' err' : ''), text: msg });
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
  }
})();
