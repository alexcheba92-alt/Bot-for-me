'use strict';

require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const qs = require('qs');

// Настройка клиента
const jar = new CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 20000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
    }
}));

async function login() {
    console.log("--- Инициализация авторизации ---");
    const response = await client.get('https://www.inberlinwohnen.de/login/');
    const $ = cheerio.load(response.data);
    const token = $('input[name="_token"]').val();

    if (!token) throw new Error("Не удалось получить CSRF токен");

    return await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
        email: process.env.INBERLIN_EMAIL,
        password: process.env.INBERLIN_PASSWORD,
        _token: token
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
}

async function fetchApartments() {
    const response = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
    const $ = cheerio.load(response.data);
    
    const apartments = [];
    $('a[href*="/expose/"]').each((_, el) => {
        const link = $(el).attr('href');
        if (link && !apartments.includes(link)) {
            apartments.push(link);
        }
    });
    return apartments;
}

async function runService() {
    try {
        const finderPage = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
        
        // Проверка: если перекинуло на логин, значит сессия истекла
        if (finderPage.request.path === '/login/') {
            console.log("Сессия истекла, перелогиниваемся...");
            await login();
            return await runService();
        }

        const links = await fetchApartments();
        console.log(`[${new Date().toLocaleTimeString()}] Найдено объектов: ${links.length}`);
        
        if (links.length > 0) {
            console.log("Актуальные ссылки:", links.slice(0, 3));
        }

    } catch (e) {
        console.error("Ошибка при выполнении цикла:", e.message);
    }
}

// Запуск цикла с интервалом 5 минут
(async () => {
    console.log("Сервис запущен.");
    while(true) {
        await runService();
        await new Promise(resolve => setTimeout(resolve, 300000));
    }
})();
