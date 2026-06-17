const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const qs = require('qs');

const jar = new tough.CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }
}));

async function main() {
    try {
        // 1. Забираем логин-страницу (чтобы получить куки и CSRF)
        const loginPage = await client.get('https://www.inberlinwohnen.de/login/');
        const $ = cheerio.load(loginPage.data);
        const csrfToken = $('input[name="XSRF-TOKEN"]').val() || $('input[name="_token"]').val();

        // 2. Логин (имитируем отправку формы)
        await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
            email: process.env.INBERLIN_EMAIL,
            password: process.env.INBERLIN_PASSWORD,
            _token: csrfToken // убедись в имени поля по HTML
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        // 3. Переход во Finder
        const finderPage = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
        
        // 4. Парсинг
        const $$ = cheerio.load(finderPage.data);
        const flats = [];
        $$('a[href*="/expose/"]').each((i, el) => {
            flats.push($$(el).attr('href'));
        });

        console.log('Найдено квартир:', flats.length);
        console.log('Первая ссылка:', flats[0]);

    } catch (e) {
        console.error('Ошибка:', e.message);
    }
}

main();
