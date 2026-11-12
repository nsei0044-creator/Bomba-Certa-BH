/* ==== Firebase SDK ==== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { getFirestore, doc, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

let auth = null, db = null;
let currentUser = null;
try { const fb = initializeApp(firebaseConfig); auth = getAuth(fb); db = getFirestore(fb); }
catch (e) { console.warn('Firebase não configurado (ok no modo demonstração):', e.message); }

const DEMO_MODE_HOST = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
// User's mode preference stored in localStorage. "real" means force real mode even on localhost.
const USER_MODE = localStorage.getItem('modo');
// Effective demo mode: only when running on localhost and user hasn't forced real mode.
const DEMO_MODE = DEMO_MODE_HOST && USER_MODE !== 'real';
// Persisted mode toggle helper
function setUserMode(toReal) {
  if (toReal) {
    localStorage.setItem('modo', 'real');
  } else {
    localStorage.removeItem('modo');
  }
}

/* ==== G1 – Login: tradução de erros e overlay ==== */
const ERROS_AUTH = {
  'auth/invalid-credential':    'E-mail ou senha incorretos.',
  'auth/user-not-found':        'E-mail ou senha incorretos.',
  'auth/wrong-password':        'E-mail ou senha incorretos.',
  'auth/email-already-in-use':  'Este e-mail já está cadastrado. Faça login.',
  'auth/weak-password':         'A senha precisa ter pelo menos 6 caracteres.',
  'auth/invalid-email':         'E-mail inválido.',
  'auth/popup-closed-by-user':  'Você fechou a janela de login. Tente de novo.',
  'auth/popup-blocked':         'O navegador bloqueou a janela de login. Permita popups e tente de novo.',
  'auth/network-request-failed':'Sem conexão com a internet. Verifique sua rede.',
};
function traduzirErro(e) {
  return ERROS_AUTH[e.code] || 'Erro ao acessar sua conta. Tente novamente.';
}

let _loginTrigger = null;   // elemento que abriu o overlay (para devolver foco)
let _onLoginSuccess = null;  // callback pós-login (ex.: reenviar avaliação)
let _loginMode = 'login';    // 'login' ou 'criar'

function showLogin(triggerEl, onSuccess) {
  if (!auth) {
    alert('Login indisponível: Firebase não configurado.');
    return;
  }
  _loginTrigger = triggerEl || document.activeElement;
  _onLoginSuccess = onSuccess || null;
  _loginMode = 'login';
  atualizarLoginMode();
  const overlay = document.querySelector('#overlay-login');
  overlay.hidden = false;
  const campo = overlay.querySelector('#login-email');
  campo.value = '';
  overlay.querySelector('#login-senha').value = '';
  const erroDiv = overlay.querySelector('#login-erro');
  erroDiv.hidden = true; erroDiv.textContent = '';
  campo.focus();
}

function hideLogin() {
  const overlay = document.querySelector('#overlay-login');
  overlay.hidden = true;
  if (_loginTrigger) { _loginTrigger.focus(); _loginTrigger = null; }
}

function atualizarLoginMode() {
  const btnEntrar = document.querySelector('#login-entrar');
  const msgToggle = document.querySelector('#login-toggle-msg');
  const btnToggle = document.querySelector('#login-toggle');
  const titulo    = document.querySelector('#login-titulo');
  if (_loginMode === 'criar') {
    btnEntrar.textContent = 'Criar conta';
    titulo.textContent = 'Criar conta no Bomba Certa';
    msgToggle.childNodes[0].textContent = 'Já tem conta? ';
    btnToggle.textContent = 'Entrar';
  } else {
    btnEntrar.textContent = 'Entrar';
    titulo.textContent = 'Entrar no Bomba Certa';
    msgToggle.childNodes[0].textContent = 'Não tem conta? ';
    btnToggle.textContent = 'Criar conta';
  }
}

function mostrarErroLogin(msg) {
  const el = document.querySelector('#login-erro');
  el.textContent = msg;
  el.hidden = false;
}


