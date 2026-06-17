const WORLD = "ISOLATED";
const CAPTURE_FILE = "capture-official.js";
const RUNNER_FILE = "runner.js";
const TOOLBAR_FILE = "inpage-toolbar.js";

const FIGMA_CAPTURE_CONCURRENCY_KEY = "proxyFetchConcurrency";
const FIGMA_CAPTURE_ALLOWED_CONCURRENCY = new Set([4, 6, 8, 10, 12, 16, 20]);
const FIGMA_CAPTURE_DEFAULT_CONCURRENCY = 8;
const FIGMA_CAPTURE_PROXY_SESSION_KEY = "figmaCaptureProxyAssetCacheV1";
const FIGMA_CAPTURE_PROXY_DIAG_KEY = "figmaCaptureProxyDiagnosticsV1";
const FIGMA_CAPTURE_PROXY_MAX_DIAG = 500;
const FIGMA_CAPTURE_FETCH_TIMEOUT_MS = 8000;

const figmaProxyQueue = [];
const figmaProxyInFlight = new Map();
const figmaProxyMemCache = new Map();
let figmaProxyActive = 0;
let figmaProxyMaxConcurrency = FIGMA_CAPTURE_DEFAULT_CONCURRENCY;
let figmaProxySessionLoaded = false;
let figmaProxySessionCache = {};
let figmaProxyDiagnostics = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectScriptFile(tabId, file, frameIds) {
  const target = { tabId };
  if (frameIds) {
    target.frameIds = frameIds;
  }

  await chrome.scripting.executeScript({
    target,
    world: WORLD,
    files: [file],
  });
}

async function runCapture(tabId) {
  const frameId = await findPrototypeFrameId(tabId);
  const frameIds = frameId == null ? undefined : [frameId];

  await injectScriptFile(tabId, CAPTURE_FILE, frameIds);
  await sleep(300);
  const [{ result }] = await chrome.scripting.executeScript({
    target: frameIds ? { tabId, frameIds } : { tabId },
    world: WORLD,
    files: [RUNNER_FILE],
  });
  return result;
}

async function findPrototypeFrameId(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  const candidate = frames.find((frame) => {
    try {
      const url = new URL(frame.url || "");
      return /10_appointment_list\.html|pages\/\d+_|pages\/\d|demo_stitch_ai\/pages/i.test(url.href);
    } catch {
      return false;
    }
  });

  return candidate?.frameId ?? null;
}

function saveResult(result) {
  const text = JSON.stringify(result, null, 2);
  const url = `data:application/json;charset=utf-8;base64,${toBase64(
    new TextEncoder().encode(text).buffer
  )}`;
  const filename = `figma-capture-${Date.now()}.json`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

function isTransientCaptureError(error) {
  return /Frame with ID \d+ was removed|message channel closed|No tab with id|The tab was closed|Extension context invalidated/i.test(
    String(error)
  );
}

function normalizeConcurrency(value) {
  if (value === "infinite" || value === "∞") {
    return Number.POSITIVE_INFINITY;
  }
  const numeric = Number(value);
  if (FIGMA_CAPTURE_ALLOWED_CONCURRENCY.has(numeric)) {
    return numeric;
  }
  return FIGMA_CAPTURE_DEFAULT_CONCURRENCY;
}

function concurrencyLabel() {
  return Number.isFinite(figmaProxyMaxConcurrency)
    ? String(figmaProxyMaxConcurrency)
    : "infinite";
}

async function loadConcurrencyConfig() {
  try {
    const data = await chrome.storage.local.get({
      [FIGMA_CAPTURE_CONCURRENCY_KEY]: String(FIGMA_CAPTURE_DEFAULT_CONCURRENCY),
    });
    figmaProxyMaxConcurrency = normalizeConcurrency(
      data?.[FIGMA_CAPTURE_CONCURRENCY_KEY]
    );
  } catch {
    figmaProxyMaxConcurrency = FIGMA_CAPTURE_DEFAULT_CONCURRENCY;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area !== "local" ||
    !changes ||
    !changes[FIGMA_CAPTURE_CONCURRENCY_KEY]
  ) {
    return;
  }
  figmaProxyMaxConcurrency = normalizeConcurrency(
    changes[FIGMA_CAPTURE_CONCURRENCY_KEY].newValue
  );
  pumpProxyQueue();
});

function pushDiag(entry) {
  figmaProxyDiagnostics.push({ ts: Date.now(), ...entry });
  if (figmaProxyDiagnostics.length > FIGMA_CAPTURE_PROXY_MAX_DIAG) {
    figmaProxyDiagnostics = figmaProxyDiagnostics.slice(-FIGMA_CAPTURE_PROXY_MAX_DIAG);
  }
  if (chrome?.storage?.session) {
    chrome.storage.session
      .set({ [FIGMA_CAPTURE_PROXY_DIAG_KEY]: figmaProxyDiagnostics })
      .catch(() => {});
  }
}

