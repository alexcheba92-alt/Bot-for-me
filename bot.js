// Замени функцию main() на эту версию:
async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    ...devices['iPhone 13 Pro'],
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const responses = [];
  page.on('response', async (resp) => {
    const req = resp.request();
    const url = resp.url();
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const item = {
      status: resp.status(),
      type: req.resourceType(),
      method: req.method(),
      url,
      ct
    };
    responses.push(item);
    if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
      logLine('XHR', resp.status(), req.method(), ct, url);
      if (ct.includes('application/json')) {
        try {
          const txt = await resp.text();
          fs.writeFileSync(path.join(OUT, 'last_json.txt'), txt);
        } catch (e) {
          logLine('json read failed', e.message);
        }
      }
    }
  });

  page.on('requestfailed', req => {
    logLine('REQ FAIL', req.resourceType(), req.method(), req.url(), req.failure()?.errorText || '');
  });

  try {
    await sendTelegram('Стартую жёсткую диагностику...');
    await login(page);

    logLine('goto finder');
    await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(6000);

    // Сохраняем состояние в файлы
    await saveState(page, 'finder_state');

    fs.writeFileSync(path.join(OUT, 'responses.json'), JSON.stringify(responses, null, 2));
    fs.writeFileSync(path.join(OUT, 'cookies.json'), JSON.stringify(await context.cookies(), null, 2));
    fs.writeFileSync(path.join(OUT, 'storage.json'), JSON.stringify(await context.storageState(), null, 2));

    const text = await page.locator('body').innerText().catch(() => '');
    const looksLikeCount = text.match(/(\d+)\s+(Wohnungen|Angeboten|Objekten)/i);

    // --- ОТПРАВКА СКРИНШОТА И ЛОГА В ТЕЛЕГРАМ ---
    const FormData = require('form-data'); // Убедись, что form-data есть в package.json, либо он подтянется из axios
    
    // 1. Шлем скриншот экрана
    const screenshotPath = path.join(OUT, 'finder_state.png');
    if (fs.existsSync(screenshotPath)) {
        const formPhoto = new FormData();
        formPhoto.append('chat_id', TELEGRAM_CHAT_ID);
        formPhoto.append('photo', fs.createReadStream(screenshotPath));
        formPhoto.append('caption', looksLikeCount ? `Вижу текст: ${looksLikeCount[0]}` : 'Счётчик текстом не найден. Смотри скриншот.');
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, formPhoto, {
            headers: formPhoto.getHeaders()
        }).catch(e => logLine('Ошибка отправки фото в ТГ:', e.message));
    }

    // 2. Шлем файл логов сети responses.json, чтобы увидеть скрытые API-пути
    const resJsonPath = path.join(OUT, 'responses.json');
    if (fs.existsSync(resJsonPath)) {
        const formDoc = new FormData();
        formDoc.append('chat_id', TELEGRAM_CHAT_ID);
        formDoc.append('document', fs.createReadStream(resJsonPath));
        formDoc.append('caption', 'Лог сетевых запросов (responses.json)');
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, formDoc, {
            headers: formDoc.getHeaders()
        }).catch(e => logLine('Ошибка отправки документа в ТГ:', e.message));
    }

  } catch (e) {
    logLine('FATAL', e.stack || e.message);
    await sendTelegram(`Ошибка: ${e.message}`);
  } finally {
    await browser.close();
  }
}