const CATEGORIAS = [
  { id: 'atendimento', nome: 'Atendimento', dica: 'Cordialidade e presteza da equipe' },
  { id: 'preco',       nome: 'Preço',       dica: 'Valor cobrado em relação à região' },
  { id: 'agilidade',   nome: 'Agilidade',   dica: 'Fila, abastecimento e pagamento' },
  { id: 'estrutura',   nome: 'Estrutura',   dica: 'Calibrador, limpeza e conveniência' },
];
const VIAS = ['Av. do Contorno', 'Av. Antônio Carlos', 'Av. Cristiano Machado'];
/* ==== DADOS REAIS (Overpass) ==== */
let POSTOS = [];
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const BH_BBOX = '-20.1,-44.1,-19.8,-43.7'; // south,west,north,east

function semente(id) { // pseudoaleatório estável por posto (dados SIMULADOS)
  let x = Number(id) % 2147483647 || 1;
  return () => (x = (x * 48271) % 2147483647) / 2147483647;
}
const entre = (r, a, b, d = 1) => Number((a + r() * (b - a)).toFixed(d));

const OVERPASS_URLS = [OVERPASS_URL, 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const EX = (id, nome, bairro, via, lat, lng, g, e, v, a, p, ag, es) => ({ id, nome, bairro, via, lat, lng, gasolina: g, etanol: e, votos: v, notas: { atendimento: a, preco: p, agilidade: ag, estrutura: es } });
const EXEMPLOS = [
  EX('ex1', 'Posto Contorno Centro', 'Centro', 'Av. do Contorno', -19.9245, -43.9352, 6.19, 4.19, 128, 4.5, 3.9, 4.2, 4.0),
  EX('ex2', 'Posto Savassi Express', 'Savassi', 'Av. do Contorno', -19.9390, -43.9335, 6.29, 4.35, 96, 4.2, 3.1, 4.7, 4.4),
  EX('ex3', 'Posto Pampulha Norte', 'Pampulha', 'Av. Antônio Carlos', -19.8670, -43.9650, 5.99, 3.99, 210, 3.8, 4.8, 3.6, 3.9),
  EX('ex4', 'Posto Antônio Carlos Sul', 'São Francisco', 'Av. Antônio Carlos', -19.8890, -43.9560, 6.05, 4.09, 74, 4.6, 4.1, 4.0, 4.7),
  EX('ex5', 'Posto Cristiano Machado 24h', 'Cidade Nova', 'Av. Cristiano Machado', -19.9000, -43.9230, 6.09, 4.15, 153, 3.5, 4.3, 4.5, 3.7),
  EX('ex6', 'Posto Venda Nova', 'Venda Nova', 'Av. Cristiano Machado', -19.8150, -43.9500, 5.95, 3.95, 88, 4.0, 4.6, 3.9, 3.4),
];
const AVISO_EX = '<p class="aviso erro">Não consegui buscar os postos reais agora e estou mostrando postos de exemplo. <button class="chip" id="recarregar">Tentar de novo</button></p>';

async function buscarOverpass(query) {
  const ctrls = [];
  // consulta os servidores ao mesmo tempo; vale o primeiro que responder
  const tentativas = OVERPASS_URLS.map(async url => {
    const ctrl = new AbortController(); ctrls.push(ctrl);
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      if (!r.ok) throw new Error(url + ' respondeu ' + r.status);
      return await r.json();
    } catch (e) { console.warn('Overpass falhou:', url, e.message); throw e; }
    finally { clearTimeout(t); }
  });
  try { return await Promise.any(tentativas); }
  finally { ctrls.forEach(c => c.abort()); }
}

function completar(b) { // acrescenta notas/preços SIMULADOS (estáveis por posto)
  const rnd = semente(b.id.replace(/\D/g, ''));
  return { ...b, gasolina: entre(rnd, 5, 6.5, 2), etanol: entre(rnd, 3.5, 5, 2), votos: entre(rnd, 20, 200, 0),
    notas: { atendimento: entre(rnd, 3, 5), preco: entre(rnd, 3, 5), agilidade: entre(rnd, 3, 5), estrutura: entre(rnd, 3, 5) } };
}

