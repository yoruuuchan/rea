import { afterEach } from "vitest";

import type { FakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

const browsers: FakeCdpBrowser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

export const trackBrowser = (browser: FakeCdpBrowser): void => {
  browsers.push(browser);
};

export const waitFor = async (ready: () => boolean, description: string) => {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(description);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
