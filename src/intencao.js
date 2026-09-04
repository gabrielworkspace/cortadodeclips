'use strict';
/**
 * Le o que a pessoa escreveu que quer nos cortes e transforma em pesos.
 *
 * Isso nao e enfeite: o texto muda de verdade quais trechos ganham nota. Quem
 * escreve "os momentos mais engraçados" recebe cortes diferentes de quem
 * escreve "quando ele abre a carta rara" - e as palavras especificas que a
 * pessoa citar viram termos de busca dentro da transcricao.
 */

// ---------------------------------------------------------------- intencoes

/**
 * Cada intencao conhecida traz: como reconhecer no texto, qual perfil de
 * analise usar, e o que ganha ponto extra.
 */
const INTENCOES = [
  {
    id: 'engracado',
    nome: 'Momentos engraçados',
    gatilhos: /\bengra[cç]ad|\bcomic|\bhumor|\brisad|\brindo|\brir\b|\bpiada|\bzoeir|\bmeme|\bkk+\b|\bdivertid/i,
    perfil: 'reacao',
    termos: [
      /\bkk+\b/i, /\bhaha+\b/i, /\brindo\b/i, /\brisada\b/i, /\bque isso\b/i,
      /\bmorri\b/i, /\bchorando de rir\b/i, /\bpalha[cç]ad/i, /\bzoeira\b/i,
      /\bmano do c[eé]u\b/i, /\bque viagem\b/i, /\bpirou\b/i, /\bdoido\b/i,
      /\bvergonha alheia\b/i, /\bdeu ruim\b/i, /\bse ferrou\b/i,
    ],
    peso: 9,
  },
  {
    id: 'revelacao',
    nome: 'Revelações e aberturas',
    gatilhos: /\babertur|\babrind|\babrir|\brevela|\bsorteio|\bcarta|\bpack|\bunbox|\bovo\b|\bpet\b|\braro|\blend[aá]ri|\bpr[eê]mio/i,
    perfil: 'reacao',
    termos: [
      /\bolha (o que|isso|s[oó])\b/i, /\bveio\b/i, /\bsaiu\b/i, /\bconsegui\b/i,
      /\bpeguei\b/i, /\brar[oa]\b/i, /\blend[aá]ri[oa]\b/i, /\bsecret[oa]\b/i,
      /\bn[aã]o acredito\b/i, /\bfinalmente\b/i, /\bprimeira vez\b/i,
      /\bmuta[cç][aã]o\b/i, /\bbrilhando\b/i, /\bdourad/i,
    ],
    peso: 10,
  },
  {
    id: 'tensao',
    nome: 'Momentos de tensão',
    gatilhos: /\btens[aã]o|\bnervos|\bsusto|\bmedo|\bperigo|\bquase|\bapert|\bdesesper|\bcorrid|\bfug/i,
    perfil: 'reacao',
    termos: [
      /\bquase\b/i, /\bcorre\b/i, /\bfoge\b/i, /\bmeu deus\b/i, /\bsocorro\b/i,
      /\bn[aã]o vai dar\b/i, /\bt[oô] morrendo\b/i, /\bperdi\b/i, /\bsalvou\b/i,
      /\bno limite\b/i, /\bultimo segundo\b/i, /\b[uú]ltimo segundo\b/i,
    ],
    peso: 9,
  },
  {
    id: 'ensinar',
    nome: 'Explicações e dicas',
    gatilhos: /\bensin|\bexplic|\bdica|\btutorial|\bcomo faz|\bpasso a passo|\baprend|\bestrat[eé]gi/i,
    perfil: 'fala',
    termos: [
      /\bo jeito certo\b/i, /\ba dica\b/i, /\bvoc[eê] precisa\b/i, /\bpasso\b/i,
      /\bfun[cç]iona assim\b/i, /\bpra fazer\b/i, /\bo truque\b/i, /\bmacete\b/i,
      /\bnunca fa[cç]a\b/i, /\bo erro\b/i,
    ],
    peso: 8,
  },
  {
    id: 'viral',
    nome: 'Mais chance de viralizar',
    gatilhos: /\bviral|\bviraliz|\bengaj|\bmelhores momentos|\bmelhor moment|\bbombar|\bexplodir|\bcrescer/i,
    perfil: 'auto',
    termos: [],
    peso: 0,     // nao empurra tema nenhum: e o comportamento padrao do sistema
  },
];

