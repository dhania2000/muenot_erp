/*!
 * Muenot ERP — Website Analytics tracker (lightweight, privacy-aware).
 *
 * Install:
 *   <script async src="https://your-erp-domain/wa.js" data-tracking-id="MU-XXXX"></script>
 *
 * It never collects passwords, payment fields or private message content.
 * It sends anonymous, aggregate-friendly events to the ERP ingestion endpoint.
 */
(function () {
  "use strict";
  try {
    var script = document.currentScript;
    if (!script) {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf("wa.js") !== -1) { script = all[i]; break; }
      }
    }
    if (!script) return;

    var TRACKING_ID = script.getAttribute("data-tracking-id") || script.getAttribute("data-wa");
    if (!TRACKING_ID) return;

    var ENDPOINT;
    try { ENDPOINT = new URL(script.src).origin + "/api/marketing/website-analytics/collect"; }
    catch (e) { return; }

    var IS_TEST = script.getAttribute("data-test") === "1";
    var SESSION_TIMEOUT_MS = (parseInt(script.getAttribute("data-session-timeout"), 10) || 30) * 60 * 1000;

    // ---- identifiers (anonymous) ---------------------------------------
    function uid() {
      try {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      } catch (e) {}
      return "x" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    function getVisitorId() {
      var k = "_wa_vid";
      var v;
      try { v = localStorage.getItem(k); } catch (e) {}
      if (!v) { v = uid(); try { localStorage.setItem(k, v); } catch (e) {} }
      return v;
    }
    function getSessionId() {
      var k = "_wa_sid", tk = "_wa_sts", now = Date.now(), sid, ts;
      try { sid = sessionStorage.getItem(k); ts = parseInt(sessionStorage.getItem(tk), 10); } catch (e) {}
      if (!sid || !ts || (now - ts) > SESSION_TIMEOUT_MS) { sid = uid(); }
      try { sessionStorage.setItem(k, sid); sessionStorage.setItem(tk, String(now)); } catch (e) {}
      return sid;
    }
    function touchSession() {
      try { sessionStorage.setItem("_wa_sts", String(Date.now())); } catch (e) {}
    }

    var VISITOR_ID = getVisitorId();

    // ---- context capture -----------------------------------------------
    function readUTM() {
      var utm = {}, p;
      try { p = new URLSearchParams(location.search); } catch (e) { return utm; }
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(function (k) {
        var v = p.get(k); if (v) utm[k] = String(v).slice(0, 190);
      });
      // Persist first-touch UTM for the session so later events keep attribution.
      try {
        if (Object.keys(utm).length) sessionStorage.setItem("_wa_utm", JSON.stringify(utm));
        else { var s = sessionStorage.getItem("_wa_utm"); if (s) utm = JSON.parse(s); }
      } catch (e) {}
      return utm;
    }
    function screenSize() {
      try {
        var w = window.screen ? window.screen.width : 0;
        if (w >= 1440) return "xl"; if (w >= 1024) return "lg";
        if (w >= 768) return "md"; if (w >= 480) return "sm"; return "xs";
      } catch (e) { return null; }
    }

    var queue = [];
    var flushTimer = null;

    function baseEvent(type, extra) {
      touchSession();
      var e = {
        type: type,
        visitor_id: VISITOR_ID,
        session_id: getSessionId(),
        page_url: location.href.slice(0, 1000),
        page_title: (document.title || "").slice(0, 300),
        referrer: (document.referrer || "").slice(0, 1000),
        utm: readUTM(),
        screen_size: screenSize(),
        language: (navigator.language || "").slice(0, 20),
        is_test: IS_TEST,
        ts: Date.now()
      };
      if (extra) for (var k in extra) e[k] = extra[k];
      return e;
    }

    function send(events, useBeacon) {
      var payload = JSON.stringify({ tracking_id: TRACKING_ID, events: events });
      try {
        if (useBeacon && navigator.sendBeacon) {
          navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }));
          return;
        }
      } catch (e) {}
      try {
        fetch(ENDPOINT, { method: "POST", body: payload, headers: { "Content-Type": "application/json" }, keepalive: true, mode: "cors" });
      } catch (e) {}
    }

    function flush(useBeacon) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!queue.length) return;
      var batch = queue.splice(0, 30);
      send(batch, useBeacon);
    }

    function track(type, extra) {
      queue.push(baseEvent(type, extra));
      if (queue.length >= 10) { flush(false); return; }
      if (!flushTimer) flushTimer = setTimeout(function () { flush(false); }, 2500);
    }

    // ---- page lifecycle -------------------------------------------------
    var pageEnterTs = Date.now();
    var isNewSession = false;
    try {
      var existed = sessionStorage.getItem("_wa_started");
      if (!existed) { isNewSession = true; sessionStorage.setItem("_wa_started", "1"); }
    } catch (e) {}

    if (isNewSession) track("session_start");
    track("page_view");
    track("page_enter");

    // ---- scroll depth (fires once at 75%) ------------------------------
    var scrolled = false;
    window.addEventListener("scroll", function () {
      if (scrolled) return;
      var h = document.documentElement;
      var depth = (h.scrollTop + window.innerHeight) / (h.scrollHeight || 1);
      if (depth >= 0.75) { scrolled = true; track("scroll", { metadata: { depth: 75 } }); }
    }, { passive: true });

    // ---- clicks: outbound, downloads, CTAs -----------------------------
    var DOWNLOAD_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|csv|mp4|mov|dmg|exe|apk|pkg)(\?|$)/i;
    document.addEventListener("click", function (ev) {
      var el = ev.target;
      while (el && el !== document.body && el.tagName !== "A" && !el.getAttribute("data-wa-event")) el = el.parentNode;
      if (!el || el === document.body) return;

      var custom = el.getAttribute && el.getAttribute("data-wa-event");
      if (custom) {
        track("custom", { name: String(custom).slice(0, 120), metadata: waData(el) });
        return;
      }
      if (el.tagName === "A" && el.href) {
        var href = el.href;
        if (DOWNLOAD_RE.test(href) || el.hasAttribute("download")) {
          track("download", { name: fileName(href), metadata: { href: href.slice(0, 300) } });
        } else if (el.hostname && el.hostname !== location.hostname) {
          track("outbound_link", { name: el.hostname, metadata: { href: href.slice(0, 300) } });
        } else if (el.getAttribute("data-wa-cta")) {
          track("cta_click", { name: el.getAttribute("data-wa-cta").slice(0, 120) });
        }
      }
    }, true);

    function waData(el) {
      var m = {};
      try {
        for (var i = 0; i < el.attributes.length; i++) {
          var a = el.attributes[i];
          if (a.name.indexOf("data-wa-") === 0 && a.name !== "data-wa-event") m[a.name.slice(8)] = String(a.value).slice(0, 120);
        }
      } catch (e) {}
      return m;
    }
    function fileName(href) { try { return href.split("/").pop().split("?")[0].slice(0, 120); } catch (e) { return "file"; } }

    // ---- forms: start / submit (no field values captured) --------------
    var startedForms = new WeakSet();
    document.addEventListener("focusin", function (ev) {
      var form = ev.target && ev.target.form;
      if (form && !startedForms.has(form)) {
        startedForms.add(form);
        track("form_start", { name: formName(form) });
      }
    }, true);
    document.addEventListener("submit", function (ev) {
      var form = ev.target;
      if (form && form.tagName === "FORM") {
        track("form_submit", { name: formName(form), metadata: { id: (form.id || "").slice(0, 120) } });
        flush(true);
      }
    }, true);
    function formName(form) {
      return String(form.getAttribute("data-wa-form") || form.name || form.id || "form").slice(0, 120);
    }

    // ---- site search (input[type=search] / [data-wa-search]) -----------
    document.addEventListener("submit", function (ev) {
      var form = ev.target;
      if (!form || form.tagName !== "FORM") return;
      var input = form.querySelector('input[type="search"], input[data-wa-search], input[name="q"], input[name="s"]');
      if (input) track("search", { metadata: { hasQuery: input.value ? 1 : 0 } }); // query text intentionally NOT sent
    }, true);

    // ---- video (best-effort) -------------------------------------------
    document.addEventListener("play", function (ev) {
      if (ev.target && ev.target.tagName === "VIDEO") track("video_play", { name: (ev.target.currentSrc || "video").slice(0, 120) });
    }, true);
    document.addEventListener("ended", function (ev) {
      if (ev.target && ev.target.tagName === "VIDEO") track("video_complete", { name: (ev.target.currentSrc || "video").slice(0, 120) });
    }, true);

    // ---- exit / unload -------------------------------------------------
    function onExit() {
      track("page_exit", { duration_ms: Date.now() - pageEnterTs });
      track("session_end", { duration_ms: Date.now() - pageEnterTs });
      flush(true);
    }
    window.addEventListener("pagehide", onExit);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flush(true);
    });

    // ---- public API for manual events ----------------------------------
    // window.muenotAnalytics.track('lead_conversion', { name: 'Demo request' })
    window.muenotAnalytics = {
      track: function (type, extra) { track(String(type).slice(0, 40), extra || {}); },
      conversion: function (name, meta) { track("lead_conversion", { name: name, metadata: meta || {} }); flush(false); }
    };
  } catch (e) {
    // Never let analytics break the host site.
    if (window.console && console.warn) console.warn("[muenot-wa]", e);
  }
})();
