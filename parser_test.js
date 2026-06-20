'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseAptText, isJunkUrl, isApartmentUrl } = require('../src/parser/parser');

// ================================================================
//  ТЕСТЫ PARSEAPTTEXT — реальные форматы карточек с сайта
// ================================================================

test('парсит стандартную карточку 3-комнатной квартиры', () => {
  const text = '3,0 Zimmer, 70,28 m², 466,94 € | Alfred-Randt-Straße 32, 12559 Treptow-Köpenick';
  const apt = parseAptText(text);
  assert.ok(apt, 'должен распарсить карточку');
  assert.strictEqual(apt.rooms, '3');
  assert.strictEqual(apt.rent, '466.94');
  assert.strictEqual(apt.size, '70.28');
  assert.ok(apt.address.includes('Alfred-Randt-Straße'));
  assert.strictEqual(apt.district, 'Treptow-Köpenick');
});

test('парсит карточку с дробным числом комнат (2 1/2-Zimmer)', () => {
  const text = '2 1/2-Zimmer-Wohnung mit großem Balkon | Zur Nachtheide 22, 12557 Treptow-Köpenick, 58,78 m², 541,84 €';
  const apt = parseAptText(text);
  assert.ok(apt, 'должен распарсить карточку с дробными комнатами');
  assert.strictEqual(apt.rent, '541.84');
});

test('извлекает признак WBS', () => {
  const text = '3,0 Zimmer, 68,82 m², 454,97 € | Blenheimstraße 52, 12685 Marzahn-Hellersdorf — WBS erforderlich';
  const apt = parseAptText(text);
  assert.ok(apt.wbs, 'должен пометить как WBS-квартиру');
});

test('возвращает null для текста без комнат и аренды', () => {
  const text = 'Mein inberlinwohnen Account Profil Sicherheit Datenschutz';
  const apt = parseAptText(text);
  assert.strictEqual(apt, null, 'мусорный текст (меню сайта) не должен парситься как квартира');
});

test('возвращает null для текста без адреса (защита от мусора)', () => {
  const text = '3 Zimmer 500 €'; // нет ни | разделителя, ни признаков улицы/района
  const apt = parseAptText(text);
  assert.strictEqual(apt, null, 'без адреса/района не считаем валидной квартирой');
});

test('не путает копейки с ценой (1,38 € не должно стать рентой)', () => {
  const text = 'Bildquelle: © OpenStreetMap-Mitwirkende 1,38 Zimmer 3 Zimmer, 55,87 m², 477,94 € | Daumstraße 205, 13469 Reinickendorf';
  const apt = parseAptText(text);
  // Аренда ищется как 3-4-значное число — 1,38 не попадёт под этот паттерн
  if (apt) {
    assert.notStrictEqual(apt.rent, '1.38', 'не должен принять копейки/мусорное число за арендную плату');
  }
});

// ================================================================
//  ТЕСТЫ МУСОРНЫХ URL
// ================================================================

test('isJunkUrl распознаёт служебные страницы', () => {
  assert.strictEqual(isJunkUrl('https://www.inberlinwohnen.de/'), true);
  assert.strictEqual(isJunkUrl('https://www.inberlinwohnen.de/support'), true);
  assert.strictEqual(isJunkUrl('https://www.inberlinwohnen.de/mein-bereich'), true);
  assert.strictEqual(isJunkUrl('https://www.inberlinwohnen.de/account'), true);
  assert.strictEqual(isJunkUrl(''), true);
  assert.strictEqual(isJunkUrl(null), true);
});

test('isJunkUrl пропускает реальные объявления', () => {
  assert.strictEqual(
    isJunkUrl('https://www.howoge.de/wohnungen-gewerbe/wohnungssuche/detail/1770-20506-16.html?t=ibw'),
    false
  );
  assert.strictEqual(
    isJunkUrl('https://www.degewo.de/de/properties/W1400-40102-0830-1201.html'),
    false
  );
});

test('isApartmentUrl положительно распознаёт известные паттерны объявлений', () => {
  assert.strictEqual(
    isApartmentUrl('https://www.howoge.de/wohnungen-gewerbe/wohnungssuche/detail/1770-20506-16.html'),
    true
  );
  assert.strictEqual(
    isApartmentUrl('https://stadtundland.de/wohnungssuche/1001%2F5166%2F00021'),
    true
  );
  assert.strictEqual(isApartmentUrl('https://www.inberlinwohnen.de/support'), false);
  assert.strictEqual(isApartmentUrl(''), false);
});
