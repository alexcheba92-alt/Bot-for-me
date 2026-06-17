async function runService() {
    console.log("Попытка входа...");
    try {
        // 1. Обязательно забираем свежие куки и токен
        const loginPage = await client.get('https://www.inberlinwohnen.de/login/');
        const $ = cheerio.load(loginPage.data);
        const csrfToken = $('input[name="_token"]').val(); // Проверь в HTML, может быть csrf_token
        
        console.log("CSRF Токен получен:", csrfToken ? "ОК" : "ПУСТО");

        // 2. Отправляем логин с правильными заголовками
        const loginRes = await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
            email: process.env.INBERLIN_EMAIL,
            password: process.env.INBERLIN_PASSWORD,
            _token: csrfToken // Если упадет с 419, попробуй поменять на csrf_token
        }), {
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.inberlinwohnen.de/login/'
            }
        });

        console.log("Логин статус:", loginRes.status);

        // 3. Сразу идем во Finder
        const finder = await client.get('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
        console.log("Статус страницы поиска:", finder.status);
        
        // ... парсинг ссылок
    } catch (e) {
        console.error("Ошибка в работе:", e.message);
    }
}
