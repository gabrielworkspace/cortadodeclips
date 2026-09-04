'use strict';
/**
 * Gera a copy do post: titulo chamativo, legenda pronta e hashtags.
 *
 * A regra que guia tudo aqui: o titulo nao e um resumo do que foi dito, e uma
 * promessa. Ele precisa criar uma lacuna que so fecha assistindo. Por isso a
 * gente extrai do trecho o que ele tem de mais forte - um numero absurdo, um
 * superlativo, uma reacao - e monta a frase em cima disso.
 */

// ---------------------------------------------------------------- vocabulario

const PARADA = new Set([
  'que','para','com','uma','como','mais','dos','das','por','isso','aqui','esse','essa',
  'você','voce','então','entao','muito','tem','não','nao','sim','vai','são','sao','pra',
  'pro','seu','sua','meu','minha','ele','ela','nos','nós','tudo','todo','toda','ser','ter',
  'fazer','está','esta','estão','foi','era','uns','umas','quando','porque','depois','agora',
  'gente','coisa','coisas','fica','ficar','pode','vamos','sobre','cada','onde','aqui','deu',
  'vou','vai','tá','ta','né','tipo','assim','cara','mano','velho','galera','pessoal','olha',
  'aí','ai','lá','la','bem','já','ja','só','so','até','ate','mesmo','ainda','dele','dela',
  'pelo','pela','nesse','nessa','neste','nesta','tinha','tava','estava','fui','peguei',
]);

// Palavras que costumam ser o "objeto" do corte em video de jogo
const SUBSTANTIVO_FORTE = /\b(ovo|ovos|pet|pets|bicho|item|itens|skin|arma|carro|casa|mapa|fase|chefe|boss|bau|ba[uú]|caixa|drop|premio|pr[eê]mio|sorteio|conta|level|n[ií]vel|dinheiro|robux|moeda|moedas|diamante|diamantes|lend[aá]rio|mutacao|muta[cç][aã]o)\b/i;

const SUPERLATIVO = /\b(mais raro|mais caro|mais forte|mais fraco|maior|menor|melhor|pior|[uú]nico|primeiro|[uú]ltimo|lend[aá]rio|impossivel|imposs[ií]vel|secreto|escondido|proibido)\b/i;

const REACAO = /\b(n[aã]o acredito|meu deus|caraca|caramba|nossa|olha isso|olha o que|que isso|surreal|absurdo|insano|inacredit[aá]vel|impressionante|chocante|assustador|louco|bizarro)\b/i;

const CONQUISTA = /\b(consegui|peguei|ganhei|achei|encontrei|abri|completei|terminei|zerei|bati|quebrei o recorde|finalmente)\b/i;

const PERDA = /\b(perdi|quebrou|falhei|errei|acabou|estraguei|derrotad|morri|deu ruim)\b/i;

// Emojis por clima do trecho - um so, no fim. Mais que isso vira poluicao.
const EMOJI = {
  choque: ['😱', '🤯', '😳'],
  dinheiro: ['🤑', '💰'],
  raro: ['🔥', '✨', '💎'],
  ruim: ['😭', '💀'],
  duvida: ['👀', '🤔'],
};

function umEmoji(clima) {
  const lista = EMOJI[clima] || EMOJI.choque;
  return lista[0];
}

// ---------------------------------------------------------------- extracao

/**
 * Numeros que impressionam, capturados COM a unidade: "45 mil quilos",
 * "1 milhão e 700". Numero solto sem unidade nao vira titulo - "700 e eu nao
 * acreditei" nao diz nada e ainda promete o que o video nao mostra.
 */
