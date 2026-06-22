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
  const roomsMatch =
    text.match(/(\d+(?:[.,]\d+)?)\s*(?:1\/2-)?Zimmer\b/i) ||
    text.match(/(\d+(?:[.,]\d+)?)-Zimmer\b/i);
  const rooms = roomsMatch ? toFloat(roomsMatch[1]) : null;

  const sizeMatch = text.match(/(\d+(?:[,.]?\d+)?)\s*m²/i);
  const size = sizeMatch ? toFloat(sizeMatch[1]) : null;

  const rentMatch = text.match(/\b(\d{3,4}(?:[,.]\d{1,2})?)\s*€/);
  const rent = rentMatch ? toFloat(rentMatch[1]) : null;

  let address = '';
  let district = '';
  const pipeIdx = text.indexOf('|');
  if (pipeIdx !== -1) {
    const raw = text.slice(pipeIdx + 1).trim().split('\n')[0].trim();
    address = raw;
    const plzMatch = raw.match(/\d{5}\s+(.+)/);
    if (plzMatch) district = plzMatch[1].trim();
  } else {
    address  = extractAddress(text);
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
