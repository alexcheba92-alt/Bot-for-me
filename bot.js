const axios = require('axios');

async function testConnection() {
    try {
        const response = await axios.get('https://www.inberlinwohnen.de/login/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            maxRedirects: 0 // Важно: не даем делать редиректы на "загрузку"
        });
        console.log('Status:', response.status);
        console.log('Headers:', JSON.stringify(response.headers, null, 2));
    } catch (e) {
        console.log('Error:', e.response ? e.response.status : e.message);
    }
}
testConnection();
