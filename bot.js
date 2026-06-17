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
    console.log("--- Цикл запущен ---");
    try {
        const loginPage = await client.get('https://www.inberlinwohnen.de/login/');
        const $ = cheerio.load(loginPage.data);
        
        // Берем токен. Если _token пуст, ищем csrf_token
        const csrfToken = $('input[name="_token"]').val() || $('input[name="csrf_token"]').val();
        console.log("Токен найден:", !!csrfToken);

        const loginRes = await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
            email: process.env.INBERLIN_EMAIL,
            password: process.env.INBERLIN_PASSWORD,
            _token: csrfToken, // Если это Laravel, обычно _token
            csrf_token: csrfToken // Отправляем оба варианта на всякий случай
        }), {
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.inberlinwohnen.de/login/'
            },
            validateStatus: (status) => status < 500
        });

        console.log("Логин статус:", loginRes.status);
        if (loginRes.status !== 302 && loginRes.status !== 200) {
            console.log("Ответ сервера (ошибка):", JSON.stringify(loginRes.data).slice(0, 500));
            return;
        }

        const finder = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
        console.log("Статус страницы поиска:", finder.status);
        
        const $$ = cheerio.load(finder.data);
        const links = [];
        $$('a[href*="/expose/"]').each((i, el) => { links.push($$(el).attr('href')); });

        console.log("Найдено квартир:", links.length);
    } catch (e) {
        console.error("Критическая ошибка:", e.message);
    }
}

async function main() {
    while(true) {
        await runService();
        await new Promise(r => setTimeout(r, 300000));
    }
}
main();
