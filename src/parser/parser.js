'use strict';

const { C } = require('../config/config');

function toFloat(v) {
  if (!v && v !== 0) return 0;
  return parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
}

function extractNum(text, rx) {
  const m = text.match(rx);
  return m ? toFloat(m[1]) : null;
}

function extractAddress(text) {
  const m = text.match(/([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\s\-.]*(?:straße|str\.|allee|weg|platz|damm|ring|chaussee|gasse|ufer)\s*\d*)/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

const DISTRICTS = [
  'Mitte','Tiergarten','Wedding','Prenzlauer Berg','Friedrichshain','Kreuzberg',
  'Pankow','Weißensee','Charlottenburg','Wilmersdorf','Spandau','Steglitz',
  'Zehlendorf','Tempelhof','Schöneberg','Neukölln','Treptow','Köpenick',
  'Treptow-Köpenick','Marzahn','Hellersdorf','Marzahn-Hellersdorf',
  'Lichtenberg','Hohenschönhausen','Reinickendorf','Wittenau','Tegel',
  'Buch','Adlershof','Heinersdorf',
];

function extractDistrict(text) {
  for (const d of DISTRICTS) { if (text.includes(d)) return d; }
  return '';
}

const COMPANIES = ['degewo','GESOBAU','Gewobag','HOWOGE','STADT UND LAND','WBM','berlinovo'];

function extractCompany(text) {
  for (const c of COMPANIES) { if (text.toLowerCase().includes(c.toLowerCase())) return c; }
  return '';
}

// Парсит текст карточки квартиры.
// Формат сайта: "3.0 Zimmer, 70,28 m², 466,94 € | Straße 32, 12559 Berlin"
function parseAptText(text) {
  // Поиск комнат — ТОЛЬКО паттерны где число идёт ПЕРЕД словом "Zimmer".
  // Паттерн "Zimmer[:\s]+(\d+)" (число ПОСЛЕ Zimmer) был убран — он
  // ловил случайные числа после любого упоминания слова "Zimmer" в тексте
  // (например "Zimmerausstattung: 1 Bad", "Zimmertür 1.20m" и т.п.),
  // что давало ложное rooms=1 для всех квартир. Именно этот паттерн был
  // реальной причиной бага, не "Zi." как предполагалось ранее.
  // Сайт показывает квартиру в двух разных форматах:
  // 1) Короткая карточка списка: "3,0 Zimmer, 70 m², 466 €" — число ПЕРЕД словом
  // 2) Блок "Alle Details": "Zimmeranzahl: ... 3,0 ... Wohnfläche: ..." —
  //    точная метка "Zimmeranzahl:", число идёт ПОСЛЕ, через пробелы/табы.
  //    Для формата 2 ограничиваем дистанцию до 80 символов, чтобы случайно
  //    не захватить число из следующего поля (Wohnfläche/Kaltmiete и т.д.)
  const roomsMatch =
    text.match(/(\d+(?:[.,]\d+)?)\s*(?:1\/2-)?Zimmer\b/i) ||
    text.match(/(\d+(?:[.,]\d+)?)-Zimmer\b/i) ||
    text.match(/Zimmeranzahl:((?:(?!Wohnfläche:|Kaltmiete:)[\s\S]){0,1500}?)(\d+(?:[.,]\d+)?)/i);
  const rooms = roomsMatch ? toFloat(roomsMatch[roomsMatch.length - 1]) : null;

  // Площадь: в формате "Alle Details" явно ищем метку "Wohnfläche:",
  // чтобы не зависеть от порядка полей на странице. Если метки нет
  // (короткая карточка списка) — берём первое число перед "m²".
  // Дистанция до 1500 символов — между меткой и значением на сайте
  // может быть до ~1000+ символов пробелов/табов/переносов строк.
  const sizeMatch =
    text.match(/Wohnfläche:((?:(?!Kaltmiete:|Nebenkosten:)[\s\S]){0,1500}?)(\d+(?:[,.]?\d+)?)\s*m²/i) ||
    text.match(/(\d+(?:[,.]?\d+)?)\s*m²/i);
  const size = sizeMatch ? toFloat(sizeMatch[sizeMatch.length - 1]) : null;

  // Аренда: явно ищем метку "Kaltmiete:" — в "Alle Details" рядом есть
  // ещё Nebenkosten и Gesamtmiete с похожими суммами в €. Без явной метки
  // легко перепутать поля. Если метки нет — берём первое число перед "€"
  // (короткая карточка списка, там только одна сумма).
  const rentMatch =
    text.match(/Kaltmiete:((?:(?!Nebenkosten:|Gesamtmiete:)[\s\S]){0,1500}?)(\d{2,4}(?:[,.]\d{1,2})?)\s*€/i) ||
    text.match(/\b(\d{3,4}(?:[,.]\d{1,2})?)\s*€/);
  const rent = rentMatch ? toFloat(rentMatch[rentMatch.length - 1]) : null;

  let address = '';
  let district = '';

  // Формат "Alle Details": есть метка "Adresse:", после неё (через пробелы/
  // переносы строк/табы) идёт сама строка адреса вида "Straße 14, 13587, Spandau"
  const addrLabelMatch = text.match(/Adresse:\s*([\s\S]{0,150}?)(?:\n\s*\n|\t\t)/i);
  if (addrLabelMatch) {
    const raw = addrLabelMatch[1].replace(/\s+/g, ' ').trim();
    if (raw) {
      address = raw;
      const plzMatch = raw.match(/(\d{5}),?\s*(.+)/);
      if (plzMatch) district = plzMatch[2].trim();
    }
  }

  // Формат короткой карточки списка: "... | Straße 32, 12559 Bezirk"
  if (!address) {
    const pipeIdx = text.indexOf('|');
    if (pipeIdx !== -1) {
      const raw = text.slice(pipeIdx + 1).trim().split('\n')[0].trim();
      address = raw;
      const plzMatch = raw.match(/\d{5}\s+(.+)/);
      if (plzMatch) district = plzMatch[1].trim();
    }
  }

  // Если ничего не сработало — пробуем общие эвристики по тексту целиком
  if (!address) {
    address  = extractAddress(text);
    district = extractDistrict(text);
  }
  if (!district) {
    district = extractDistrict(text);
  }

  if (!rooms && !rent) return null;
  if (!address && !district) return null; // защита от мусора без локации

  return {
    id: '', url: '',
    address,
    district: district || extractDistrict(text),
    company:  extractCompany(text),
    rent:     rent  != null ? rent.toFixed(2)  : '',
    rooms:    rooms != null ? String(rooms)    : '',
    size:     size  != null ? String(size)     : '',
    wbs:      /\bWBS\b/i.test(text) ? 'Требуется WBS' : '',
  };
}

// ================================================================
//  МУСОРНЫЕ URL
// ================================================================
function isJunkUrl(url) {
  if (!url) return true;
  if (url === C.baseUrl || url === C.baseUrl + '/') return true;
  if (url === C.finderUrl) return true;
  if (url.endsWith('/mein-bereich') || url.endsWith('/mein-bereich/')) return true;

  const junkPaths = ['/support', '/account', '/profil', '/sicherheit', '/datenschutz',
                     '/impressum', '/kontakt', '/startseite', '/tauschportal',
                     '/login', '/logout', '/agb'];
  for (const j of junkPaths) {
    if (url.includes(j)) return true;
  }
  return false;
}

function isApartmentUrl(url) {
  if (!url) return false;
  if (isJunkUrl(url)) return false;
  if (/\/detail\/[\w-]+/i.test(url)) return true;
  if (/\/wohnungssuche\//i.test(url)) return true;
  if (/\d{4,}/.test(url) && (/expose|objekt|wohnung|apartment/i.test(url))) return true;
  return false;
}

module.exports = { toFloat, extractNum, parseAptText, isJunkUrl, isApartmentUrl };
