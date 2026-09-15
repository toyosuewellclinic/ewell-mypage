  // 秘密情報は置かない (LIFF ID・API の URL は公開情報)。診療情報はサーバが本人確認のうえ返す
  const LIFF_ID = "2011602906-LXBa22oF";
  const API = "https://imabaumalsjptopdiuad.supabase.co/functions/v1/portal";
  const $ = (id) => document.getElementById(id);
  let consentVersion = null;
  let codeMode = false;

  const LINK_MESSAGES = {
    mismatch: "生年月日が登録内容と一致しませんでした。もう一度ご確認ください。",
    no_candidate: "LINEの登録が見つかりませんでした。受付でお渡しする確認コードで登録してください。",
    ambiguous: "ご家族で同じLINEをお使いのようです。受付でお渡しする確認コードで登録してください。",
    code_invalid: "確認コードが正しくないか、有効期限（10分）が切れています。受付で再発行してください。",
    already_linked: "この方は別のLINEで登録済みです。受付にお申し出ください。",
    rate_limited: "入力の誤りが続いたため、一時的に登録できません。24時間後にお試しいただくか、受付にお申し出ください。",
    revoked: "この方のマイページは利用を停止しています。再開をご希望の場合は受付にお申し出ください。",
    invalid_birthdate: "生年月日を正しく入力してください。",
    invalid_input: "確認コードと生年月日を正しく入力してください。",
    consent_required: "同意内容が更新されました。ページを開き直してください。",
  };

  function show(id) {
    for (const s of ["loading", "consent", "docs", "withdraw", "withdrawn", "error"]) $(s).hidden = s !== id;
  }
  function fail(text) { $("error-text").textContent = text; show("error"); }

  async function api(action, extra = {}) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("no_token");
    const res = await fetch(API, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", referrerPolicy: "no-referrer",
      body: JSON.stringify({ action, id_token: idToken, ...extra }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      // 再ログインは 2 分に 1 回まで (Fable M5: 401 が続くと liff.login() の無限リダイレクトになる)
      // sessionStorage に記録できない環境では自動の再ログインをしない (記録できないとループを止められない)
      let canRelogin = false;
      try {
        const last = Number(sessionStorage.getItem("mypage_relogin_at") || 0);
        if (Date.now() - last > 120000) {
          const stamp = String(Date.now());
          sessionStorage.setItem("mypage_relogin_at", stamp);
          canRelogin = sessionStorage.getItem("mypage_relogin_at") === stamp;
        }
      } catch (_) { canRelogin = false; }
      if (canRelogin) { liff.login(); throw new Error("relogin"); }
      throw new Error("unauthenticated");
    }
    if (res.status === 429) throw new Error("rate_limited");
    if (res.status === 503) throw new Error("unavailable");
    if (!res.ok) throw new Error(body.error || String(res.status));
    return body;
  }

  function setCodeMode(on) {
    codeMode = on;
    $("code-area").hidden = !on;
    $("use-code").hidden = on;
  }

  function updateLinkButton() {
    const ok = $("agree").checked && $("birthdate").value && (!codeMode || $("code").value.trim().length >= 8);
    $("link-btn").disabled = !ok;
  }

  async function link() {
    $("link-btn").disabled = true;
    $("link-msg").className = "msg"; $("link-msg").textContent = "確認しています…";
    try {
      const r = codeMode
        ? await api("link_code", { code: $("code").value, birthdate: $("birthdate").value, consent_version: consentVersion })
        : await api("link_birthdate", { birthdate: $("birthdate").value, consent_version: consentVersion });
      if (r.result === "ok") { await loadDocuments(); return; }
      $("link-msg").className = "msg err";
      $("link-msg").textContent = (Object.prototype.hasOwnProperty.call(LINK_MESSAGES, r.result) && LINK_MESSAGES[r.result]) || "登録できませんでした。受付にお申し出ください。";
      if (r.result === "no_candidate" || r.result === "ambiguous") setCodeMode(true);
    } catch (e) {
      if (e.message !== "relogin") { $("link-msg").className = "msg err"; $("link-msg").textContent = "通信に失敗しました。時間をおいてお試しください。"; }
    } finally { updateLinkButton(); }
  }

  function fmtDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${y}年${m}月${d}日`;
  }

  // ---- LINE 内ビューア ------------------------------------------------------
  // PDF は署名 URL (有効 5 分) から取得してこのページの中で描画する。URL や PDF をどこにも保存しない。
  // PDF.js は同梱 (第三者 CDN から読まない)。isEvalSupported:false で PDF 内のコードを実行させない。
  const PDFJS_URL = new URL("vendor/pdfjs/pdf.min.mjs", location.href).href;
  const PDFJS_WORKER_URL = new URL("vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
  let pdfjsPromise = null;
  let viewerSeq = 0;           // 開き直し・戻るで古い描画を捨てるための番号
  let viewerDoc = null;
  let viewerDocumentId = null;

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS_URL).then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; return m; });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  function viewerStatus(text, withExternal) {
    const box = document.createElement("div"); box.id = "vstatus";
    const p = document.createElement("p"); p.textContent = text; box.appendChild(p);
    if (withExternal) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = "外部ブラウザで開く";
      b.addEventListener("click", () => openExternal(viewerDocumentId, b));
      box.appendChild(b);
    }
    $("vpages").replaceChildren(box);
  }

  function closeViewer(fromPopstate) {
    if ($("viewer").hidden) return;
    viewerSeq++;
    if (viewerDoc) { viewerDoc.destroy().catch(() => {}); viewerDoc = null; }
    $("vpages").replaceChildren();
    $("viewer").hidden = true;
    document.body.classList.remove("viewing");
    viewerDocumentId = null;
    if (!fromPopstate && history.state && history.state.viewer) history.back();
  }

  async function openExternal(id, btn) {
    if (!id) return;
    if (btn) btn.disabled = true;
    try {
      // 署名 URL は 5 分で切れるので取り直す。保存用は attachment 指定の URL (閲覧用 URL を履歴に残さない / Fable L12)
      const r = await api("document_url", { document_id: id, purpose: "save" });
      liff.openWindow({ url: r.url, external: true });
    } catch (e) {
      if (e.message !== "relogin") alert("開けませんでした。時間をおいてお試しください。");
    } finally { if (btn) btn.disabled = false; }
  }

  async function openDocument(id, btn, title) {
    btn.disabled = true;
    const seq = ++viewerSeq;
    viewerDocumentId = id;
    $("vtitle").textContent = title;
    viewerStatus("読み込み中…", false);
    $("viewer").hidden = false;
    document.body.classList.add("viewing");
    history.pushState({ viewer: true }, "");  // Android の戻るボタン・スワイプで一覧に戻す
    try {
      const [pdfjs, r] = await Promise.all([loadPdfjs(), api("document_url", { document_id: id })]);
      const res = await fetch(r.url, { cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit" });
      if (!res.ok) throw new Error("fetch_" + res.status);
      const data = new Uint8Array(await res.arrayBuffer());
      if (seq !== viewerSeq) return;
      const doc = await pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
      if (seq !== viewerSeq) { doc.destroy(); return; }
      viewerDoc = doc;
      const holder = $("vpages");
      holder.replaceChildren();
      const cssWidth = Math.max(280, holder.clientWidth - 20);
      // 拡大しても読めるよう端末の画素密度より少し高めに描く (上限 3 倍でメモリを抑える)
      const density = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (seq !== viewerSeq) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * density });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.setAttribute("aria-label", `${title} ${n}ページ目`);
        holder.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
        page.cleanup();
      }
    } catch (e) {
      if (seq !== viewerSeq) return;
      if (e.message === "relogin") { closeViewer(false); return; }
      viewerStatus("この画面では表示できませんでした。外部ブラウザで開くとご覧いただけます。", true);
    } finally { btn.disabled = false; }
  }

  $("vback").addEventListener("click", () => closeViewer(false));
  $("vsave").addEventListener("click", (ev) => openExternal(viewerDocumentId, ev.currentTarget));
  window.addEventListener("popstate", () => closeViewer(true));

  async function loadDocuments() {
    show("loading");
    const { documents } = await api("documents");
    const body = $("docs-body");
    body.textContent = "";
    const published = documents.filter((d) => d.status === "published");
    const corrected = new Set(documents.filter((d) => d.status === "superseded").map((d) => `${d.visit_date}|${d.kind}`));

    function badges(docs) {
      const wrap = document.createElement("div"); wrap.className = "sub";
      if (docs.some((d) => d.is_demo)) {
        const b = document.createElement("span"); b.className = "badge demo"; b.textContent = "デモ"; wrap.appendChild(b);
      }
      if (docs.some((d) => d.version > 1 || corrected.has(`${d.visit_date}|${d.kind}`))) {
        const b = document.createElement("span"); b.className = "badge"; b.textContent = "訂正済み"; wrap.appendChild(b);
      }
      return wrap.childElementCount ? wrap : null;
    }

    // 1 セクション = 見出し + 年ごと + 日付ごとの行 (行のボタンは kind ごと)
    function section(title, kinds, dateLabel, subLabel, emptyText) {
      const h = document.createElement("div"); h.className = "section-title"; h.textContent = title; body.appendChild(h);
      const docs = published.filter((d) => kinds[d.kind]);
      if (!docs.length) {
        const p = document.createElement("div"); p.className = "empty"; p.textContent = emptyText; body.appendChild(p);
        return;
      }
      const byDate = new Map();
      for (const d of docs) {
        if (!byDate.has(d.visit_date)) byDate.set(d.visit_date, []);
        byDate.get(d.visit_date).push(d);
      }
      let year = null;
      for (const [date, ds] of byDate) {
        const y = date.slice(0, 4);
        if (y !== year) {
          year = y;
          const yh = document.createElement("div"); yh.className = "year"; yh.textContent = `${y}年`; body.appendChild(yh);
        }
        const row = document.createElement("div"); row.className = "doc";
        const left = document.createElement("div");
        const t = document.createElement("div"); t.className = "title"; t.textContent = `${dateLabel}${fmtDate(date)}`;
        left.appendChild(t);
        const rep = ds.find((d) => d.report_date);
        if (subLabel && rep) {
          const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = `${subLabel}${fmtDate(rep.report_date)}`;
          left.appendChild(sub);
        }
        const bd = badges(ds); if (bd) left.appendChild(bd);
        const btns = document.createElement("div"); btns.className = "btns";
        const order = Object.keys(kinds);
        ds.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
        for (const d of ds) {
          const btn = document.createElement("button"); btn.textContent = kinds[d.kind];
          btn.addEventListener("click", () => openDocument(d.document_id, btn, `${kinds[d.kind]}（${fmtDate(date)}）`));
          btns.appendChild(btn);
        }
        row.append(left, btns);
        body.appendChild(row);
      }
    }

    section("検査結果", { lab: "結果" }, "採取日 ", "報告日 ", "表示できる検査結果はありません。");
    section("健診結果", { kenshin: "個人票" }, "受診日 ", null, "表示できる健診結果はありません。");
    section("領収書・明細書", { receipt: "領収書", meisai: "明細書" }, "", null,
            "表示できる書類はまだありません。登録直後は、準備ができるまで少しお待ちください。");
    show("docs");
  }

  // ---- 利用をやめる (本人の利用停止) ---------------------------------------------
  const WITHDRAW_MESSAGES = {
    mismatch: "生年月日が登録内容と一致しませんでした。もう一度ご確認ください。",
    rate_limited: "入力の誤りが続いたため、一時的に手続きできません。24時間後にお試しいただくか、受付にお申し出ください。",
    not_linked: "このLINEには、利用中のマイページ登録がありません。",
    invalid_birthdate: "生年月日を正しく入力してください。",
  };

  function updateWithdrawButton() {
    $("withdraw-btn").disabled = !($("w-agree").checked && $("w-birthdate").value);
  }

  function openWithdraw() {
    $("w-birthdate").value = ""; $("w-agree").checked = false; $("w-msg").textContent = "";
    $("w-birthdate").max = new Date().toISOString().slice(0, 10);
    updateWithdrawButton();
    show("withdraw");
    window.scrollTo(0, 0);
  }

  async function withdraw() {
    // 最終確認 (押し間違い防止の 2 段目)
    if (!window.confirm("マイページの利用をやめて、掲載している書類をすべて削除します。よろしいですか？")) return;
    $("withdraw-btn").disabled = true;
    $("w-msg").className = "msg"; $("w-msg").textContent = "手続きしています…";
    try {
      const r = await api("withdraw", { birthdate: $("w-birthdate").value, confirm: true });
      if (r.result === "ok") { show("withdrawn"); window.scrollTo(0, 0); return; }
      $("w-msg").className = "msg err";
      $("w-msg").textContent = (Object.prototype.hasOwnProperty.call(WITHDRAW_MESSAGES, r.result) && WITHDRAW_MESSAGES[r.result])
        || "手続きできませんでした。受付にお申し出ください。";
    } catch (e) {
      if (e.message !== "relogin") { $("w-msg").className = "msg err"; $("w-msg").textContent = "通信に失敗しました。時間をおいてお試しください。"; }
    } finally { updateWithdrawButton(); }
  }

  $("build").textContent = "画面の版 2026-09-16.1";
  $("withdraw-open").addEventListener("click", openWithdraw);
  $("withdraw-cancel").addEventListener("click", () => { show("docs"); });
  $("w-agree").addEventListener("change", updateWithdrawButton);
  $("w-birthdate").addEventListener("input", updateWithdrawButton);
  $("withdraw-btn").addEventListener("click", withdraw);

  (async () => {
    try {
      await liff.init({ liffId: LIFF_ID });
      if (!liff.isLoggedIn()) { liff.login(); return; }
      const s = await api("session");
      consentVersion = s.consent_version;
      if (s.linked_patients > 0) { await loadDocuments(); return; }
      setCodeMode(!s.has_candidate);
      $("birthdate").max = new Date().toISOString().slice(0, 10);
      for (const id of ["agree", "birthdate", "code"]) $(id).addEventListener("input", updateLinkButton);
      $("agree").addEventListener("change", updateLinkButton);
      $("use-code").addEventListener("click", () => { setCodeMode(true); updateLinkButton(); });
      $("link-btn").addEventListener("click", link);
      show("consent");
    } catch (e) {
      if (e.message === "unauthenticated") fail("ログインを確認できませんでした。LINEを開き直してからお試しください。");
      else if (e.message !== "relogin") fail("読み込みに失敗しました。時間をおいて開き直してください。");
    }
  })();
