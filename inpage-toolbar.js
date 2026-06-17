(async () => {
  const TOOLBAR_ID = "__figma_capture_toolbar__";
  const STYLE_ID = "__figma_capture_toolbar_style__";
  const STORAGE_KEY = "enableAssetProxyFetch";
  const CONCURRENCY_KEY = "proxyFetchConcurrency";
  const DEFAULT_CONCURRENCY = "8";
  const ALLOWED_CONCURRENCY = new Set(["4", "6", "8", "10", "12", "16", "20", "infinite"]);

  function normalizeConcurrency(value) {
    const text = String(value ?? "");
    return ALLOWED_CONCURRENCY.has(text) ? text : DEFAULT_CONCURRENCY;
  }

  function removeToolbar() {
    document.getElementById(TOOLBAR_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.textContent = busy ? "采集中..." : "开始采集";
  }

  function setStatus(status, text, tone = "") {
    status.textContent = text || "";
    status.dataset.tone = tone;
  }

  function toggleConcurrencyRow(proxyToggle, row) {
    row.classList.toggle("hidden", !proxyToggle.checked);
  }

  function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function storageGet(defaults) {
    return new Promise((resolve) => {
      chrome.storage.local.get(defaults, resolve);
    });
  }

  function storageSet(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, resolve);
    });
  }

  removeToolbar();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${TOOLBAR_ID} {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 460px;
      z-index: 2147483647;
      border-radius: 16px;
      border: 1px solid rgba(148, 163, 184, 0.32);
      background: #f8fafc;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172033;
      overflow: hidden;
      box-sizing: border-box;
    }
    #${TOOLBAR_ID} * { box-sizing: border-box; }
    #${TOOLBAR_ID} .shell {
      display: grid;
      grid-template-columns: 138px minmax(0, 1fr);
      min-height: 254px;
    }
    #${TOOLBAR_ID} .brand {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 16px;
      background: #172033;
      color: #fff;
    }
    #${TOOLBAR_ID} .brand-copy {
      display: grid;
      gap: 8px;
    }
    #${TOOLBAR_ID} .brand-kicker {
      color: #8bd3ff;
      font-size: 11px;
      font-weight: 800;
      line-height: 1;
      text-transform: uppercase;
      white-space: nowrap;
    }
    #${TOOLBAR_ID} .brand-name {
      max-width: 100px;
      font-size: 21px;
      font-weight: 800;
      line-height: 1.18;
    }
    #${TOOLBAR_ID} .title-logo {
      width: 34px;
      height: 34px;
      display: block;
      border-radius: 10px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
    }
    #${TOOLBAR_ID} .content {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    #${TOOLBAR_ID} .close {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 28px;
      height: 28px;
      border: 0;
      background: transparent;
      cursor: pointer;
      color: #8a94a6;
      font-size: 22px;
      line-height: 1;
      border-radius: 8px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${TOOLBAR_ID} .close:hover { background: #edf2f7; color: #172033; }
    #${TOOLBAR_ID} .body {
      display: grid;
      gap: 10px;
      padding: 16px 16px 12px;
    }
    #${TOOLBAR_ID} .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 52px;
      padding: 12px;
      border: 1px solid #dde4ee;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 10px 24px rgba(23, 32, 51, 0.06);
      font-size: 14px;
      font-weight: 650;
    }
    #${TOOLBAR_ID} select {
      min-width: 82px;
      height: 34px;
      padding: 0 28px 0 12px;
      border-radius: 8px;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      color: #172033;
      font: inherit;
      cursor: pointer;
    }
    #${TOOLBAR_ID} .switch {
      position: relative;
      display: inline-flex;
      width: 46px;
      height: 26px;
      flex-shrink: 0;
    }
    #${TOOLBAR_ID} .switch input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    #${TOOLBAR_ID} .switch-slider {
      width: 100%;
      height: 100%;
      border-radius: 999px;
      background: #d8e0eb;
      transition: background 0.18s ease;
      position: relative;
    }
    #${TOOLBAR_ID} .switch-slider::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 2px 8px rgba(23, 32, 51, 0.28);
      transition: transform 0.18s ease;
    }
    #${TOOLBAR_ID} .switch input:checked + .switch-slider { background: #172033; }
    #${TOOLBAR_ID} .switch input:checked + .switch-slider::after { transform: translateX(20px); }
    #${TOOLBAR_ID} .hint {
      font-size: 12px;
      color: #657084;
      margin: 0;
      line-height: 1.55;
    }
    #${TOOLBAR_ID} .capture {
      width: 100%;
      border: 0;
      border-radius: 8px;
      background: #172033;
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      padding: 12px 14px;
      cursor: pointer;
      transition: transform 0.08s ease, box-shadow 0.2s ease, background 0.15s ease;
      box-shadow: 0 12px 24px rgba(23, 32, 51, 0.2);
    }
    #${TOOLBAR_ID} .capture:hover {
      background: #23304a;
      box-shadow: 0 14px 26px rgba(23, 32, 51, 0.24);
    }
    #${TOOLBAR_ID} .capture:active { transform: translateY(1px); }
    #${TOOLBAR_ID} .capture:disabled { opacity: 0.65; cursor: default; }
    #${TOOLBAR_ID} .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: auto;
      padding: 10px 16px 14px;
      background: #f8fafc;
    }
    #${TOOLBAR_ID} .credit {
      font-size: 12px;
      color: #657084;
      white-space: nowrap;
    }
    #${TOOLBAR_ID} .status {
      font-size: 12px;
      color: #657084;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    #${TOOLBAR_ID} .status[data-tone="error"] { color: #dc2626; }
    #${TOOLBAR_ID} .status[data-tone="success"] { color: #15803d; }
    #${TOOLBAR_ID} .hidden { display: none !important; }
  `;
  document.documentElement.appendChild(style);

  const toolbar = document.createElement("section");
  toolbar.id = TOOLBAR_ID;
  toolbar.setAttribute("data-figma-capture-ignore", "1");
  const logoUrl = chrome.runtime.getURL("logo/icon16.png");
  toolbar.innerHTML = `
    <div class="shell" data-figma-capture-ignore="1">
      <div class="brand" data-figma-capture-ignore="1">
        <img class="title-logo" src="${logoUrl}" alt="" data-figma-capture-ignore="1" />
        <div class="brand-copy" data-figma-capture-ignore="1">
          <span class="brand-kicker" data-figma-capture-ignore="1">HTML Capture</span>
          <span class="brand-name" data-figma-capture-ignore="1">HTML 转 Figma 助手</span>
        </div>
      </div>
      <div class="content" data-figma-capture-ignore="1">
        <button class="close" type="button" title="关闭" data-figma-capture-ignore="1">×</button>
        <div class="body" data-figma-capture-ignore="1">
          <label class="row" data-figma-capture-ignore="1">
            <span data-figma-capture-ignore="1">跨域图片代理模式</span>
            <span class="switch" data-figma-capture-ignore="1">
              <input id="figmaProxyToggle" type="checkbox" data-figma-capture-ignore="1" />
              <span class="switch-slider" data-figma-capture-ignore="1"></span>
            </span>
          </label>
          <label class="row" id="figmaConcurrencyRow" data-figma-capture-ignore="1">
            <span data-figma-capture-ignore="1">图片采集并发</span>
            <select id="figmaProxyConcurrency" data-figma-capture-ignore="1">
              <option value="4">4</option>
              <option value="6">6</option>
              <option value="8">8</option>
              <option value="10">10</option>
              <option value="12">12</option>
              <option value="16">16</option>
              <option value="20">20</option>
              <option value="infinite">无限</option>
            </select>
          </label>
          <p class="hint" data-figma-capture-ignore="1">开启后由插件拉取图片，可减少丢图，但采集会变慢。</p>
          <button class="capture" id="figmaCaptureBtn" type="button" data-figma-capture-ignore="1">开始采集</button>
        </div>
        <div class="footer" data-figma-capture-ignore="1">
          <span class="credit" data-figma-capture-ignore="1">开发者 Zhou_e</span>
          <span class="status" id="figmaCaptureStatus" data-figma-capture-ignore="1"></span>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(toolbar);

  const closeButton = toolbar.querySelector(".close");
  const proxyToggle = toolbar.querySelector("#figmaProxyToggle");
  const concurrency = toolbar.querySelector("#figmaProxyConcurrency");
  const concurrencyRow = toolbar.querySelector("#figmaConcurrencyRow");
  const captureButton = toolbar.querySelector("#figmaCaptureBtn");
  const status = toolbar.querySelector("#figmaCaptureStatus");

  closeButton.addEventListener("click", removeToolbar);

  const initial = await storageGet({
    [STORAGE_KEY]: false,
    [CONCURRENCY_KEY]: DEFAULT_CONCURRENCY,
  });
  proxyToggle.checked = Boolean(initial[STORAGE_KEY]);
  concurrency.value = normalizeConcurrency(initial[CONCURRENCY_KEY]);
  toggleConcurrencyRow(proxyToggle, concurrencyRow);

  proxyToggle.addEventListener("change", async () => {
    toggleConcurrencyRow(proxyToggle, concurrencyRow);
    await storageSet({ [STORAGE_KEY]: proxyToggle.checked });
  });

  concurrency.addEventListener("change", async () => {
    const value = normalizeConcurrency(concurrency.value);
    concurrency.value = value;
    await storageSet({ [CONCURRENCY_KEY]: value });
  });

  captureButton.addEventListener("click", async () => {
    setBusy(captureButton, true);
    setStatus(status, "");
    try {
      const response = await runtimeSendMessage({ type: "FIGMA_CAPTURE_START" });
      if (!response?.ok) {
        throw new Error(response?.error || "未知错误");
      }
      setStatus(status, "已触发下载", "success");
      setTimeout(removeToolbar, 600);
    } catch (error) {
      console.error("Capture failed:", error);
      setStatus(status, String(error.message || error), "error");
    } finally {
      setBusy(captureButton, false);
    }
  });
})();
