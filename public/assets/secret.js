// Приховані поля: ключі, токени й посилання показуються зірочками (щоб не «спалити» на стрімі),
// поруч кнопки 👁 «показати» та 📋 «копіювати».
// Використання: <input data-secret> (або data-secret="nocopy" для паролів без копіювання), потім MDSecret.enhance().
(function () {
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.6 10.6 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="m2 2 20 20"/></svg>';
  const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  // -webkit-text-security маскує звичайне текстове поле — браузер тоді не пропонує «зберегти пароль» для ключів
  const cssMask = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('-webkit-text-security', 'disc');

  const style = document.createElement('style');
  style.textContent = `
    .sec-wrap { position: relative; display: block; flex: 1; min-width: 0; }
    .sec-wrap > input { width: 100%; padding-right: 84px !important; }
    .sec-wrap.nocopy > input { padding-right: 46px !important; }
    .sec-wrap > input.sec-masked { -webkit-text-security: disc; letter-spacing: .12em; }
    .sec-btns { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; }
    .sec-btns button { width: 34px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--mute, #b3adc2); transition: background .15s, color .15s; }
    .sec-btns button:hover { background: rgba(255,255,255,.08); color: var(--text, #fff); }
    .sec-btns button.ok { color: var(--green, #34d399); }
    .sec-btns svg { width: 18px; height: 18px; }`;
  document.head.appendChild(style);

  function setHidden(input, hidden) {
    input._secHidden = hidden;
    if (cssMask) input.classList.toggle('sec-masked', hidden);
    else input.type = hidden ? 'password' : 'text';
    const b = input._secEye;
    if (b) { b.innerHTML = hidden ? EYE : EYE_OFF; b.title = hidden ? 'Показати' : 'Сховати'; b.setAttribute('aria-label', b.title); }
  }

  function enhanceOne(input) {
    if (input._secDone) return;
    input._secDone = true;
    const noCopy = input.dataset.secret === 'nocopy';
    if (cssMask && input.type === 'password') input.type = 'text';
    input.autocomplete = input.autocomplete && input.autocomplete.includes('password') ? input.autocomplete : 'off';
    input.spellcheck = false;
    input.setAttribute('data-lpignore', 'true'); input.setAttribute('data-1p-ignore', '');

    // старі кнопки «око», якщо були в розмітці
    const oldWrap = input.closest('.input-wrap');
    if (oldWrap) oldWrap.querySelectorAll('.eye').forEach(b => b.remove());

    const wrap = document.createElement('span');
    wrap.className = 'sec-wrap' + (noCopy ? ' nocopy' : '');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btns = document.createElement('span'); btns.className = 'sec-btns';
    const eye = document.createElement('button'); eye.type = 'button';
    eye.onclick = () => setHidden(input, !input._secHidden);
    input._secEye = eye;
    btns.appendChild(eye);
    if (!noCopy) {
      const cp = document.createElement('button'); cp.type = 'button'; cp.innerHTML = COPY; cp.title = 'Копіювати'; cp.setAttribute('aria-label', 'Копіювати');
      cp.onclick = () => {
        if (!input.value) return;
        navigator.clipboard.writeText(input.value).then(() => {
          cp.innerHTML = CHECK; cp.classList.add('ok');
          setTimeout(() => { cp.innerHTML = COPY; cp.classList.remove('ok'); }, 1200);
        }).catch(() => { input.focus(); input.select(); });
      };
      btns.appendChild(cp);
    }
    wrap.appendChild(btns);
    setHidden(input, true);
  }

  window.MDSecret = {
    enhance(root) { (root || document).querySelectorAll('input[data-secret]').forEach(enhanceOne); },
    hideAll(root) { (root || document).querySelectorAll('input[data-secret]').forEach(i => i._secDone && setHidden(i, true)); },
  };
})();
