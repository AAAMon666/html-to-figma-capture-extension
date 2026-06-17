(async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const CAPTURE_STAGE_ID = "figma-capture-stage";
  const EXTENSION_AVATAR_PATH = "assets/anan.png";
  const IGNORE_SELECTOR = "[data-figma-capture-ignore]";

  if (!window.figma?.captureForDesign) {
    throw new Error(
      "window.figma.captureForDesign is not available. capture.js may not have loaded."
    );
  }

  const cleanupTasks = [];

  try {
    await warmUpPage();

    const restoreImages = await inlineLoadedImages();
    if (restoreImages) cleanupTasks.push(restoreImages);
    const restoreBackgroundImages = await inlineBackgroundImages();
    if (restoreBackgroundImages) cleanupTasks.push(restoreBackgroundImages);

    const stage = shouldUseMobileStage()
      ? buildMobileCaptureStage()
      : buildGenericCaptureStage();
    cleanupTasks.push(() => stage.remove());

    inlineMaterialSymbols(stage);
    await waitForStageAssets(stage);

    await delay(250);
    return await window.figma.captureForDesign({ selector: `#${CAPTURE_STAGE_ID}` });
  } finally {
    while (cleanupTasks.length) {
      try {
        cleanupTasks.pop()?.();
      } catch {
        // Capture cleanup should never block the result.
      }
    }
  }

  async function warmUpPage() {
    window.scrollTo(0, 0);

    const images = Array.from(document.images || []);
    await Promise.allSettled(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
              setTimeout(resolve, 10000);
            })
      )
    );

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, delay(3000)]);
    }

    await delay(500);
  }

  async function inlineLoadedImages() {
    const changed = [];

    for (const img of Array.from(document.images || [])) {
      if (isIgnoredForCapture(img)) {
        continue;
      }

      const original = img.getAttribute("src");
      if (!original || original.startsWith("data:")) {
        continue;
      }

      const dataUrl = await imageToDataUrl(img);
      if (!dataUrl) {
        continue;
      }

      img.setAttribute("src", dataUrl);
      changed.push({ img, original });
    }

    if (changed.length === 0) {
      return null;
    }

    return () => {
      for (const item of changed) {
        item.img.setAttribute("src", item.original);
      }
    };
  }

  async function imageToDataUrl(img) {
    try {
      await img.decode?.();
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        return imageElementToDataUrl(img);
      }
    } catch {
      // Fetch fallback below.
    }

    try {
      const response = await fetch(img.currentSrc || img.src);
      if (!response.ok) return null;
      const blob = await response.blob();
      return await blobToDataUrl(blob);
    } catch {
      return await extensionAvatarDataUrl(img);
    }
  }

  async function inlineBackgroundImages() {
    const changed = [];

    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (isIgnoredForCapture(element)) {
        continue;
      }

      const inline = element.style?.backgroundImage || "";
      const computed = getComputedStyle(element).backgroundImage || "";
      const backgroundImage = inline && inline !== "none" ? inline : computed;
      const urls = extractCssUrls(backgroundImage);
      if (!urls.length) continue;

      let next = backgroundImage;
      for (const url of urls) {
        if (!url || url.startsWith("data:")) continue;
        const dataUrl = await urlToDataUrl(url, element);
        if (dataUrl) {
          next = next.replace(url, dataUrl);
        }
      }

      if (next !== backgroundImage) {
        changed.push({ element, original: element.style.backgroundImage });
        element.style.backgroundImage = next;
      }
    }

    if (changed.length === 0) return null;

    return () => {
      for (const item of changed) {
        item.element.style.backgroundImage = item.original;
      }
    };
  }

  function extractCssUrls(value) {
    return Array.from(value.matchAll(/url\((?:"([^"]+)"|'([^']+)'|([^)]*?))\)/g), (match) =>
      (match[1] || match[2] || match[3] || "").trim()
    );
  }

  async function urlToDataUrl(url, element) {
    try {
      const response = await fetch(new URL(url, location.href).href);
      if (!response.ok) return null;
      return await blobToDataUrl(await response.blob());
    } catch {
      return await extensionAvatarDataUrl({
        getAttribute: () => url,
        alt: "",
        dataset: element?.dataset || {},
      });
    }
  }

  function imageElementToDataUrl(img) {
    const maxSize = img.matches("header img, img[src*='anan']")
      ? 256
      : Math.max(img.naturalWidth, img.naturalHeight);
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  async function extensionAvatarDataUrl(img) {
    const marker = `${img.getAttribute("src") || ""} ${img.alt || ""} ${img.dataset?.alt || ""}`;
    if (!/anan|安安|安心伴/.test(marker) || !chrome?.runtime?.getURL) {
      return null;
    }

    try {
      const response = await fetch(chrome.runtime.getURL(EXTENSION_AVATAR_PATH));
      if (!response.ok) return null;
      return await blobToDataUrl(await response.blob());
    } catch {
      return null;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function waitForStageAssets(stage) {
    await Promise.allSettled(
      Array.from(stage.querySelectorAll("img")).map((img) =>
        img.complete && img.naturalWidth > 0
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
              setTimeout(resolve, 3000);
            })
      )
    );

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, delay(1000)]);
    }
  }

  function shouldUseMobileStage() {
    const phoneRoot = findPhoneCaptureRoot();
    const bodyStyle = getComputedStyle(document.body);
    const bodyMaxWidth = parseFloat(bodyStyle.maxWidth);
    const hasPhoneWidth =
      (Number.isFinite(bodyMaxWidth) && bodyMaxWidth > 0 && bodyMaxWidth <= 430) ||
      /\bmax-w-\[390px\]\b/.test(document.body.className || "");
    const hasAppShell =
      !!document.querySelector("header") &&
      !!document.querySelector("main") &&
      !!document.querySelector(
        "nav.fixed, nav[class*='bottom-0'], footer.fixed, footer[class*='bottom-0'], div.fixed[class*='bottom-0'], div.absolute[class*='bottom-0']"
      );
    const isKnownPrototype =
      /demo_stitch_ai\/pages|stitch_duplicate_of_ai-|10_appointment_list\.html/i.test(location.href);

    return !!phoneRoot || (hasPhoneWidth && hasAppShell) || isKnownPrototype;
  }

  function findPhoneCaptureRoot() {
    const candidates = [
      document.body,
      ...Array.from(document.body.children),
      ...Array.from(document.querySelectorAll("main")),
    ].filter(
      (element, index, list) =>
        element instanceof HTMLElement &&
        list.indexOf(element) === index &&
        !isIgnoredForCapture(element)
    );

    return (
      candidates.find((element) => isExplicitPhoneRoot(element)) ||
      candidates.find((element) => isCenteredWireframeRoot(element)) ||
      null
    );
  }

  function isExplicitPhoneRoot(element) {
    const className = element.className || "";
    const hasPhoneClass =
      /\bw-\[390px\]\b/.test(className) ||
      /\bmax-w-\[390px\]\b/.test(className) ||
      /\bmax-w-md\b/.test(className);
    if (!hasPhoneClass) return false;

    const rect = element.getBoundingClientRect();
    const width = Math.round(rect.width || element.scrollWidth || 0);
    const height = Math.round(rect.height || element.scrollHeight || 0);
    const hasScreenLikeHeight =
      height >= 520 ||
      /\bh-\[884px\]\b|\bmin-h-\[884px\]\b|\bmin-h-screen\b/.test(className);

    return width >= 320 && width <= 480 && hasScreenLikeHeight;
  }

  function isCenteredWireframeRoot(element) {
    const className = element.className || "";
    if (!/\bmax-w-md\b|\bw-full\b/.test(className)) return false;
    if (!isWireframePrototypeDocument()) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const bodyClass = document.body.className || "";
    const bodyCentersContent = /\bitems-center\b|\bjustify-center\b/.test(bodyClass);
    const selfCentersContent = /\bmx-auto\b/.test(className);
    const width = Math.round(rect.width || element.scrollWidth || 0);

    return (
      element.tagName === "MAIN" &&
      width >= 320 &&
      width <= 480 &&
      (bodyCentersContent || selfCentersContent) &&
      (style.display === "flex" || /flex|space-y-/.test(className))
    );
  }

  function isWireframePrototypeDocument() {
    const marker = `${location.href} ${document.title} ${document.body.className || ""} ${document.body.innerHTML.slice(0, 3000)}`;
    return /wireframe|wireframe-|wireframe_|wireframe-border|wireframe-box|wireframe-placeholder|stitch_duplicate_of_ai-|绾挎|线框|線框/i.test(marker);
  }

  function buildGenericCaptureStage() {
    document.getElementById(CAPTURE_STAGE_ID)?.remove();

    const stage = document.createElement("div");
    const sourceBodyStyle = getComputedStyle(document.body);
    const sourceHtmlStyle = getComputedStyle(document.documentElement);
    const width = getGenericCaptureWidth();
    const height = getGenericCaptureHeight();

    stage.id = CAPTURE_STAGE_ID;
    stage.style.position = "absolute";
    stage.style.left = "0";
    stage.style.top = "0";
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.minHeight = `${height}px`;
    stage.style.margin = "0";
    stage.style.overflow = "hidden";
    stage.style.backgroundColor = firstOpaqueColor(
      sourceBodyStyle.backgroundColor,
      sourceHtmlStyle.backgroundColor,
      "#ffffff"
    );
    stage.style.color = sourceBodyStyle.color;
    stage.style.font = sourceBodyStyle.font;
    stage.style.zIndex = "2147483000";
    stage.style.pointerEvents = "none";
    stage.style.boxSizing = "border-box";
    stage.style.padding = "0";
    stage.style.transform = "none";

    const bodyClone = cloneElementForStage(document.body);
    bodyClone.removeAttribute("id");
    bodyClone.style.position = "relative";
    bodyClone.style.left = "0";
    bodyClone.style.top = "0";
    bodyClone.style.width = `${width}px`;
    bodyClone.style.minWidth = `${width}px`;
    bodyClone.style.minHeight = `${height}px`;
    bodyClone.style.margin = sourceBodyStyle.margin || "0";
    bodyClone.style.overflow = "visible";
    bodyClone.style.transform = "none";
    stage.appendChild(bodyClone);

    document.body.appendChild(stage);
    return stage;
  }

  function cloneElementForStage(source) {
    const clone = source.cloneNode(false);

    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (
          child.id === CAPTURE_STAGE_ID ||
          child.tagName === "SCRIPT" ||
          isIgnoredForCapture(child)
        ) {
          continue;
        }
        clone.appendChild(cloneElementForStage(child));
      } else {
        clone.appendChild(child.cloneNode(true));
      }
    }

    if (source instanceof HTMLElement) {
      const style = getComputedStyle(source);
      if (style.position === "fixed") {
        const rect = source.getBoundingClientRect();
        clone.style.position = "absolute";
        clone.style.left = `${Math.round(rect.left)}px`;
        clone.style.top = `${Math.round(rect.top)}px`;
        clone.style.right = "auto";
        clone.style.bottom = "auto";
        clone.style.width = `${Math.round(rect.width)}px`;
        clone.style.height = `${Math.round(rect.height)}px`;
        clone.style.transform = style.transform === "none" ? "none" : style.transform;
      }
    }

    return clone;
  }

  function getGenericCaptureWidth() {
    return Math.round(
      Math.max(
        window.innerWidth || 0,
        document.documentElement.clientWidth || 0,
        document.documentElement.scrollWidth || 0,
        document.body.scrollWidth || 0,
        1
      )
    );
  }

  function getGenericCaptureHeight() {
    return Math.round(
      Math.max(
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0,
        1
      )
    );
  }

  function firstOpaqueColor(...colors) {
    return colors.find((color) => color && color !== "rgba(0, 0, 0, 0)") || "#ffffff";
  }

  function buildMobileCaptureStage() {
    document.getElementById(CAPTURE_STAGE_ID)?.remove();

    const stage = document.createElement("div");
    const sourceBodyStyle = getComputedStyle(document.body);
    const width = getCaptureWidth();
    const height = getCaptureHeight(width);

    stage.id = CAPTURE_STAGE_ID;
    stage.style.position = "absolute";
    stage.style.left = "0";
    stage.style.top = "0";
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.minHeight = `${height}px`;
    stage.style.margin = "0";
    stage.style.overflow = "hidden";
    stage.style.backgroundColor =
      sourceBodyStyle.backgroundColor === "rgba(0, 0, 0, 0)"
        ? "#f9faf5"
        : sourceBodyStyle.backgroundColor;
    stage.style.color = sourceBodyStyle.color;
    stage.style.zIndex = "2147483000";
    stage.style.pointerEvents = "none";
    stage.style.boxSizing = "border-box";
    stage.style.padding = "0";
    stage.style.transform = "none";

    const header = document.querySelector("header");
    const main = document.querySelector("main");
    const fab = findFloatingActionButton();
    const nav = document.querySelector("nav.fixed, nav");
    const footer = findBottomBar(nav);
    const actionBar = findBodyActionBar([header, main, nav, footer]);
    const mainBottom = main ? getElementContentBottom(main) : 0;

    for (const decoration of findBodyDecorations()) {
      const clone = decoration.cloneNode(true);
      clone.style.position = "absolute";
      clone.style.inset = "0";
      clone.style.width = "100%";
      clone.style.height = "100%";
      clone.style.zIndex = "0";
      clone.style.pointerEvents = "none";
      stage.appendChild(clone);
    }

    if (header) {
      const clone = header.cloneNode(true);
      clone.style.position = "absolute";
      clone.style.top = "0";
      clone.style.left = "0";
      clone.style.right = "0";
      clone.style.bottom = "auto";
      clone.style.width = "100%";
      clone.style.maxWidth = `${width}px`;
      clone.style.zIndex = "50";
      stage.appendChild(clone);
    }

    if (main) {
      const clone = main.cloneNode(true);
      const headerHeight = header ? Math.round(header.getBoundingClientRect().height) : 0;
      clone.style.position = "absolute";
      clone.style.left = "0";
      clone.style.right = "0";
      clone.style.top = `${headerHeight}px`;
      clone.style.bottom = "auto";
      clone.style.width = "100%";
      clone.style.maxWidth = `${width}px`;
      clone.style.minHeight = `${Math.max(1, getMainCloneHeight(main, headerHeight, mainBottom))}px`;
      clone.style.marginTop = clone.style.marginTop || "";
      clone.style.overflow = "visible";
      clone.style.zIndex = "10";
      stage.appendChild(clone);
    } else {
      for (const child of Array.from(document.body.children)) {
        if (
          child.id === CAPTURE_STAGE_ID ||
          child.tagName === "SCRIPT" ||
          isIgnoredForCapture(child)
        ) {
          continue;
        }
        stage.appendChild(child.cloneNode(true));
      }
    }

    if (fab) {
      const clone = cloneFixedViewportElement(fab);
      stage.appendChild(clone);
    }

    if (nav) {
      const clone = cloneFixedBottomElement(nav, width, height);
      clone.style.maxWidth = `${width}px`;
      stage.appendChild(clone);
    }

    if (footer && footer !== nav) {
      const top = shouldAppendBottomBarAfterContent(footer, mainBottom)
        ? Math.max(mainBottom + 16, 0)
        : null;
      const clone = cloneFixedBottomElement(footer, width, height, top);
      clone.style.maxWidth = `${width}px`;
      stage.appendChild(clone);
    }

    if (actionBar && actionBar !== footer && actionBar !== nav) {
      const clone = cloneFixedBottomElement(actionBar, width, height);
      clone.style.maxWidth = `${width}px`;
      stage.appendChild(clone);
    }

    document.body.appendChild(stage);
    return stage;
  }

  function isIgnoredForCapture(element) {
    return element instanceof Element && !!element.closest(IGNORE_SELECTOR);
  }

  function getMainCloneHeight(main, headerHeight, mainBottom) {
    const phoneRoot = findPhoneCaptureRoot();
    const explicitPhoneHeight = getExplicitPhoneRootHeight(phoneRoot);
    const rectHeight = Math.round(main.getBoundingClientRect().height || 0);
    const scrollHeight = Math.round(main.scrollHeight || 0);

    if (explicitPhoneHeight || isWireframePrototypeDocument()) {
      return Math.max(1, rectHeight, Math.min(scrollHeight, explicitPhoneHeight || 884));
    }

    return mainBottom - headerHeight;
  }

  function cloneFixedViewportElement(element) {
    const clone = element.cloneNode(true);
    const rect = element.getBoundingClientRect();
    clone.style.position = "absolute";
    clone.style.left = `${Math.max(0, Math.round(rect.left))}px`;
    clone.style.top = `${Math.max(0, Math.round(rect.top))}px`;
    clone.style.right = "auto";
    clone.style.bottom = "auto";
    clone.style.width = `${Math.round(rect.width)}px`;
    clone.style.height = `${Math.round(rect.height)}px`;
    clone.style.margin = "0";
    return clone;
  }

  function findBodyDecorations() {
    return Array.from(document.body.children).filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (isIgnoredForCapture(element)) return false;
      if (element.id === CAPTURE_STAGE_ID || element.tagName === "SCRIPT") return false;
      if (element.matches("header, main, nav, footer")) return false;
      if (element.querySelector("button, input, textarea, select, a")) return false;
      const style = getComputedStyle(element);
      const isDecoration =
        element.getAttribute("aria-hidden") === "true" ||
        style.pointerEvents === "none";
      const coversStage =
        style.position === "absolute" &&
        (style.inset === "0px" || (style.top === "0px" && style.left === "0px"));
      return isDecoration && coversStage;
    });
  }

  function findBottomBar(exclude) {
    const candidates = Array.from(
      document.querySelectorAll(
        "footer.fixed, footer[class*='bottom-0'], div.fixed[class*='bottom-0'], div.absolute[class*='bottom-0']"
      )
    ).filter((element) => element !== exclude && !isIgnoredForCapture(element));
    const viewportHeight = window.innerHeight || 884;

    return (
      candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const hasButton = !!element.querySelector("button");
        const nearBottom = rect.bottom >= viewportHeight - 24 || /bottom-0/.test(element.className || "");
        const wideEnough = rect.width >= 240;
        const positionedToViewport = style.position === "fixed" || element.parentElement === document.body;
        return hasButton && nearBottom && wideEnough && positionedToViewport;
      }) || null
    );
  }

  function findBodyActionBar(excludes = []) {
    const excluded = new Set(excludes.filter(Boolean));
    const main = document.querySelector("main");

    return (
      Array.from(document.body.children)
        .filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          if (isIgnoredForCapture(element)) return false;
          if (excluded.has(element)) return false;
          if (element.id === CAPTURE_STAGE_ID || element.tagName === "SCRIPT") return false;
          if (element.matches("header, main, nav, footer")) return false;
          if (!element.querySelector("button")) return false;

          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const afterMain =
            main &&
            Array.from(document.body.children).indexOf(element) >
              Array.from(document.body.children).indexOf(main);
          const bottomish =
            rect.bottom >= (window.innerHeight || 884) - 220 ||
            /bottom-0|pb-|pt-|px-|w-full/.test(element.className || "");

          return (
            rect.width >= 240 &&
            rect.height >= 48 &&
            rect.height <= 180 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            (afterMain || bottomish)
          );
        })
        .pop() || null
    );
  }

  function cloneFixedBottomElement(element, width, stageHeight, top = null) {
    const clone = element.cloneNode(true);
    const rect = element.getBoundingClientRect();
    const height = Math.max(1, Math.round(rect.height || element.offsetHeight || 96));
    const bodyBackground = firstOpaqueColor(
      getComputedStyle(document.body).backgroundColor,
      "#f9faf5"
    );
    clone.style.position = "absolute";
    clone.style.left = "0";
    clone.style.right = "auto";
    clone.style.top = top == null ? "auto" : `${Math.round(top)}px`;
    clone.style.bottom = top == null ? "0" : "auto";
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    clone.style.margin = "0";
    clone.style.zIndex = "2147483001";
    clone.style.transform = "none";
    if (/\bbg-gradient-to-t\b/.test(element.className || "")) {
      clone.style.backgroundImage = "none";
      clone.style.backgroundColor = bodyBackground;
    }
    return clone;
  }

  function shouldAppendBottomBarAfterContent(element, contentBottom) {
    const rect = element.getBoundingClientRect();
    const overlapsContent = contentBottom > rect.top + window.scrollY;
    return getComputedStyle(element).position === "fixed" && overlapsContent;
  }

  function getCaptureWidth() {
    const phoneRoot = findPhoneCaptureRoot();
    if (phoneRoot) {
      const className = phoneRoot.className || "";
      const rectWidth = Math.round(phoneRoot.getBoundingClientRect().width || 0);
      if (/\bw-\[390px\]\b|\bmax-w-\[390px\]\b/.test(className)) {
        return 390;
      }
      if (rectWidth >= 320 && rectWidth <= 430) {
        return rectWidth;
      }
      if (/\bmax-w-md\b/.test(className)) {
        return 390;
      }
    }

    const bodyWidth = parseFloat(getComputedStyle(document.body).maxWidth);
    if (Number.isFinite(bodyWidth) && bodyWidth > 0 && bodyWidth < 800) {
      return Math.round(bodyWidth);
    }
    return 390;
  }

  function getCaptureHeight(width) {
    const phoneRoot = findPhoneCaptureRoot();
    const viewportHeight = Math.round(window.innerHeight || 0);
    const explicitBodyHeight = parseFloat(getComputedStyle(document.body).height);
    const scrollHeight = Math.round(
      Math.max(
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0
      )
    );
    const phoneHeight = Math.round(width * (884 / 390));
    const contentBottom = getVisibleContentBottom();
    const bottomBar = findBottomBar(document.querySelector("nav.fixed, nav"));
    const bottomBarHeight = bottomBar
      ? Math.max(0, Math.round(bottomBar.getBoundingClientRect().height))
      : 0;
    const hasFixedBottomBar = !!document.querySelector(
      "nav.fixed, footer.fixed, div.fixed[class*='bottom-0']"
    );
    const contentHeight = Math.max(scrollHeight, contentBottom + bottomBarHeight + 16);
    const explicitPhoneHeight = getExplicitPhoneRootHeight(phoneRoot);

    if (phoneRoot && isCenteredWireframeRoot(phoneRoot) && contentHeight <= 1100) {
      return 884;
    }

    if (explicitPhoneHeight && (isWireframePrototypeDocument() || !hasFixedBottomBar)) {
      return explicitPhoneHeight;
    }

    if (phoneRoot && isWireframePrototypeDocument() && contentHeight <= 1100) {
      return 884;
    }

    if (
      Number.isFinite(explicitBodyHeight) &&
      explicitBodyHeight > 0 &&
      explicitBodyHeight <= 1100 &&
      !hasFixedBottomBar &&
      contentHeight <= explicitBodyHeight + 24
    ) {
      return Math.round(explicitBodyHeight);
    }

    return Math.max(844, viewportHeight, phoneHeight, contentHeight);
  }

  function getExplicitPhoneRootHeight(root) {
    if (!(root instanceof HTMLElement)) return 0;

    const className = root.className || "";
    if (/\bh-\[884px\]\b|\bmin-h-\[884px\]\b/.test(className)) {
      return 884;
    }

    const rectHeight = Math.round(root.getBoundingClientRect().height || 0);
    const scrollHeight = Math.round(root.scrollHeight || 0);
    if (root !== document.body && rectHeight >= 640 && rectHeight <= 1200) {
      return Math.max(rectHeight, scrollHeight);
    }

    return 0;
  }

  function getVisibleContentBottom() {
    let bottom = 0;
    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      if (isIgnoredForCapture(element)) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      bottom = Math.max(bottom, rect.bottom + window.scrollY);
    }
    return Math.round(bottom);
  }

  function getElementContentBottom(root) {
    let bottom = root.getBoundingClientRect().bottom + window.scrollY;
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (isIgnoredForCapture(element)) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      bottom = Math.max(bottom, rect.bottom + window.scrollY);
    }
    return Math.round(bottom);
  }

  function findFloatingActionButton() {
    const fixedButtons = Array.from(document.querySelectorAll("button.fixed")).filter(
      (button) => !isIgnoredForCapture(button)
    );
    return (
      fixedButtons.find((button) =>
        (button.textContent || "").trim() === "add" ||
        button.querySelector(".material-symbols-outlined")
      ) || null
    );
  }

  function inlineMaterialSymbols(scope) {
    const iconMap = {
      notifications: bellSvg,
      notifications_active: bellSvg,
      alarm: clockSvg,
      alarm_add: clockSvg,
      today: calendarSvg,
      event: calendarSvg,
      event_available: calendarSvg,
      arrow_back_ios_new: chevronLeftSvg,
      arrow_back_ios: chevronLeftSvg,
      chevron_left: chevronLeftSvg,
      expand_more: chevronDownSvg,
      keyboard_arrow_down: chevronDownSvg,
      local_hospital: hospitalSvg,
      location_on: mapPinSvg,
      ophthalmology: ophthalmologySvg,
      stethoscope: stethoscopeSvg,
      schedule: clockSvg,
      calendar_today: calendarSvg,
      calendar_clock: calendarClockSvg,
      chevron_right: chevronRightSvg,
      close: closeSvg,
      check: checkSvg,
      check_circle: checkCircleSvg,
      task_alt: checkCircleSvg,
      verified: checkCircleSvg,
      add: plusSvg,
      info: infoSvg,
      home: homeSvg,
      medication: medicationSvg,
      pill: medicationSvg,
      vaccines: medicationSvg,
      event_repeat: eventRepeatSvg,
      family_restroom: familySvg,
      document_scanner: scannerSvg,
      photo_camera: cameraSvg,
      photo_library: cameraSvg,
      flash_on: lightningSvg,
      emergency: warningSvg,
      warning: warningSvg,
      mic: micSvg,
      record_voice_over: micSvg,
      phone_in_talk: phoneSvg,
      call: phoneSvg,
      smartphone: phoneSvg,
      person_add: personAddSvg,
      share: shareSvg,
      star: starSvg,
      visibility: eyeSvg,
      thumb_up: thumbUpSvg,
      bar_chart: barChartSvg,
      face: faceSvg,
      psychology: sparkleSvg,
      robot_2: sparkleSvg,
      magic_button: sparkleSvg,
      restaurant: utensilsSvg,
      scale: scaleSvg,
      vital_signs: chartLineSvg,
      wb_sunny: sunSvg,
      contrast: contrastSvg,
      blur_off: slashCircleSvg,
      format_size: textSizeSvg,
      keyboard: keyboardSvg,
    };

    for (const element of scope.querySelectorAll(".material-symbols-outlined")) {
      const name = (element.textContent || "").trim();
      const createSvg = iconMap[name] || fallbackIconSvg;

      const style = getComputedStyle(element);
      const size = parseFloat(style.fontSize) || 24;
      const color = style.color || "currentColor";
      const svg = createSvg(size, color);

      element.replaceChildren(svg);
      element.style.display = "inline-flex";
      element.style.alignItems = "center";
      element.style.justifyContent = "center";
      element.style.width = `${size}px`;
      element.style.height = `${size}px`;
      element.style.lineHeight = "0";
      element.style.fontSize = "0";
      element.style.flexShrink = "0";
    }
  }

  function iconSvg(size, color, paths, options = {}) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", options.fill || "none");
    svg.setAttribute("stroke", color);
    svg.setAttribute("stroke-width", options.strokeWidth || "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.display = "block";

    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }

    return svg;
  }

  function filledSvg(size, color, paths) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", color);
    svg.style.display = "block";

    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }

    return svg;
  }

  function bellSvg(size, color) {
    return iconSvg(size, color, [
      "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9",
      "M13.73 21a2 2 0 0 1-3.46 0",
    ]);
  }

  function chevronDownSvg(size, color) {
    return iconSvg(size, color, ["m6 9 6 6 6-6"]);
  }

  function chevronRightSvg(size, color) {
    return iconSvg(size, color, ["m9 18 6-6-6-6"]);
  }

  function chevronLeftSvg(size, color) {
    return iconSvg(size, color, ["m15 18-6-6 6-6"]);
  }

  function hospitalSvg(size, color) {
    return filledSvg(size, color, [
      "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm5 4v3H7v4h3v3h4v-3h3v-4h-3V7h-4Z",
    ]);
  }

  function mapPinSvg(size, color) {
    return iconSvg(size, color, [
      "M12 21s7-4.5 7-11a7 7 0 1 0-14 0c0 6.5 7 11 7 11Z",
      "M12 10a2 2 0 1 1 0 .01",
    ]);
  }

  function ophthalmologySvg(size, color) {
    return iconSvg(size, color, [
      "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z",
      "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
    ]);
  }

  function stethoscopeSvg(size, color) {
    return iconSvg(size, color, [
      "M6 3v5a4 4 0 0 0 8 0V3",
      "M4 3h3",
      "M13 3h3",
      "M10 12v3a4 4 0 0 0 8 0v-1",
      "M18 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    ]);
  }

  function clockSvg(size, color) {
    return iconSvg(size, color, ["M12 6v6l4 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"]);
  }

  function calendarSvg(size, color) {
    return iconSvg(size, color, [
      "M8 2v4",
      "M16 2v4",
      "M3 10h18",
      "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
    ]);
  }

  function calendarClockSvg(size, color) {
    return iconSvg(size, color, [
      "M8 2v4",
      "M16 2v4",
      "M3 10h18",
      "M5 4h14a2 2 0 0 1 2 2v8",
      "M5 4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8",
      "M18 17v3l2 1",
      "M22 19a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    ]);
  }

  function checkSvg(size, color) {
    return iconSvg(size, color, ["m5 12 5 5L20 7"], { strokeWidth: 3 });
  }

  function checkCircleSvg(size, color) {
    return iconSvg(size, color, ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z", "m7 12 3 3 7-7"]);
  }

  function closeSvg(size, color) {
    return iconSvg(size, color, ["M6 6l12 12", "M18 6 6 18"]);
  }

  function infoSvg(size, color) {
    return iconSvg(size, color, ["M12 17v-6", "M12 7h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"]);
  }

  function plusSvg(size, color) {
    return iconSvg(size, color, ["M12 5v14", "M5 12h14"], { strokeWidth: 3 });
  }

  function homeSvg(size, color) {
    return iconSvg(size, color, ["M3 11 12 3l9 8", "M5 10v10h14V10", "M9 20v-6h6v6"]);
  }

  function medicationSvg(size, color) {
    return iconSvg(size, color, [
      "M9 3h6",
      "M10 3v4",
      "M14 3v4",
      "M7 7h10v14H7V7Z",
      "M12 11v6",
      "M9 14h6",
    ]);
  }

  function eventRepeatSvg(size, color) {
    return iconSvg(size, color, [
      "M8 2v4",
      "M16 2v4",
      "M4 10h16",
      "M5 4h14a1 1 0 0 1 1 1v7",
      "M4 18V5a1 1 0 0 1 1-1",
      "M17 15h3v3",
      "M20 15a5 5 0 1 0 1 4",
    ]);
  }

  function familySvg(size, color) {
    return iconSvg(size, color, [
      "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
      "M17 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
      "M3 21v-2a5 5 0 0 1 10 0v2",
      "M14 21v-1.5a4 4 0 0 1 7 0V21",
    ]);
  }

  function scannerSvg(size, color) {
    return iconSvg(size, color, [
      "M7 3H5a2 2 0 0 0-2 2v2",
      "M17 3h2a2 2 0 0 1 2 2v2",
      "M7 21H5a2 2 0 0 1-2-2v-2",
      "M17 21h2a2 2 0 0 0 2-2v-2",
      "M7 8h10",
      "M7 12h10",
      "M7 16h6",
    ]);
  }

  function cameraSvg(size, color) {
    return iconSvg(size, color, [
      "M4 7h4l2-3h4l2 3h4a2 2 0 0 1 2 2v11H2V9a2 2 0 0 1 2-2Z",
      "M12 10a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z",
    ]);
  }

  function lightningSvg(size, color) {
    return filledSvg(size, color, ["M13 2 4 14h7l-1 8 9-12h-7l1-8Z"]);
  }

  function warningSvg(size, color) {
    return iconSvg(size, color, [
      "M12 3 2 21h20L12 3Z",
      "M12 9v5",
      "M12 17h.01",
    ]);
  }

  function micSvg(size, color) {
    return iconSvg(size, color, [
      "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z",
      "M5 10v2a7 7 0 0 0 14 0v-2",
      "M12 19v3",
    ]);
  }

  function phoneSvg(size, color) {
    return iconSvg(size, color, [
      "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z",
    ]);
  }

  function personAddSvg(size, color) {
    return iconSvg(size, color, [
      "M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
      "M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
      "M19 8v6",
      "M16 11h6",
    ]);
  }

  function shareSvg(size, color) {
    return iconSvg(size, color, [
      "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
      "M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
      "M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
      "m8.6 13.5 5.8 3",
      "m14.4 6.5-5.8 3",
    ]);
  }

  function starSvg(size, color) {
    return filledSvg(size, color, ["m12 2 3.1 6.3 7 .9-5.1 4.9 1.3 6.9L12 17.6 5.7 21l1.3-6.9L1.9 9.2l7-.9L12 2Z"]);
  }

  function eyeSvg(size, color) {
    return iconSvg(size, color, [
      "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z",
      "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
    ]);
  }

  function thumbUpSvg(size, color) {
    return iconSvg(size, color, [
      "M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3",
      "M7 11l4-9 1 1a4 4 0 0 1 1 3v3h5a2 2 0 0 1 2 2l-1 7a4 4 0 0 1-4 4H7V11Z",
    ]);
  }

  function barChartSvg(size, color) {
    return iconSvg(size, color, ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"]);
  }

  function faceSvg(size, color) {
    return iconSvg(size, color, [
      "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
      "M8 10h.01",
      "M16 10h.01",
      "M8 15s1.5 2 4 2 4-2 4-2",
    ]);
  }

  function sparkleSvg(size, color) {
    return iconSvg(size, color, [
      "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z",
      "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
    ]);
  }

  function utensilsSvg(size, color) {
    return iconSvg(size, color, ["M7 2v20", "M4 2v6a3 3 0 0 0 6 0V2", "M17 2v20", "M17 2c3 2 4 5 4 8h-4"]);
  }

  function scaleSvg(size, color) {
    return iconSvg(size, color, ["M12 3v18", "M5 7h14", "M6 7l-4 7h8L6 7Z", "M18 7l-4 7h8l-4-7Z"]);
  }

  function chartLineSvg(size, color) {
    return iconSvg(size, color, ["M3 12h4l2-5 4 10 2-5h6"]);
  }

  function sunSvg(size, color) {
    return iconSvg(size, color, ["M12 4V2", "M12 22v-2", "M4.9 4.9 3.5 3.5", "M20.5 20.5l-1.4-1.4", "M4 12H2", "M22 12h-2", "M4.9 19.1l-1.4 1.4", "M20.5 3.5l-1.4 1.4", "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"]);
  }

  function contrastSvg(size, color) {
    return iconSvg(size, color, ["M12 2a10 10 0 0 0 0 20V2Z", "M12 2a10 10 0 0 1 0 20"]);
  }

  function slashCircleSvg(size, color) {
    return iconSvg(size, color, ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z", "M5 19 19 5"]);
  }

  function textSizeSvg(size, color) {
    return iconSvg(size, color, ["M4 6h10", "M9 6v12", "M15 10h5", "M17.5 10v8"]);
  }

  function keyboardSvg(size, color) {
    return iconSvg(size, color, ["M3 6h18v12H3V6Z", "M7 10h.01", "M11 10h.01", "M15 10h.01", "M19 10h.01", "M7 14h10"]);
  }

  function fallbackIconSvg(size, color) {
    return iconSvg(size, color, ["M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z", "M8 12h8"]);
  }
})();