// Palavras genericas que nao servem como termo de busca
const VAZIAS = new Set([
  'quero','queria','gostaria','preciso','melhores','melhor','momentos','momento',
  'partes','parte','trechos','trecho','cortes','corte','video','videos','mais','muito',
  'para','pra','que','com','dos','das','uma','onde','quando','ele','ela','sobre','tudo',
  'coisa','coisas','fazer','tenha','tem','seja','ser','bem','todo','toda','pega','pegue',
  'foco','focado','focar','deixa','deixe','faz','faça','faca','pode','vai','pessoas','galera',
  'aparece','aparecer','acontece','acontecer','fica','ficar','tipo','estilo','forma','jeito',
]);

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Interpreta a descricao livre.
 * @param {string} texto  o que a pessoa escreveu
 * @returns {object} { perfil, intencoes, termos, resumo }
 */
function interpretar(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return { perfil: 'auto', intencoes: [], termos: [], resumo: '' };

  const normal = semAcento(bruto.toLowerCase());

  // 1. quais intencoes conhecidas aparecem
  const achadas = INTENCOES.filter((i) => i.gatilhos.test(bruto) || i.gatilhos.test(normal));

  // 2. o perfil vem da intencao mais especifica (viral nao decide nada)
  const decisiva = achadas.find((i) => i.id !== 'viral');
  const perfil = decisiva ? decisiva.perfil : 'auto';

  // 3. termos que a propria pessoa citou viram busca dentro da transcricao.
  //    Se ela escreve "quando aparece o dragao dourado", "dragao" e "dourado"
  //    passam a valer ponto nos trechos que falam disso.
  const termos = [];
  for (const p of bruto.toLowerCase().match(/[a-zà-ú0-9]{4,}/gi) || []) {
    const limpo = semAcento(p);
    if (VAZIAS.has(limpo) || VAZIAS.has(p)) continue;
    if (achadas.some((i) => i.gatilhos.test(p))) continue;   // ja virou intencao
    if (!termos.includes(p)) termos.push(p);
  }

  return {
    perfil,
    intencoes: achadas.map((i) => ({ id: i.id, nome: i.nome, peso: i.peso, termos: i.termos })),
    termos: termos.slice(0, 12),
    resumo: achadas.length
      ? achadas.map((i) => i.nome).join(' + ')
      : (termos.length ? 'Trechos sobre: ' + termos.slice(0, 4).join(', ') : 'Melhores momentos'),
  };
}

/**
 * Quanto um trecho combina com o que foi pedido.
 * @returns {object} { pontos, motivos }
 */
function combinar(textoDoCorte, intencao) {
  if (!intencao) return { pontos: 0, motivos: [] };

  const texto = String(textoDoCorte || '');
  const normal = semAcento(texto.toLowerCase());
  const motivos = [];
  let pontos = 0;

  for (const i of intencao.intencoes || []) {
    if (!i.termos || !i.termos.length) continue;
    let acertos = 0;
    for (const re of i.termos) if (re.test(texto)) acertos++;
    if (acertos > 0) {
      const p = Math.min(i.peso, 3 + acertos * 3);
      pontos += p;
      motivos.push({ fator: i.nome.toLowerCase(), pontos: p });
    }
  }

  // Termos que a pessoa escreveu, encontrados na fala do trecho
  let citados = 0;
  for (const t of intencao.termos || []) {
    if (normal.indexOf(semAcento(t)) >= 0) citados++;
  }
  if (citados > 0) {
    const p = Math.min(14, citados * 5);
    pontos += p;
    motivos.push({ fator: 'fala do que voce pediu', pontos: p });
  }

  return { pontos, motivos };
}

module.exports = { interpretar, combinar, INTENCOES };