async function loadProxySession() {
  if (figmaProxySessionLoaded) return;
  figmaProxySessionLoaded = true;
  if (!chrome?.storage?.session) return;
  try {
    const data = await chrome.storage.session.get({
      [FIGMA_CAPTURE_PROXY_SESSION_KEY]: {},
      [FIGMA_CAPTURE_PROXY_DIAG_KEY]: [],
    });
    figmaProxySessionCache = data?.[FIGMA_CAPTURE_PROXY_SESSION_KEY] || {};
    figmaProxyDiagnostics = Array.isArray(data?.[FIGMA_CAPTURE_PROXY_DIAG_KEY])
      ? data[FIGMA_CAPTURE_PROXY_DIAG_KEY]
      : [];
  } catch {
    figmaProxySessionCache = {};
    figmaProxyDiagnostics = [];
  }
}

async function persistProxySession() {
  if (!chrome?.storage?.session) return;
  try {
    await chrome.storage.session.set({
      [FIGMA_CAPTURE_PROXY_SESSION_KEY]: figmaProxySessionCache,
      [FIGMA_CAPTURE_PROXY_DIAG_KEY]: figmaProxyDiagnostics,
    });
  } catch {
    // no-op
  }
}

function enqueueProxyTask(task) {
  return new Promise((resolve, reject) => {
    figmaProxyQueue.push({ task, resolve, reject });
    pumpProxyQueue();
  });
}

function pumpProxyQueue() {
  while (figmaProxyActive < figmaProxyMaxConcurrency && figmaProxyQueue.length) {
    const item = figmaProxyQueue.shift();
    figmaProxyActive++;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        figmaProxyActive--;
        pumpProxyQueue();
      });
  }
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function proxyFetchAsset(url) {
  await loadProxySession();

  const fromMemory = figmaProxyMemCache.get(url);
  if (fromMemory) {
    pushDiag({ url, phase: "proxy-cache-memory", ok: true, status: 200 });
    return { ok: true, status: 200, cacheHit: "memory", ...fromMemory };
  }

  const fromSession = figmaProxySessionCache[url];
  if (fromSession) {
    figmaProxyMemCache.set(url, fromSession);
    pushDiag({ url, phase: "proxy-cache-session", ok: true, status: 200 });
    return { ok: true, status: 200, cacheHit: "session", ...fromSession };
  }

  if (figmaProxyInFlight.has(url)) {
    return figmaProxyInFlight.get(url);
  }

  const promise = enqueueProxyTask(async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FIGMA_CAPTURE_FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          credentials: "omit",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        pushDiag({
          url,
          phase: "proxy-fetch",
          ok: false,
          status: response.status,
          error: `HTTP_${response.status}`,
        });
        return { ok: false, status: response.status, error: `HTTP_${response.status}` };
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const base64 = toBase64(await response.arrayBuffer());
      const payload = { contentType, base64 };
      figmaProxyMemCache.set(url, payload);
      figmaProxySessionCache[url] = payload;
      persistProxySession();
      pushDiag({
        url,
        phase: "proxy-fetch",
        ok: true,
        status: response.status,
        bytes: base64.length,
      });

      return {
        ok: true,
        status: response.status,
        contentType,
        base64,
        cacheHit: "miss",
      };
    } catch (error) {
      const message = String(error);
      pushDiag({ url, phase: "proxy-fetch", ok: false, status: 0, error: message });
      return { ok: false, status: 0, error: message };
    }
  }).finally(() => {
    figmaProxyInFlight.delete(url);
  });

  figmaProxyInFlight.set(url, promise);
  return promise;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await injectScriptFile(tab.id, TOOLBAR_FILE);
  } catch (error) {
    console.error("Toolbar inject failed:", error);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "FIGMA_CAPTURE_START") return;
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab?.id) {
        throw new Error("No active tab to capture");
      }
      const result = await runCapture(tab.id);
      if (!result) {
        throw new Error("Capture returned empty result");
      }
      await saveResult(result);
      sendResponse({ ok: true });
    } catch (error) {
      if (!isTransientCaptureError(error)) {
        console.error("Capture failed:", error);
      }
      sendResponse({ ok: false, error: String(error) });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "FIGMA_CAPTURE_FETCH_ASSET" || !msg.url) return;
  (async () => {
    const result = await proxyFetchAsset(msg.url);
    sendResponse({
      ...result,
      diagnostics: {
        phase: "proxy",
        cacheHit: result.cacheHit || null,
        queueDepth: figmaProxyQueue.length,
        activeRequests: figmaProxyActive,
        maxConcurrency: concurrencyLabel(),
      },
    });
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "FIGMA_CAPTURE_GET_DIAGNOSTICS") return;
  (async () => {
    await loadProxySession();
    sendResponse({
      ok: true,
      diagnostics: {
        generatedAt: new Date().toISOString(),
        queueDepth: figmaProxyQueue.length,
        activeRequests: figmaProxyActive,
        inFlight: figmaProxyInFlight.size,
        maxConcurrency: concurrencyLabel(),
        failures: figmaProxyDiagnostics.filter((x) => x && x.ok === false),
      },
    });
  })();
  return true;
});

loadConcurrencyConfig();
