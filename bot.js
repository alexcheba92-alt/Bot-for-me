        // 2. Логин
        const loginRes = await client.post('https://www.inberlinwohnen.de/login/', qs.stringify({
            email: process.env.INBERLIN_EMAIL,
            password: process.env.INBERLIN_PASSWORD,
            _token: csrfToken // оставляем только это, без csrf_token внутри объекта
        }), {
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.inberlinwohnen.de/login/',
                'Origin': 'https://www.inberlinwohnen.de'
            },
            validateStatus: (status) => status < 500
        });