async function loadPostos() {
  const cacheKey = 'postosCache-v2';
  state.erro = false;
  if (POSTOS.length) return;
  try { // 1º: arquivo local gerado por baixar-postos.mjs (instantâneo e sem depender do Overpass)
    const r = await fetch('postos.json');
    if (r.ok) { const raw = await r.json(); if (raw.length) { POSTOS = raw.map(completar); state.exemplo = false; return; } }
  } catch {}
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (c && c.data?.length && Date.now() - c.timestamp < 864e5) { POSTOS = c.data; state.exemplo = false; return; }
  } catch {}
  try {
    const json = await buscarOverpass(`[out:json][timeout:25];nwr["amenity"="fuel"](${BH_BBOX});out center qt;`);
    const lista = json.elements.filter(el => (el.lat ?? el.center?.lat) != null).map(el => {
      const tg = el.tags || {};
      return completar({ id: el.type[0] + el.id, nome: tg.name || tg.brand || 'Posto sem nome',
        bairro: tg['addr:suburb'] || '', via: tg['addr:street'] || '', lat: el.lat ?? el.center.lat, lng: el.lon ?? el.center.lon });
    });
    if (!lista.length) throw new Error('Overpass não retornou postos');
    POSTOS = lista; state.exemplo = false;
    localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data: lista }));
  } catch (e) { console.error('Usando postos de exemplo:', e); POSTOS = EXEMPLOS; state.exemplo = true; }
}
const RANKINGS = {
  rapidos:   { nome: 'Mais rápidos',        ordem: p => p.notas.agilidade },
  custo:     { nome: 'Melhor custo-benefício', ordem: p => (p.notas.preco + p.notas.atendimento) / 2 },
  destaques: { nome: 'Destaques da semana',  ordem: p => media(p) * Math.log(p.votos + 1) },
};

/* ===== ESTADO ===== */
const $ = (s, el = document) => el.querySelector(s);
const state = { busca: '', via: '', ranking: 'destaques', map: null, markers: [], userLocation: null, near: false, erro: false };
const salvas = JSON.parse(localStorage.getItem('avaliacoes') || '{}'); // {idPosto: [{notas}]}

function notasAtuais(p) { // média móvel: base + avaliações feitas neste navegador
  if (p._ok) return p.notas; // já combinado por comMedias
  const extra = salvas[p.id] || [], n = p.votos + extra.length, r = {};
  CATEGORIAS.forEach(c => r[c.id] = (p.notas[c.id] * p.votos + extra.reduce((s, e) => s + e[c.id], 0)) / n);
  return r;
}
function media(p) { const n = notasAtuais(p); return CATEGORIAS.reduce((s, c) => s + n[c.id], 0) / 4; }
const fmt = n => n.toFixed(1).replace('.', ',');
const reais = n => 'R$ ' + n.toFixed(2).replace('.', ',');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const VIA_CHAVES = { 'Av. do Contorno': 'contorno', 'Av. Antônio Carlos': 'antonio carlos', 'Av. Cristiano Machado': 'cristiano machado' };
const comMedias = p => ({ ...p, notas: notasAtuais(p), votos: p.votos + (salvas[p.id] || []).length, _ok: true });
const local = p => [p.bairro, p.via].filter(Boolean).join(' · ') || 'Endereço não informado';

