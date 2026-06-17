const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  page.on('response', async (res) => {
    if (res.url().includes('inberlinwohnen')) {
      console.log('URL:', res.url());
      console.log('STATUS:', res.status());
      console.log('HEADERS:', JSON.stringify(res.headers(), null, 2));
    }
  });

  page.on('download', async (download) => {
    console.log('DOWNLOAD DETECTED');
    console.log('SUGGESTED FILENAME:', download.suggestedFilename());
  });

  try {
    await page.goto(
      'https://www.inberlinwohnen.de/login/',
      {
        waitUntil: 'commit',
        timeout: 30000
      }
    );

    console.log('GOTO FINISHED');
  } catch (e) {
    console.log('ERROR:', e.message);
  }

  await browser.close();
})();
