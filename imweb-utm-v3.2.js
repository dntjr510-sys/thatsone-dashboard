/**
 * 아임웹 UTM 패스스루 스크립트 v3
 *
 * v2 대비 개선:
 * - gclid / fbclid 자동 추적 (구글·메타 자동태깅 링크)
 * - referrer 기록 (UTM 없어도 유입 경로 힌트 확보)
 * - 디버그 모드 (URL에 ?tone_debug=1 붙이면 콘솔 상세 로그)
 * - 중복 전환 방지 (같은 세션에서 lead_complete 1회만 발송)
 * - landing page URL 저장 + GA4 이벤트에 포함
 *
 * 설치: 아임웹 관리자 → 환경설정 → 코드 삽입 → </body> 앞에 붙여넣기
 * ⚠️ 반드시 <script>...</script> 태그로 감싸서 붙여넣기 (생략 시 코멘트가 본문에 노출됨)
 * (기존 v1/v2 스크립트는 제거하고 교체)
 *
 * 작성: 2026.04.20 / v3.1 (5/1 내부링크 비활성화) → v3.2 (5/1 인앱브라우저 자동감지)
 */

(function() {
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var CLICK_IDS = ['gclid', 'fbclid', 'yclid', 'msclkid']; // 구글·메타·네이버·빙
  var STORAGE_PREFIX = 'tone_';
  var SESSION_KEY = 'tone_session';
  var EXPIRY_DAYS = 30;
  var DEBUG = new URLSearchParams(window.location.search).get('tone_debug') === '1';

  function log() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[ToneUTM]'].concat(args));
  }

  // ── 1. URL 파라미터 + referrer + landing 저장 ──
  function captureEntry() {
    var params = new URLSearchParams(window.location.search);
    var now = Date.now();
    var captured = {};

    // UTM 저장
    UTM_KEYS.forEach(function(key) {
      var val = params.get(key);
      if (val) {
        localStorage.setItem(STORAGE_PREFIX + key, val);
        localStorage.setItem(STORAGE_PREFIX + key + '_ts', String(now));
        captured[key] = val;
      }
    });

    // 클릭 ID (gclid, fbclid 등) 저장
    CLICK_IDS.forEach(function(key) {
      var val = params.get(key);
      if (val) {
        localStorage.setItem(STORAGE_PREFIX + key, val);
        localStorage.setItem(STORAGE_PREFIX + key + '_ts', String(now));
        captured[key] = val;
      }
    });

    // referrer 저장 (외부 유입 시에만)
    try {
      if (document.referrer) {
        var refUrl = new URL(document.referrer);
        if (refUrl.hostname && refUrl.hostname !== window.location.hostname) {
          localStorage.setItem(STORAGE_PREFIX + 'referrer', refUrl.hostname);
          localStorage.setItem(STORAGE_PREFIX + 'referrer_ts', String(now));
          captured.referrer = refUrl.hostname;
        }
      }
    } catch (_) {}

    // 첫 진입 URL (landing) 저장 - 세션 최초 1회만
    if (!sessionStorage.getItem(STORAGE_PREFIX + 'landing')) {
      var landing = window.location.pathname + window.location.search;
      sessionStorage.setItem(STORAGE_PREFIX + 'landing', landing);
      captured.landing = landing;
    }

    // ── 인앱 브라우저 자동 감지 (utm 비어있을 때만) ──
    var INAPP_PATTERNS = [
      { regex: /KAKAOTALK/i, source: 'kakao', medium: 'inapp' },
      { regex: /Instagram/i, source: 'instagram', medium: 'inapp' },
      { regex: /FBAN|FBAV/i, source: 'facebook', medium: 'inapp' },
      { regex: /NAVER\(inapp/i, source: 'naver', medium: 'inapp' },
      { regex: /Line\//i, source: 'line', medium: 'inapp' }
    ];
    var ua = navigator.userAgent || '';
    var hasUtmSource = !!localStorage.getItem(STORAGE_PREFIX + 'utm_source');
    if (!hasUtmSource) {
      for (var i = 0; i < INAPP_PATTERNS.length; i++) {
        if (INAPP_PATTERNS[i].regex.test(ua)) {
          localStorage.setItem(STORAGE_PREFIX + 'utm_source', INAPP_PATTERNS[i].source);
          localStorage.setItem(STORAGE_PREFIX + 'utm_source_ts', String(now));
          localStorage.setItem(STORAGE_PREFIX + 'utm_medium', INAPP_PATTERNS[i].medium);
          localStorage.setItem(STORAGE_PREFIX + 'utm_medium_ts', String(now));
          captured.utm_source = INAPP_PATTERNS[i].source;
          captured.utm_medium = INAPP_PATTERNS[i].medium;
          captured._inapp_detected = true;
          break;
        }
      }
    }

    if (Object.keys(captured).length > 0) {
      log('Captured:', captured);
    }
  }

  // ── 2. 저장된 데이터 읽기 (30일 만료) ──
  function readStored() {
    var data = {};
    var now = Date.now();
    var maxAge = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

    UTM_KEYS.concat(CLICK_IDS).concat(['referrer']).forEach(function(key) {
      var val = localStorage.getItem(STORAGE_PREFIX + key);
      var ts = Number(localStorage.getItem(STORAGE_PREFIX + key + '_ts') || 0);
      if (val && (now - ts) < maxAge) {
        data[key] = val;
      }
    });

    data.landing = sessionStorage.getItem(STORAGE_PREFIX + 'landing') || '';
    return data;
  }

  // UTM만 추출 (Tally 폼에 전달용)
  function readUtmOnly() {
    var stored = readStored();
    var utm = {};
    UTM_KEYS.forEach(function(k) { if (stored[k]) utm[k] = stored[k]; });
    return utm;
  }

  // ── 3. Tally iframe src에 UTM 주입 ──
  function injectUtmToTallyIframes() {
    var utm = readUtmOnly();
    if (Object.keys(utm).length === 0) return;

    var iframes = document.querySelectorAll('iframe[src*="tally.so"]');
    iframes.forEach(function(iframe) {
      try {
        var url = new URL(iframe.src);
        var changed = false;
        Object.keys(utm).forEach(function(key) {
          if (!url.searchParams.has(key)) {
            url.searchParams.set(key, utm[key]);
            changed = true;
          }
        });
        if (changed) {
          iframe.src = url.toString();
          log('Iframe UTM injected:', iframe.src);
        }
      } catch (e) {
        log('Iframe inject failed:', e);
      }
    });
  }

  // ── 4. Tally anchor 링크에도 UTM 부착 ──
  function injectUtmToTallyAnchors() {
    var utm = readUtmOnly();
    if (Object.keys(utm).length === 0) return;

    var links = document.querySelectorAll('a[href*="tally.so"]');
    links.forEach(function(link) {
      try {
        var url = new URL(link.href);
        var changed = false;
        Object.keys(utm).forEach(function(key) {
          if (!url.searchParams.has(key)) {
            url.searchParams.set(key, utm[key]);
            changed = true;
          }
        });
        if (changed) {
          link.href = url.toString();
        }
      } catch (_) {}
    });
  }

  // ── 5. 내부 링크(a 태그)에도 UTM 보존 — DISABLED (v3.1, 5/1) ──
  // 옛 UTM이 30일 동안 모든 내부 링크에 자동 주입되어 URL 오염 + 데이터 왜곡 발생.
  // UTM은 Tally 폼 진입 시점에만 주입되면 충분. 내부 네비게이션은 깨끗하게 유지.
  function injectUtmToInternalLinks() {
    return; // no-op — 의도적으로 비활성화
  }

  // ── 6. 전화 클릭 GA4 이벤트 ──
  function trackPhoneClicks() {
    document.addEventListener('click', function(e) {
      var link = e.target.closest('a[href^="tel:"]');
      if (link && typeof gtag === 'function') {
        var stored = readStored();
        gtag('event', 'phone_click', {
          event_category: 'engagement',
          event_label: link.href.replace('tel:', ''),
          utm_source: stored.utm_source || '(direct)',
          utm_medium: stored.utm_medium || '(none)',
          utm_campaign: stored.utm_campaign || '',
          referrer: stored.referrer || '',
          landing: stored.landing || ''
        });
        log('phone_click fired', stored);
      }
    });
  }

  // ── 7. Tally iframe 제출 감지 → GA4 lead_complete 이벤트 ──
  function trackTallySubmission() {
    window.addEventListener('message', function(e) {
      var payload = e.data;
      var isTallySubmit = false;
      var formId = '';

      if (typeof payload === 'string') {
        if (payload.indexOf('Tally.FormSubmitted') !== -1 || payload.indexOf('FormSubmitted') !== -1) {
          isTallySubmit = true;
          try {
            var parsed = JSON.parse(payload);
            formId = (parsed.payload && parsed.payload.formId) || parsed.formId || '';
          } catch (_) {}
        }
      } else if (payload && typeof payload === 'object') {
        if (payload.event === 'Tally.FormSubmitted' || payload.type === 'Tally.FormSubmitted') {
          isTallySubmit = true;
          formId = (payload.payload && payload.payload.formId) || payload.formId || '';
        }
      }

      if (!isTallySubmit) return;

      // 중복 전환 방지 — 같은 세션에서 동일 폼 1회만 발송
      var dedupKey = STORAGE_PREFIX + 'fired_' + (formId || 'unknown');
      if (sessionStorage.getItem(dedupKey)) {
        log('Duplicate submission ignored:', formId);
        return;
      }
      sessionStorage.setItem(dedupKey, String(Date.now()));

      if (typeof gtag !== 'function') {
        log('gtag not available, skipping event');
        return;
      }

      var stored = readStored();
      gtag('event', 'lead_complete', {
        event_category: 'lead',
        event_label: 'tally_iframe_submit',
        form_id: formId || 'unknown',
        utm_source: stored.utm_source || '(direct)',
        utm_medium: stored.utm_medium || '(none)',
        utm_campaign: stored.utm_campaign || '',
        utm_content: stored.utm_content || '',
        utm_term: stored.utm_term || '',
        gclid: stored.gclid || '',
        fbclid: stored.fbclid || '',
        referrer: stored.referrer || '',
        landing: stored.landing || ''
      });
      log('lead_complete fired', { formId: formId, data: stored });
    });
  }

  // ── 8. 전체 실행 (디바운스 포함) ──
  var runTimer = null;
  function runAll() {
    injectUtmToTallyIframes();
    injectUtmToTallyAnchors();
    injectUtmToInternalLinks();
  }
  function runAllDebounced() {
    clearTimeout(runTimer);
    runTimer = setTimeout(runAll, 100);
  }

  // 초기 실행
  captureEntry();
  runAll();
  trackPhoneClicks();
  trackTallySubmission();

  // 지연 실행 (동적 콘텐츠 대비)
  setTimeout(runAll, 500);
  setTimeout(runAll, 1500);
  setTimeout(runAll, 3000);

  // DOM 변경 감지 (SPA/동적 iframe 로딩 대응) — 디바운스로 과도한 실행 방지
  if (typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function(mutations) {
      var hasNew = mutations.some(function(m) {
        return Array.from(m.addedNodes).some(function(n) {
          return n.nodeType === 1 && (
            n.tagName === 'IFRAME' || n.tagName === 'A' ||
            (n.querySelectorAll && n.querySelectorAll('iframe, a').length > 0)
          );
        });
      });
      if (hasNew) runAllDebounced();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // 디버그 모드 전역 노출
  if (DEBUG) {
    window.ToneUTM = {
      stored: readStored,
      utm: readUtmOnly,
      rerun: runAll,
      clear: function() {
        UTM_KEYS.concat(CLICK_IDS).concat(['referrer']).forEach(function(k) {
          localStorage.removeItem(STORAGE_PREFIX + k);
          localStorage.removeItem(STORAGE_PREFIX + k + '_ts');
        });
        sessionStorage.clear();
        console.log('[ToneUTM] All data cleared');
      }
    };
    console.log('[ToneUTM] Debug mode ON. Use window.ToneUTM.stored() / .utm() / .rerun() / .clear()');
    console.log('[ToneUTM] Current stored data:', readStored());
  }
})();