function extrairNumeros(texto) {
  const achados = [];
  const re = /\b(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(milh[oõ]es|milh[aã]o|mil|bilh[oõ]es|bilh[aã]o|k)?\s*(quilos?|kg|reais|robux|d[oó]lares|pontos?|%|por cento)?/gi;
  let m;
  while ((m = re.exec(texto))) {
    const escala = (m[2] || '').toLowerCase();
    const unidade = (m[3] || '').toLowerCase();
    if (!escala && !unidade) continue;          // sem escala nem unidade: descarta

    const n = Number(String(m[1]).replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
    if (!isFinite(n)) continue;

    let peso = n;
    if (/bilh/.test(escala)) peso = n * 1e9;
    else if (/milh/.test(escala)) peso = n * 1e6;
    else if (escala === 'mil' || escala === 'k') peso = n * 1e3;

    if (peso < 1000) continue;                   // abaixo disso nao impressiona
    achados.push({
      texto: m[0].replace(/\s+/g, ' ').trim(),
      peso,
      posicao: m.index,
    });
  }
  return achados.sort((a, b) => b.peso - a.peso);
}

/** Divide em frases e devolve as mais fortes, com a nota de cada uma. */
function frasesFortes(texto) {
  const cruas = String(texto || '').split(/(?<=[.!?])\s+/).filter((f) => f.trim().length > 12);
  const avaliadas = cruas.map((f) => {
    const limpa = limparFrase(f);
    let n = 0;
    if (extrairNumeros(limpa).length) n += 5;
    if (SUPERLATIVO.test(limpa)) n += 4;
    if (REACAO.test(limpa)) n += 4;
    if (CONQUISTA.test(limpa)) n += 3;
    if (PERDA.test(limpa)) n += 3;
    if (SUBSTANTIVO_FORTE.test(limpa)) n += 2;
    if (/[!?]/.test(f)) n += 2;
    // tamanho de titulo: nem palavra solta, nem paragrafo
    const tam = limpa.length;
    if (tam >= 22 && tam <= 72) n += 3;
    else if (tam > 110) n -= 3;
    return { texto: limpa, nota: n };
  });
  return avaliadas.filter((f) => f.texto.length >= 15).sort((a, b) => b.nota - a.nota);
}

// ---------------------------------------------------------------- gancho de tela

/**
 * O gancho que fica QUEIMADO nos primeiros segundos do video.
 *
 * Ele nao e um resumo nem uma frase da fala - e uma promessa. O publico aqui
 * tem de 8 a 16 anos e rola o feed rapido: o que faz o dedo parar e uma
 * LACUNA (algo que so fecha assistindo) grudada num objeto concreto que a
 * crianca reconhece (ovo, pet, carta, robux). Frase copiada da fala nao
 * funciona porque ninguem fala em gancho: "IHIHI VOCE E LOUCO" nao promete nada.
 *
 * Regra que nao se quebra: so promete o que o trecho realmente entrega.
 */

// Objetos que o publico desse nicho reconhece de cara
const OBJETOS = [
  [/\bovos?\b/i, 'OVO'],
  [/\bpets?\b/i, 'PET'],
  [/\bbrainrots?\b/i, 'BRAINROT'],
  [/\bcartas?\b/i, 'CARTA'],
  [/\bpacks?\b/i, 'PACK'],
  [/\bcaixas?\b/i, 'CAIXA'],
  [/\bba[uú]\b/i, 'BAÚ'],
  [/\bskins?\b/i, 'SKIN'],
  [/\bbichos?\b/i, 'BICHO'],
  [/\bmuta[cç][aã]o\b/i, 'MUTAÇÃO'],
  [/\brobux\b/i, 'ROBUX'],
  [/\bitens?\b/i, 'ITEM'],
  [/\bpr[eê]mios?\b/i, 'PRÊMIO'],
];

function objetoDoTrecho(texto) {
  for (const [re, nome] of OBJETOS) if (re.test(texto)) return nome;
  return null;
}

// Sinais de que algo ACONTECEU (a lacuna tem o que fechar)
const ACONTECEU = /\b(veio|saiu|consegui|peguei|ganhei|abri|achei|encontrei|apareceu|caiu|deu)\b/i;
const DEU_RUIM = /\b(perdi|perdeu|deu ruim|se ferrou|era ruim|n[aã]o valeu|pior|lixo|fraco)\b/i;
const RARIDADE = /\b(mais rar[oa]|rar[oa]|lend[aá]ri[oa]|secret[oa]|m[ií]tic[oa]|exclusiv[oa]|melhor do jogo|mais car[oa])\b/i;
const APOSTA = /\b(chut\w*|adivinh\w*|aposta\w*|quanto (voc[eê]|ser[aá]|acha)|voc[eê]s? acha|o que (voc[eê]s? )?acha)\b/i;

/**
 * Varias formas de dizer a mesma coisa. Postar 8 cortes com o gancho
 * identico queima o formato - o feed repete e a pessoa passa direto.
 * A escolha e por conteudo (nao sorteada) pra o mesmo trecho dar sempre
 * o mesmo gancho quando reprocessado.
 */
const VARIANTES = {
  aposta: ['CHUTA O QUE VEIO NESSE {OBJ}', 'ADIVINHA O QUE SAIU DESSE {OBJ}', 'O QUE VOCÊ ACHA QUE VEIO? 👀'],
  apostaSemObj: ['CHUTA O QUE VEIO 👀', 'ADIVINHA O QUE SAIU 👀', 'VOCÊ NÃO VAI ACERTAR 👀'],
  numero: ['{OBJ} DE {NUM} 🤯', 'GASTEI {NUM} NESSE {OBJ} 😱', '{NUM} EM UM {OBJ} SÓ 🤯'],
  numeroSemObj: ['{NUM}?! OLHA ISSO 🤯', 'OLHA ESSE {NUM} 😱'],
  raro: ['O {OBJ} MAIS RARO DO JOGO 🔥', 'ESSE {OBJ} É QUASE IMPOSSÍVEL 🔥', 'FINALMENTE ESSE {OBJ} 🔥'],
  raroSemObj: ['ACHEI O MAIS RARO 🔥', 'ESSE É QUASE IMPOSSÍVEL 🔥'],
  ruim: ['OLHA O QUE VEIO NESSE {OBJ} 😭', 'ABRI O {OBJ} E DEU RUIM 😭', 'NÃO ERA ISSO QUE EU QUERIA 😭'],
  ruimSemObj: ['DEU MUITO RUIM 😭', 'NÃO ERA ISSO QUE EU QUERIA 😭'],
  veio: ['OLHA O QUE VEIO NESSE {OBJ} 😱', 'ABRI O {OBJ} E OLHA ISSO 😱', 'ESPERA PRA VER ESSE {OBJ} 😱'],
  temObj: ['ESSE {OBJ} ME SURPREENDEU 😱', 'PRECISA VER ESSE {OBJ} 👀', 'OLHA SÓ ESSE {OBJ} 😱'],
  generico: ['OLHA O QUE ACONTECEU 😱', 'ESPERA PRA VER ISSO 👀', 'NÃO ACREDITEI NISSO 😱'],
};

/** Escolhe sempre a mesma variante pro mesmo trecho, mas espalha entre trechos. */
function escolherVariante(lista, semente) {
  let h = 0;
  const s = String(semente || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return lista[h % lista.length];
}

/**
 * @param {object} corte  { texto, inicio, ... }
 * @returns {string} gancho curto pronto pra queimar na tela
 */
function gerarGanchoDeTela(corte) {
  const texto = String(corte.texto || '');
  const obj = objetoDoTrecho(texto);
  const numeros = extrairNumeros(texto);
  const numero = numeros.length ? numeros[0].texto.toUpperCase().replace(/\s+/g, ' ') : null;

  // A semente mistura o inicio do trecho com o texto: trechos diferentes
  // caem em variantes diferentes, e o mesmo trecho e sempre igual.
  const semente = String(corte.inicio || 0) + '|' + texto.slice(0, 60);
  const montar = (chave) => escolherVariante(VARIANTES[chave], semente)
    .replace('{OBJ}', obj || '')
    .replace('{NUM}', numero || '')
    .replace(/\s+/g, ' ')
    .trim();

  // Ordem de prioridade = ordem de quanto cada estrutura segura o dedo.
  // Cada uma so entra se o trecho REALMENTE tem o material.

  // 1. Aposta: puxa comentario e faz esperar a resposta - o melhor pra retencao
  if (APOSTA.test(texto)) return montar(obj ? 'aposta' : 'apostaSemObj');

  // 2. Numero absurdo: choque imediato e concreto
  if (numero) return montar(obj ? 'numero' : 'numeroSemObj');

  // 3. Raridade: o que essa faixa etaria mais persegue no jogo
  if (RARIDADE.test(texto)) return montar(obj ? 'raro' : 'raroSemObj');

  // 4. Deu ruim: frustracao diverte e prende tanto quanto a vitoria
  if (DEU_RUIM.test(texto)) return montar(obj ? 'ruim' : 'ruimSemObj');

  // 5. Revelacao: a lacuna classica - so fecha assistindo
  if (ACONTECEU.test(texto) && obj) return montar('veio');
  if (obj) return montar('temObj');
  if (ACONTECEU.test(texto)) return montar('generico');

  // 6. Rede de seguranca: a frase mais forte do trecho, limpa e curta.
  //    Pior que um template, melhor que nada - e nunca mente.
  const fortes = frasesFortes(texto);
  if (fortes.length) return cortarEm(fortes[0].texto, 46).toUpperCase() + ' 👀';
  return montar('generico');
}

/** O assunto do corte: a palavra concreta mais repetida. */
function extrairAssunto(texto) {
  const forte = texto.match(SUBSTANTIVO_FORTE);
  if (forte) return forte[0].toLowerCase();

  const freq = new Map();
  for (const t of (texto.toLowerCase().match(/[a-zà-ú]{4,}/g) || [])) {
    if (PARADA.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  const ordenado = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  return ordenado.length && ordenado[0][1] >= 2 ? ordenado[0][0] : null;
}

function detectarClima(texto) {
  if (PERDA.test(texto)) return 'ruim';
  if (/\b(r\$|reais|robux|dinheiro|milh|mil reais)\b/i.test(texto)) return 'dinheiro';
  if (SUPERLATIVO.test(texto)) return 'raro';
  if (/\?/.test(texto) || /\bser[aá] que\b/i.test(texto)) return 'duvida';
  return 'choque';
}

/** Limpa uma frase falada pra virar texto de post. */
function limparFrase(frase) {
  let t = String(frase || '');

  // interjeicao no comeco ("Ééé", "Ahn", "Uhum") vira ruido no titulo
  t = t.replace(/^\s*(é+|e+h+|a+h+|o+h+|u+h+m*|hum+|ahn+|ué+|eita|opa|hã+)[,.!?\s]+/i, '');

  t = t.replace(/\b(n[eé]|tipo|assim|sabe|entendeu|ent[aã]o|a[ií]|cara|mano|velho|olha s[oó])\b[,\s]*/gi, ' ')
    .replace(/^\s*(e|mas|ent[aã]o|a[ií]|porque|da[ií]|ou seja|que)\b[,\s]*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[,.;:\s]+/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
  return t;
}

// Terminar o titulo numa dessas deixa a frase pendurada: "...E FOI O MAIS RARO QUE EU"
const FIM_FRACO = /\s+(que|e|de|da|do|pra|para|com|em|no|na|o|a|um|uma|uns|umas|meu|minha|seu|sua|eu|ele|ela|mais|menos|muito|foi|era|tá|ta|vai|por|se|mas|ai|aí|to|tô)$/i;

function cortarEm(texto, limite) {
  let t = String(texto).replace(/[.,;:]+$/, '');
  if (t.length > limite) {
    const corte = t.slice(0, limite);
    const esp = corte.lastIndexOf(' ');
    t = (esp > limite * 0.5 ? corte.slice(0, esp) : corte);
  }
  // tira as palavras soltas do fim ate a frase parar de pedir continuacao
  let antes;
  do { antes = t; t = t.replace(FIM_FRACO, '').replace(/[.,;:]+$/, ''); } while (t !== antes);
  return t.trim();
}

/** Deixa as palavras-chave em caixa alta - no feed isso puxa o olho. */
function destacar(texto) {
  return texto.toUpperCase();
}

// ---------------------------------------------------------------- titulos

/**
 * Monta ate 3 titulos em estilos diferentes, pra pessoa escolher qual combina
 * mais com o canal dela. Todo template so entra se o material existir - titulo
 * com lacuna vazia fica pior que nao ter titulo.
 */
function gerarTitulos(corte) {
  const texto = corte.texto || '';
  const primeiraFrase = limparFrase((texto.split(/(?<=[.!?])\s+/)[0] || texto).trim());
  const numeros = extrairNumeros(texto);
  const assunto = extrairAssunto(texto);
  const clima = detectarClima(texto);
  const emoji = umEmoji(clima);

  const titulos = [];
  const jaTem = new Set();

  const adicionar = (t, estilo) => {
    const limpo = cortarEm(String(t).replace(/\s+/g, ' ').trim(), 68);
    const chave = limpo.toLowerCase().replace(/[^a-zà-ú0-9]/gi, '');
    if (limpo.length < 14 || jaTem.has(chave)) return;
    jaTem.add(chave);
    titulos.push({ texto: limpo, estilo });
  };

  const fortes = frasesFortes(texto);
  const melhor = fortes.length ? fortes[0].texto : primeiraFrase;

  // Regra que vale pra tudo aqui: o titulo so pode prometer o que o video
  // entrega. Por isso a base e SEMPRE uma frase que a pessoa realmente falou -
  // a gente so escolhe qual, encurta e emoldura. Montar frase com pecas soltas
  // gera titulo que mente (ex: "PEGUEI 4 MILHOES DE ROBUX" num video de ovo).

  // 1. GANCHO - a frase mais forte do trecho, limpa
  if (melhor) adicionar(destacar(melhor) + ' ' + emoji, 'gancho');

  // 2. NUMERO - so quando o numero veio com unidade E esta na mesma frase
  if (numeros.length) {
    const n = numeros[0];
    const fraseDoNumero = fortes.find((f) => f.texto.includes(n.texto));
    if (fraseDoNumero) {
      adicionar(destacar(fraseDoNumero.texto) + ' ' + emoji, 'numero');
    }
  }

  // 3. CURIOSIDADE - moldura que cria lacuna, sem inventar fato nenhum
  const segunda = fortes[1] ? fortes[1].texto : null;
  if (segunda) {
    adicionar('OLHA ISSO ' + emoji + ' ' + destacar(cortarEm(segunda, 52)), 'curiosidade');
  } else if (assunto && CONQUISTA.test(texto)) {
    adicionar(destacar('olha o que veio nesse ' + assunto) + ' ' + emoji, 'curiosidade');
  }

  // 4. PERGUNTA que o proprio video faz - puxa resposta nos comentarios,
  //    e comentario e um dos sinais que mais pesa na distribuicao
  const pergunta = (texto.match(/[^.!?]{15,80}\?/) || [])[0];
  if (pergunta) adicionar(destacar(limparFrase(pergunta)) + ' ' + umEmoji('duvida'), 'pergunta');

  // Rede de seguranca: nunca devolver lista vazia
  if (!titulos.length) {
    const base = cortarEm(limparFrase(texto), 60);
    adicionar(destacar(base || 'olha o que aconteceu') + ' ' + emoji, 'gancho');
  }

  return titulos.slice(0, 3);
}

// ---------------------------------------------------------------- hashtags

// Alcance amplo. Sozinhas nao entregam nada, mas ajudam na distribuicao inicial.
const ALCANCE = ['fyp', 'viral', 'foryou', 'paravoce'];

const JOGOS = [
  [/\brobl(o|ó)x\b/i, ['roblox', 'robloxbrasil']],
  [/\bminecraft\b/i, ['minecraft', 'minecraftbrasil']],
  [/\bfree ?fire\b/i, ['freefire', 'ff']],
  [/\bfortnite\b/i, ['fortnite']],
  [/\bgta\b/i, ['gta', 'gtarp']],
  [/\bvalorant\b/i, ['valorant']],
  [/\bcs ?2|counter/i, ['cs2']],
  [/\broube um\b/i, ['roubeum', 'stealabrainrot']],
  [/\bbrainrot\b/i, ['brainrot', 'stealabrainrot']],
];

/**
 * O TikTok le a legenda pra entender do que e o video. Entao a hashtag do
 * nicho vale mais que a generica - ela e o que faz o video cair pra quem
 * realmente assiste esse tipo de conteudo.
 */
function gerarHashtags(corte, contextoDoVideo) {
  const texto = (corte.texto || '') + ' ' + (contextoDoVideo || '');
  const tags = [];

  for (const [re, lista] of JOGOS) {
    if (re.test(texto)) { tags.push.apply(tags, lista); break; }
  }

  const assunto = extrairAssunto(corte.texto || '');
  if (assunto && assunto.length >= 4) tags.push(assunto.replace(/\s+/g, ''));

  for (const t of (corte.tags || [])) {
    const limpa = String(t).toLowerCase().replace(/[^a-zà-ú0-9]/gi, '');
    if (limpa.length >= 4 && !PARADA.has(limpa)) tags.push(limpa);
  }

  if (/\b(corte|clipe|live|stream)\b/i.test(texto)) tags.push('cortes');

  const unicas = [];
  for (const t of tags.concat(ALCANCE)) {
    if (t && !unicas.includes(t)) unicas.push(t);
    if (unicas.length >= 8) break;
  }
  return unicas;
}

// ---------------------------------------------------------------- legenda

/** Texto pronto pra colar no campo de descricao do TikTok/Reels. */
function montarLegenda(titulo, hashtags) {
  return titulo + '\n\n' + hashtags.map((h) => '#' + h).join(' ');
}

/**
 * Enriquece um corte com a copy do post.
 * @param {object} corte
 * @param {string} contextoDoVideo  nome do arquivo original, ajuda a achar o jogo
 */
function gerarCopy(corte, contextoDoVideo) {
  const titulos = gerarTitulos(corte);
  const hashtags = gerarHashtags(corte, contextoDoVideo);
  return {
    titulos,
    titulo: titulos[0].texto,
    hashtags,
    legenda: montarLegenda(titulos[0].texto, hashtags),
  };
}

module.exports = { gerarCopy, gerarTitulos, gerarHashtags, montarLegenda, gerarGanchoDeTela };