/* ===== HOME ===== */
function postosFiltrados() {
  const q = norm(state.busca), chave = VIA_CHAVES[state.via];
  const base = POSTOS.map(comMedias).filter(p => (!chave || norm(p.via).includes(chave)) && norm(`${p.nome} ${p.bairro} ${p.via}`).includes(q));
  if (state.near && state.userLocation) {
    base.forEach(p => p.dist = distanciaM(...state.userLocation, p.lat, p.lng));
    return base.sort((a, b) => a.dist - b.dist);
  }
  return base.sort((a, b) => RANKINGS[state.ranking].ordem(b) - RANKINGS[state.ranking].ordem(a));
}
function renderChips() {
  $('#vias').innerHTML = ['', ...VIAS].map(v => `<button class="chip" aria-pressed="${state.via === v}" data-via="${v}">${v || 'Todas as vias'}</button>`).join('');
  $('#ranking').innerHTML = Object.entries(RANKINGS).map(([k, r]) => `<button class="aba" role="tab" aria-selected="${state.ranking === k}" data-rank="${k}">${r.nome}</button>`).join('');
}
function renderLista() {
  const alvo = $('#lista');
  if (!POSTOS.length) {
    alvo.innerHTML = state.erro
      ? '<div class="vazio">Não foi possível carregar os postos. Verifique a conexão.<br><button class="chip" id="recarregar">Tentar de novo</button></div>'
      : '<div class="card skeleton"></div>'.repeat(4);
    return;
  }
  const lista = postosFiltrados();
  if (!lista.length) { alvo.innerHTML = '<p class="vazio">Nenhum posto encontrado. Tente outro bairro ou limpe os filtros.</p>'; renderMarcadores([]); return; }
  const visiveis = lista.slice(0, 40), minPreco = Math.min(...visiveis.map(p => p.gasolina));
  alvo.innerHTML = (state.exemplo ? AVISO_EX : '') + visiveis.map((p, i) => `
    <a class="card" href="#posto/${p.id}">
      <span class="pos">${i + 1}</span>
      <h3>${esc(p.nome)}</h3>
      <span class="nota-grande">${fmt(media(p))}<small>${p.votos} avaliações</small></span>
      <span class="sub">${esc(local(p))} · Gasolina ${reais(p.gasolina)}${p.dist != null ? ' · ' + (p.dist / 1000).toFixed(1).replace('.', ',') + ' km' : ''}</span>
      ${p.gasolina === minPreco ? '<span class="badge">Preço mais baixo</span>' : ''}
      <div class="mini-bars">${CATEGORIAS.map(c => `<div class="mini-bar"><span>${c.nome}</span><div class="trilho"><b style="width:${p.notas[c.id] / 5 * 100}%"></b></div><span>${fmt(p.notas[c.id])}</span></div>`).join('')}</div>
    </a>`).join('') + (lista.length > 40 ? `<p class="vazio">Mostrando 40 de ${lista.length}. Use a busca ou os filtros para refinar.</p>` : '');
  renderMarcadores(visiveis);
}

