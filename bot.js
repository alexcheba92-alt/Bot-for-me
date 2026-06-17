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
        console.log("--- Цикл запущен ---");
        
        // 1. Получаем логин-страницу
        const loginPage = await client.get('https://www.inberlinwohnen.de/login/');
        const $ = cheerio.load(loginPage.data);
        
        // Авто-поиск токена (ищет любое из возможных имен)
        const csrfToken = $('input[name="_token"]').val() || $('input[name="csrf_token"]').val();
        
        if (!csrfToken) {
            console.error("Ошибка: CSRF токен не найден. Возможно, сайт сменил структуру.");
            return;
        }
        console.log("Токен получен.");

        // 2. Логин
        const loginRes = await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
            email: process.env.INBERLIN_EMAIL,
            password: process.env.INBERLIN_PASSWORD,
            _token: csrfToken // Если упадет с 419, значит надо слать csrf_token
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        console.log("Логин статус:", loginRes.status);

        // 3. Переход во Finder
        const finder = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
        console.log("Статус страницы поиска:", finder.status);
        
        const $$ = cheerio.load(finder.data);
        const links = [];
        $$('a[href*="/expose/"]').each((i, el) => {
            links.push($$(el).attr('href'));
        });

        console.log("Найдено квартир:", links.length);
        if (links.length > 0) console.log("Первая ссылка:", links[0]);

    } catch (e) {
        console.error("Критическая ошибка:", e.message);
    }
}

// Запуск
async function main() {
    while(true) {
        await runService();
        await new Promise(r => setTimeout(r, 300000)); // 5 минут
    }
}
main();
