// Open a local HTML page in a Playwright CLI session with this extension loaded,
// then run: playwright-cli run-code --filename tests/local-image-capture.js
async (page) => {
  const pageUrl = page.url();
  if (!pageUrl.startsWith("file:")) {
    throw new Error("Open the local HTML page before running this check.");
  }

  const worker = page.context().serviceWorkers().find((item) =>
    item.url().endsWith("/background.js")
  );
  if (!worker) throw new Error("The capture extension must be loaded.");

  const originalSources = await page.evaluate(() =>
    Array.from(document.images, (image) => image.getAttribute("src"))
  );
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, pageUrl);
  if (tabId == null) throw new Error("The local page tab was not found.");

  const [{ result }] = await worker.evaluate(async (id) => {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      world: "ISOLATED",
      func: () => {
        window.figma = {
          captureForDesign: async ({ selector }) => {
            const images = Array.from(document.querySelectorAll(`${selector} img`));
            return Promise.all(images.map(async (image) => {
              await image.decode();
              const result = {
                alt: image.alt,
                embedded: image.currentSrc.startsWith("data:image/"),
                size: [image.naturalWidth, image.naturalHeight],
              };
              try {
                const canvas = document.createElement("canvas");
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                const context = canvas.getContext("2d");
                context.drawImage(image, 0, 0);
                result.png = canvas.toDataURL("image/png").startsWith("data:image/png;");
                result.centerAlpha = context.getImageData(
                  Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1
                ).data[3];
                result.bytes = (await (await fetch(image.currentSrc)).blob()).size;
              } catch (error) {
                result.error = String(error);
              }
              return result;
            }));
          },
        };
      },
    });
    return chrome.scripting.executeScript({
      target: { tabId: id },
      world: "ISOLATED",
      files: ["runner.js"],
    });
  }, tabId);

  if (!result?.length || result.some((image) =>
    !image.embedded || !image.png || !image.centerAlpha || !image.bytes || image.error
  )) {
    throw new Error(`Local images were not embedded: ${JSON.stringify(result)}`);
  }
  const restored = await page.evaluate(() => ({
    stageRemoved: !document.getElementById("figma-capture-stage"),
    sources: Array.from(document.images, (image) => image.getAttribute("src")),
  }));
  if (!restored.stageRemoved) throw new Error("The capture stage was not removed.");
  if (JSON.stringify(restored.sources) !== JSON.stringify(originalSources)) {
    throw new Error("The page image sources were not restored after capture.");
  }
  return { images: result, restored };
}