function iniciarMapa() {
  if (state.map) return;
  state.map = L.map('map').setView([-19.9, -43.94], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(state.map);
}
function renderMarcadores(lista) {
  if (!state.map) return;
  state.markers.forEach(m => m.remove());
  state.markers = lista.map(p => L.marker([p.lat, p.lng]).addTo(state.map)
    .bindPopup(`<b>${esc(p.nome)}</b><br>Nota ${fmt(media(p))}<br><a href="#posto/${p.id}">Ver detalhes</a>`));
}

/* ===== DETALHES + AVALIAÇÃO ===== */
function distanciaM(a, b, c, d) { // Haversine
  const R = 6371000, r = x => x * Math.PI / 180, dLat = r(c - a), dLng = r(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function renderPosto(id) {
  const p = POSTOS.find(x => String(x.id) === id), el = $('#view-posto');
  if (!p) { el.innerHTML = '<a class="voltar" href="#home">← Voltar</a><p class="vazio">Posto não encontrado.</p>'; return; }
  const n = notasAtuais(p), escolha = {};
  el.innerHTML = `
    <a class="voltar" href="#home">← Voltar</a>
    <div class="det-topo">
      <h1>${esc(p.nome)}</h1><p>${esc(local(p))}</p>
      <div class="placa"><div><small>Gasolina</small>${reais(p.gasolina)}</div><div><small>Etanol</small>${reais(p.etanol)}</div><div><small>Nota geral</small>${fmt(media(p))}</div></div>
    </div>
    <div class="painel"><h2>O que os motoristas dizem</h2>
      ${CATEGORIAS.map(c => `<div class="barra"><span>${c.nome}</span><i><b style="width:${n[c.id] / 5 * 100}%"></b></i><span>${fmt(n[c.id])}</span></div>`).join('')}
    </div>
    <div class="painel"><h2>Avalie este posto</h2>
      ${CATEGORIAS.map(c => `<div class="cat"><div class="cat-nome">${c.nome}</div><div class="cat-dica">${c.dica}</div>
        <div class="estrelas" role="radiogroup" aria-label="Nota de ${c.nome}" data-cat="${c.id}">
          ${[1, 2, 3, 4, 5].map(i => `<button type="button" class="estrela" role="radio" aria-checked="false" aria-label="${i} de 5" data-v="${i}">★</button>`).join('')}
        </div></div>`).join('')}
      ${DEMO_MODE ? '<label class="demo"><input type="checkbox" id="demo" checked> Modo demonstração (ignora a trava de GPS)</label>' : ''}
      <button class="botao" id="enviar" disabled>Enviar avaliação</button>
      <div id="aviso" role="status"></div>
    </div>`;
  el.querySelectorAll('.estrelas').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('.estrela'); if (!b) return;
    escolha[g.dataset.cat] = +b.dataset.v;
    g.querySelectorAll('.estrela').forEach(s => { const on = +s.dataset.v <= escolha[g.dataset.cat]; s.classList.toggle('on', on); s.setAttribute('aria-checked', +s.dataset.v === escolha[g.dataset.cat]); });
    $('#enviar').disabled = Object.keys(escolha).length < CATEGORIAS.length;
  }));
  $('#enviar').addEventListener('click', () => {
    const aviso = $('#aviso'), salvar = async () => {
      if (DEMO_MODE) {
        // Demo mode: store locally
        (salvas[p.id] ||= []).push(escolha);
        localStorage.setItem('avaliacoes', JSON.stringify(salvas));
        renderPosto(p.id);
        $('#aviso').outerHTML = '<div class="aviso ok" role="status">Avaliação enviada (modo demonstração). Obrigado por ajudar outros motoristas!</div>';
        return;
      }
      // Production: write to Firestore with transaction
      const user = auth?.currentUser;
      if (!user) {
        aviso.className = 'aviso';
        aviso.textContent = 'Entre na sua conta para enviar a avaliação.';
        showLogin($('#enviar'), salvar); // depois do login, envia com as estrelas já escolhidas
        return;
      }
      try {
        const postoRef = doc(db, 'postos', String(p.id));
        const avalRef = doc(db, 'postos', String(p.id), 'avaliacoes', user.uid);
        await runTransaction(db, async (t) => {
          const snap = await t.get(postoRef);
          const d = snap.exists() ? snap.data() : { votos: 0, notas: {} };
          const antes = d.votos || 0, depois = antes + 1, notas = {};
          CATEGORIAS.forEach(c => notas[c.id] = (((d.notas?.[c.id] ?? 0) * antes) + escolha[c.id]) / depois);
          t.set(avalRef, { ...escolha, uid: user.uid, timestamp: serverTimestamp() });
          t.set(postoRef, { votos: depois, notas }, { merge: true });
        });
        renderPosto(p.id);
        $('#aviso').outerHTML = '<div class="aviso ok" role="status">Avaliação enviada com sucesso.</div>';
      } catch (e) {
        console.error(e);
        aviso.className = 'aviso erro';
        aviso.textContent = e.code === 'permission-denied' ? 'Não foi possível salvar: você já avaliou este posto ou as regras do Firestore ainda não foram publicadas.' : 'Erro ao enviar avaliação. Tente novamente.';
      }
    };
    if ($('#demo')?.checked) return salvar();
    if (!navigator.geolocation) return aviso.outerHTML = '<div class="aviso erro">Seu navegador não permite localização. Ative o modo demonstração.</div>';
    aviso.className = 'aviso'; aviso.textContent = 'Verificando sua localização…';
    navigator.geolocation.getCurrentPosition(pos => {
      const d = distanciaM(pos.coords.latitude, pos.coords.longitude, p.lat, p.lng);
      if (d <= 300) salvar(); else { aviso.className = 'aviso erro'; aviso.textContent = `Você está a ${Math.round(d)} m do posto. Chegue a até 300 m para avaliar.`; }
    }, () => { aviso.className = 'aviso erro'; aviso.textContent = 'Não foi possível obter sua localização. Permita o acesso ou use o modo demonstração.'; });
  });
}

