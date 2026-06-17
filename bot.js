'use strict';
const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const qs = require('qs');

// Инициализация HTTP-клиента
const jar = new tough.CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
}));

async function runService() {
    console.log("Бот запущен в HTTP-режиме...");
    try {
        // 1. Получаем логин-страницу
        const loginPage = await client.get('https://www.inberlinwohnen.de/login/');
        const $ = cheerio.load(loginPage.data);
        const csrf = $('input[name="csrf_token"]').attr('value') || $('input[name="_token"]').attr('value');

        // 2. Логин
        await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
            email: process.env.INBERLIN_EMAIL,
            password: process.env.INBERLIN_PASSWORD,
            csrf_token: csrf
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        // 3. Получение квартир
        const finder = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
        const $$ = cheerio.load(finder.data);
        const links = [];
        $$('a[href*="/expose/"]').each((_, el) => { links.push($$(el).attr('href')); });

        console.log('Найдено квартир:', links.length);
        if (links.length > 0) {
             // Здесь ты можешь добавить вызов sendTelegram
             console.log('Первая ссылка:', links[0]);
        }
    } catch (e) {
        console.error('Ошибка в работе:', e.message);
    }
}

// Запуск бесконечного цикла
async function main() {
    while(true) {
        await runService();
        await new Promise(r => setTimeout(r, 300000)); // 5 минут
    }
}

main();
