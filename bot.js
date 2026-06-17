'use strict';
const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const qs = require('qs');

const jar = new tough.CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }
}));

async function runService() {
    try {
        console.log("--- Начало цикла ---");
        
        // 1. Получаем страницу логина
        const loginPage = await client.get('https://www.inberlinwohnen.de/login/');
        const $ = cheerio.load(loginPage.data);
        const csrfToken = $('input[name="_token"]').val();
        
        // 2. Логин
        const loginRes = await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
            email: process.env.INBERLIN_EMAIL,
            password: process.env.INBERLIN_PASSWORD,
            _token: csrfToken
        }), {
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.inberlinwohnen.de/login/',
                'Origin': 'https://www.inberlinwohnen.de',
                'X-Requested-With': 'XMLHttpRequest'
            },
            validateStatus: (status) => status < 500
        });

        console.log("Логин статус:", loginRes.status);
        if (loginRes.status !== 200 && loginRes.status !== 302) {
            console.log("Ошибка логина (ответ):", JSON.stringify(loginRes.data).slice(0, 200));
            return;
        }

        // 3. Finder
        const finder = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
        const $$ = cheerio.load(finder.data);
        const links = [];
        $$('a[href*="/expose/"]').each((i, el) => { links.push($$(el).attr('href')); });

        console.log("Найдено квартир:", links.length);
        if (links.length > 0) console.log("Первая ссылка:", links[0]);

    } catch (e) {
        console.error("Критическая ошибка:", e.message);
    }
}

// Запуск цикла
(async () => {
    while(true) {
        await runService();
        await new Promise(r => setTimeout(r, 300000));
    }
})();