/* ===== CHATBOT (respostas por palavras-chave; troque por API depois) ===== */
const SUGESTOES = ['Qual o posto mais rápido?', 'Onde é mais barato?', 'Melhor posto na Antônio Carlos'];
function link(p) { return `<a href="#posto/${p.id}">${esc(p.nome)}</a>`; }
function responder(t) {
  t = t.toLowerCase(); const todos = POSTOS.map(comMedias);
  if (!todos.length) return 'Ainda estou carregando os postos. Tente de novo em alguns segundos.';
  const topo = (fn, lista = todos) => [...lista].sort((a, b) => fn(b) - fn(a))[0];
  const via = VIAS.find(v => norm(t).includes(VIA_CHAVES[v]));
  if (via) {
    const daVia = todos.filter(x => norm(x.via).includes(VIA_CHAVES[via]));
    if (!daVia.length) return `Não encontrei postos com endereço cadastrado na ${via}.`;
    const p = topo(media, daVia); return `Na ${via}, o melhor avaliado é o ${link(p)}, com nota ${fmt(media(p))}.`;
  }
  if (/r[aá]pid|fila|rapidez|agilidade/.test(t)) { const p = topo(x => x.notas.agilidade); return `O mais ágil é o ${link(p)} (agilidade ${fmt(p.notas.agilidade)}).`; }
  if (/barat|pre[cç]o|econom|custo/.test(t)) { const p = [...todos].sort((a, b) => a.gasolina - b.gasolina)[0]; return `O menor preço de gasolina hoje é no ${link(p)}: ${reais(p.gasolina)}.`; }
  if (/melhor|destaque|recomend/.test(t)) { const p = topo(x => RANKINGS.destaques.ordem({ ...x, notas: x.notas })); return `O destaque da semana é o ${link(p)}, nota ${fmt(media(p))}.`; }
  return 'Posso ajudar a achar o posto mais rápido, mais barato ou o melhor de uma avenida. Tente uma das sugestões abaixo.';
}
function addMsg(html, quem) {
  const d = document.createElement('div'); d.className = 'msg ' + quem;
  if (quem === 'eu') d.textContent = html; else d.innerHTML = html;
  $('#chat').append(d); $('#chat').scrollTop = 1e6;
}
function enviarChat(texto) { if (!texto.trim()) return; addMsg(texto, 'eu'); setTimeout(() => addMsg(responder(texto), 'bot'), 350); }

/* ===== ROTEADOR E EVENTOS ===== */
async function rota() {
  const [tela, id] = (location.hash.slice(1) || 'home').split('/');
  const nome = ['home', 'posto', 'chatbot'].includes(tela) ? tela : 'home';
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + nome);
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('ativo', a.dataset.nav === (nome === 'posto' ? 'home' : nome)));
  window.scrollTo(0, 0);
  if (nome === 'home') { iniciarMapa(); renderLista(); await loadPostos(); renderLista(); setTimeout(() => state.map.invalidateSize(), 50); }
  if (nome === 'posto') { await loadPostos(); renderPosto(id); }
  if (nome === 'chatbot') loadPostos();
}

