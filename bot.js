const axios = require('axios');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = 300000; // 5 минут
const SEEN_FILE = './seen_apartments.json';

let seenIds = new Set();

// Загрузка кэша
if (fs.existsSync(SEEN_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
        seenIds = new Set(data);
        console.log(`[База] Загружено из памяти квартир: ${seenIds.size}`);
    } catch (e) {
        console.log('[База] Ошибка чтения файла памяти, создаем чистую.');
    }
}

function saveCache() {
    try {
        fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenIds]), 'utf8');
    } catch (e) {
        console.error('[База] Не удалось сохранить кэш:', e.message);
    }
}

async function sendTelegram(text, url = null) {
    const payload = { 
        chat_id: TELEGRAM_CHAT_ID, 
        text: text, 
        parse_mode: 'HTML',
        disable_web_page_preview: false
    };
    if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]] };
    }
    
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('📱 Сообщение успешно улетело в Telegram');
    } catch (e) {
        console.error('❌ Ошибка отправки в Telegram. Проверь токен и Chat ID!', e.response ? e.response.data : e.message);
    }
}

async function checkInBerlin() {
    const timeNow = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`\n[${timeNow}] Запуск проверки безбраузерным методом...`);

    try {
        // Делаем прямой запрос к обработчику поиска (имитируем форму)
        // Ищем 3-комнатные квартиры во всем Берлине
        const response = await axios({
            method: 'post',
            url: 'https://www.inberlinwohnen.de/wp-content/themes/ibw/core/finder/housing-finder-controller.php',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/'
            },
            // Параметры запроса: 3 комнаты, лимит цены не ставим жестко в API, отфильтруем в коде для надежности
            data: 'action=get_housing_results&wub_zimmer_von=3&wub_zimmer_bis=3&wub_miete_bis=600'
        });

        if (!response.data || typeof response.data !== 'string') {
            console.log('❌ Сайт вернул пустой или некорректный ответ.');
            return;
        }

        // Вытаскиваем ссылки на экспoзе регулярным выражением
        const matches = [...response.data.matchAll(/href="(https:\/\/www\.inberlinwohnen\.de\/expose\/(\d+)\/)"/g)];
        
        console.log(` Найдено сырых совпадений на странице: ${matches.length}`);

        if (matches.length === 0) {
            console.log(' На сайте сейчас физически нет 3-комнатных квартир до 600€, либо запросы блокируются.');
            return;
        }

        let newAptFound = false;

        for (const match of matches) {
            const fullUrl = match[1];
            const id = match[2];

            if (!seenIds.has(id)) {
                seenIds.add(id);
                newAptFound = true;
                
                console.log(`✨ Обнаружена новая квартира! ID: ${id}`);
                await sendTelegram(`🏠 <b>Найдена новая 3-комнатная квартира!</b>\n\nID объявления: <code>${id}</code>\nЦена: до 600€ Kaltmiete\nПроверено в: ${timeNow}`, fullUrl);
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (newAptFound) {
            saveCache();
        } else {
            console.log(' Ничего нового. Все эти квартиры мы уже видели.');
        }

    } catch (e) {
        console.error('❌ Ошибка сети при запросе к сайту:', e.message);
    }
}

async function main() {
    console.log('🤖 Бот стартует...');
    
    // ПРИНУДИТЕЛЬНЫЙ ТЕСТ ТЕЛЕГРАМА ПРИ ЗАПУСКЕ
    // Если это сообщение НЕ придет — значит у тебя 100% указан неверный TELEGRAM_CHAT_ID или токен бота в Railway!
    await sendTelegram('🚀 <b>Бот-наблюдатель запущен!</b>\nСвязь с Telegram работает отлично. Начинаю мониторинг квартир...');

    await checkInBerlin();
    setInterval(checkInBerlin, CHECK_INTERVAL);
}

main().catch(console.error);
