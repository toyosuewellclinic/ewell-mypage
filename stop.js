// 配信の停止の確認画面。開いただけでは止めない (メールのリンク検査で勝手に止まらないように)。ボタンで送る。
(function () {
  "use strict";
  const API = "https://imabaumalsjptopdiuad.supabase.co/functions/v1/email-stop";
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
  if (!/^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(token)) {
    $("bad").hidden = false;
    return;
  }
  history.replaceState(null, "", location.pathname);
  $("ask").hidden = false;
  $("go").addEventListener("click", async () => {
    $("go").disabled = true;
    $("fail").hidden = true;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.status === 400) {
        $("ask").hidden = true;
        $("bad").hidden = false;
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      $("ask").hidden = true;
      $("done").hidden = false;
    } catch (_) {
      $("fail").hidden = false;
      $("go").disabled = false;
    }
  });
})();