$('#busca').addEventListener('input', e => { state.busca = e.target.value; renderLista(); });
$('#vias').addEventListener('click', e => { const b = e.target.closest('[data-via]'); if (b) { state.via = b.dataset.via; renderChips(); renderLista(); } });
$('#ranking').addEventListener('click', e => { const b = e.target.closest('[data-rank]'); if (b) { state.ranking = b.dataset.rank; renderChips(); renderLista(); } });
$('#chat-form').addEventListener('submit', e => { e.preventDefault(); enviarChat($('#chat-input').value); $('#chat-input').value = ''; });
$('#sugestoes').innerHTML = SUGESTOES.map(s => `<button class="chip">${s}</button>`).join('');
$('#sugestoes').addEventListener('click', e => { if (e.target.matches('.chip')) enviarChat(e.target.textContent); });
addMsg('Olá! Sou o assistente do Bomba Certa. Pergunte sobre preço, agilidade ou postos de uma avenida.', 'bot');
$('#lista').addEventListener('click', e => { if (e.target.id === 'recarregar') { POSTOS = []; localStorage.removeItem('postosCache-v2'); rota(); } });
$('#near-btn').addEventListener('click', () => {
  if (state.near) { state.near = false; return renderLista(); }
  navigator.geolocation?.getCurrentPosition(pos => {
    state.userLocation = [pos.coords.latitude, pos.coords.longitude]; state.near = true;
    state.map.setView(state.userLocation, 14); renderLista();
  }, () => $('#lista').insertAdjacentHTML('afterbegin', '<p class="aviso erro">Não foi possível obter sua localização. Permita o acesso no navegador e tente de novo.</p>'));
});
const temaAtual = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function icones() { const t = $('#theme-toggle'); t.innerHTML = `<i data-lucide="${temaAtual() === 'dark' ? 'sun' : 'moon'}"></i>`; window.lucide?.createIcons(); }
$('#theme-toggle').addEventListener('click', () => {
  const novo = temaAtual() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = novo; localStorage.setItem('theme', novo); icones();
});
icones();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('service-worker.js').catch(console.warn);
window.addEventListener('hashchange', rota);
renderChips(); rota();


/* ==== G1: ligação do login ==== */
const overlayLogin = $('#overlay-login');
function atualizarUsuario(user) {
  currentUser = user;
  $('#user-nome').hidden = !user; $('#btn-sair').hidden = !user; $('#btn-login').hidden = !!user;
  $('#user-nome').textContent = user ? (user.displayName || user.email || '') : '';
}
if (auth) onAuthStateChanged(auth, atualizarUsuario);
$('#btn-login').addEventListener('click', e => showLogin(e.currentTarget));
$('#btn-sair').addEventListener('click', () => auth && signOut(auth));
$('#login-fechar').addEventListener('click', hideLogin);
overlayLogin.addEventListener('click', e => { if (e.target === overlayLogin) hideLogin(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlayLogin.hidden) hideLogin(); });
$('#login-toggle').addEventListener('click', () => { _loginMode = _loginMode === 'login' ? 'criar' : 'login'; atualizarLoginMode(); });
async function autenticar(acao) {
  try { await acao(); const cb = _onLoginSuccess; _onLoginSuccess = null; hideLogin(); cb?.(); }
  catch (e) { console.error(e); mostrarErroLogin(traduzirErro(e)); }
}
$('#login-form').addEventListener('submit', e => {
  e.preventDefault();
  const email = $('#login-email').value.trim(), senha = $('#login-senha').value;
  autenticar(() => (_loginMode === 'criar' ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, email, senha));
});
$('#login-google').addEventListener('click', () => autenticar(() => signInWithPopup(auth, new GoogleAuthProvider())));

/* ==== G4: banner de modo ==== */
function renderBanner() {
  $('#banner-modo').hidden = false;
  $('#banner-text').textContent = DEMO_MODE
    ? 'Modo demonstração: avaliações salvas só neste navegador. Notas e preços são simulados.'
    : 'Modo real: avaliações vão para o Firestore (login obrigatório). Notas exibidas ainda são simuladas.';
  const b = $('#toggle-modo');
  b.hidden = !DEMO_MODE_HOST;               // alternar só faz sentido em localhost
  b.textContent = DEMO_MODE ? 'Mudar para modo real' : 'Voltar à demonstração';
  b.setAttribute('aria-pressed', String(!DEMO_MODE));
}
$('#toggle-modo').addEventListener('click', () => { setUserMode(DEMO_MODE); location.reload(); });
renderBanner();
