// Baixa os postos de BH do OpenStreetMap UMA vez e salva em postos.json.
// Uso (Node 18+), dentro da pasta do projeto:  node baixar-postos.mjs
import { writeFileSync } from 'node:fs';

const BBOX = '-20.1,-44.1,-19.8,-43.7'; // sul, oeste, norte, leste
const SERVIDORES = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const query = `[out:json][timeout:60];nwr["amenity"="fuel"](${BBOX});out center qt;`;
const espera = ms => new Promise(r => setTimeout(r, ms));

for (let tentativa = 1; tentativa <= 5; tentativa++) {
  for (const url of SERVIDORES) {
    try {
      console.log(`Tentativa ${tentativa}: ${url}`);
      const r = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error('status ' + r.status);
      const json = await r.json();
      const postos = json.elements.filter(el => (el.lat ?? el.center?.lat) != null).map(el => {
        const t = el.tags || {};
        return { id: el.type[0] + el.id, nome: t.name || t.brand || 'Posto sem nome',
          bairro: t['addr:suburb'] || '', via: t['addr:street'] || '',
          lat: el.lat ?? el.center.lat, lng: el.lon ?? el.center.lon };
      });
      if (!postos.length) throw new Error('nenhum posto retornado');
      writeFileSync('postos.json', JSON.stringify(postos));
      console.log(`Pronto: ${postos.length} postos salvos em postos.json`);
      process.exit(0);
    } catch (e) { console.log('  falhou:', e.message); }
  }
  console.log(`Aguardando ${10 * tentativa}s para tentar de novo...`);
  await espera(10000 * tentativa);
}
console.log('Não consegui agora. Tente de novo em alguns minutos.');
process.exit(1);
