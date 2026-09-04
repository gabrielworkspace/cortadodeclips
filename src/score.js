'use strict';
const { combinar: combinarIntencao } = require('./intencao');
/**
 * Encontra os trechos com mais cara de viral dentro da transcricao.
 *
 * A ideia: quebrar a fala em frases, montar todas as janelas de 28s a 62s que
 * comecam e terminam em frase inteira, e dar nota pra cada uma. A nota mistura
 * o que faz um corte segurar o dedo do espectador: gancho na abertura, curiosidade,
 * virada, numero, emocao, energia da voz e um fechamento que nao corta no meio.
 */

const MIN_DUR = 18;
const MAX_DUR = 62;
const DUR_IDEAL = 30;

// ---------------------------------------------------------------- lexicos pt-br

const GANCHO_ABERTURA = [
  /\bo segredo\b/i, /\ba verdade (e|é|sobre)\b/i, /\bningu[eé]m (te )?(conta|fala|ensina)\b/i,
  /\bpoucas pessoas sabem\b/i, /\ba maioria das pessoas\b/i, /\bo que ningu[eé]m (te )?(fala|conta)\b/i,
  /\bvoc[eê] (nunca|jamais)\b/i, /\bvoc[eê] sabia\b/i, /\bpresta aten[cç][aã]o\b/i,
  /\bescuta (isso|aqui|s[oó])\b/i, /\bolha (isso|s[oó]|bem)\b/i, /\bdeixa eu te (contar|falar|explicar)\b/i,
  /\bvou te (contar|falar|mostrar|ensinar|dar)\b/i, /\bisso (vai|aqui vai) te\b/i,
  /\bse voc[eê] (quer|tem|est[aá]|fizer|nunca|acha|acredita)\b/i, /\b(para|pare) de\b/i,
  /\bnunca mais\b/i, /\b(o|esse|o maior) erro\b/i, /\bo problema (e|é)\b/i,
  /\bacontece que\b/i, /\bimagina (s[oó]|que|voc[eê])\b/i, /\bsabe (por que|porque|qual|o que)\b/i,
  /\bexistem? (dois|tr[eê]s|quatro|cinco|\d+)\b/i, /\bpresta bem aten[cç][aã]o\b/i,
  /\ba real (e|é)\b/i, /\bvou ser (sincero|honesto|direto)\b/i, /\bningu[eé]m fala sobre\b/i,
  /\bmuita gente (n[aã]o|acha|pensa)\b/i, /\bo que aconteceu\b/i, /\bpode parecer (loucura|estranho)\b/i,
];

const CURIOSIDADE = [
  /\bsegredo\b/i, /\bverdade\b/i, /\bdescobri\b/i, /\bdescoberta\b/i, /\bningu[eé]m sabe\b/i,
  /\bpulo do gato\b/i, /\bmacete\b/i, /\btruque\b/i, /\batalho\b/i, /\bna real\b/i,
  /\bo que acontece (e|é)\b/i, /\brevela[cç][aã]o\b/i, /\bbastidor(es)?\b/i, /\bescondid[oa]\b/i,
];

const CONTRASTE = [
  /\bmas\b/i, /\bpor[eé]m\b/i, /\bs[oó] que\b/i, /\bna verdade\b/i, /\bacontece que\b/i,
  /\bo detalhe (e|é)\b/i, /\bo problema (e|é)\b/i, /\bacontece o seguinte\b/i, /\bem vez de\b/i,
  /\bao inv[eé]s de\b/i, /\bs[oó] que n[aã]o\b/i, /\bpelo contr[aá]rio\b/i,
];

const EMOCAO = [
  /\babsurdo\b/i, /\binsano\b/i, /\bimpressionante\b/i, /\bchocante\b/i, /\bincr[ií]vel\b/i,
  /\bgigante\b/i, /\bbrutal\b/i, /\bcaramba\b/i, /\bnossa\b/i, /\bs[eé]rio\b/i, /\bloucura\b/i,
  /\bbizarro\b/i, /\bsensacional\b/i, /\bperfeito\b/i, /\bmedo\b/i, /\bdor\b/i, /\braiva\b/i,
  /\bfracasso\b/i, /\bquebrei\b/i, /\bfundo do po[cç]o\b/i, /\bmudou (a )?minha vida\b/i,
  /\bnunca\b/i, /\bjamais\b/i, /\bsempre\b/i, /\bdemais\b/i, /\bmuito louco\b/i, /\bpesado\b/i,
];

const RESULTADO = [
  /\br\$\s?\d/i, /\b\d+\s?(mil|milh[oõ]es|milh[aã]o)\b/i, /\bfaturei\b/i, /\bganhei\b/i,
  /\blucro\b/i, /\bdobrei\b/i, /\btriplic\w+\b/i, /\b\d+\s?(%|por cento)\b/i, /\bresultado\b/i,
  /\bem \d+ (dias|semanas|meses|anos)\b/i, /\bdo zero\b/i, /\bprimeiro milh[aã]o\b/i,
];

const HISTORIA = [
  /\bquando eu\b/i, /\baconteceu comigo\b/i, /\bna minha (vida|[eé]poca|casa)\b/i,
  /\beu (vi|testei|tentei|passei|perdi|comecei|errei)\b/i, /\bminha experi[eê]ncia\b/i,
  /\bum dia\b/i, /\bteve uma vez\b/i, /\bo cara (me|chegou|falou)\b/i,
];

const PERGUNTA = [
  /\?/, /\bpor que\b/i, /\bcomo (voc[eê]|fazer|que|assim)\b/i, /\bo que (voc[eê]|acontece|fazer)\b/i,
  /\bqual (a|o|e|é)\b/i, /\bvoc[eê] j[aá]\b/i, /\bser[aá] que\b/i, /\bquantas? vezes\b/i,
];

const ACIONAVEL = [
  /\bprimeir[oa] (passo|coisa)\b/i, /\bsegund[oa]\b/i, /\bterceir[oa]\b/i, /\bpasso \d/i,
  /\bvoc[eê] (tem|precisa|deve)\b/i, /\banota (isso|a[ií])\b/i, /\bfa[cz](a|e) (isso|assim)\b/i,
  /\bcome[cç]a (por|com|hoje)\b/i, /\ba dica (e|é)\b/i, /\bregra n[uú]mero\b/i,
];

/**
 * Vocabulario do publico infantil de games (8 a 12 anos): Roblox, abertura de
 * carta, sorteio, pet raro. Aqui ninguem para o dedo por argumento - para por
 * raridade, numero absurdo, sorte e reacao. O lexico de cima, de podcast
 * adulto ("o segredo e", "a maioria das pessoas"), nao encosta nesse publico.
 */
const GANCHO_KIDS = [
  /\bolha (o que|isso|s[oó]|a[ií]|esse|essa)\b/i, /\bn[aã]o acredito\b/i,
  /\bvem comigo\b/i, /\badivinh\w*\b/i, /\bchut\w*\b/i,
  /\bvamos (abrir|tentar|ver)\b/i, /\bvou abrir\b/i, /\bo que ser[aá] que\b/i,
  /\bser[aá] que (vem|veio|vai|eu|ele)\b/i, /\bt[aá] vendo (isso|essa|esse)\b/i,
  /\bprimeira vez\b/i, /\bnunca vi\b/i, /\bimposs[ií]vel\b/i,
  /\bum em um milh[aã]o\b/i, /\bacabei de\b/i, /\bfinalmente\b/i,
  /\bmais rar[oa]\b/i, /\bmais car[oa]\b/i, /\bmelhor do jogo\b/i,
  /\bvale a pena\b/i, /\bquanto (custa|vale|deu|ser[aá])\b/i, /\bdeu ruim\b/i,

  // O que mais prende crianca de 8 a 16 em video de jogo: a abertura em si,
  // o momento da revelacao, e a comparacao "quem tem o melhor".
  /\bvou (abrir|tentar|testar|comprar|gastar)\b/i,
  /\bacabou de (vir|sair|aparecer)\b/i,
  /\bveio (o|um|uma|meu)\b/i, /\bsaiu (o|um|uma)\b/i,
  /\bconsegui (o|um|uma)\b/i, /\bpeguei (o|um|uma)\b/i,
  /\bmais forte do (jogo|servidor)\b/i, /\bmais caro do (jogo|servidor)\b/i,
  /\bquem (tem|ganha|vence)\b/i, /\bdesafio\b/i, /\bapost\w*\b/i,
  /\bgastei\b/i, /\bpaguei\b/i, /\btroquei\b/i,
  /\bninguem (tem|consegue|conseguiu)\b/i, /\bningu[eé]m (tem|consegue|conseguiu)\b/i,
  /\bo [uú]ltimo\b/i, /\bfalta (s[oó]|um|uma)\b/i,
];

const EMOCAO_KIDS = [
  /\brar[oa]\b/i, /\blend[aá]ri[oa]\b/i, /\bsecret[oa]\b/i, /\bm[ií]tic[oa]\b/i,
  /\bexclusiv[oa]\b/i, /\bmuta[cç][aã]o\b/i, /\bgigante\b/i, /\bhuge\b/i,
  /\bsorte\b/i, /\bazar\b/i, /\bvalios[oa]\b/i, /\bbrilhante\b/i, /\bdourad[oa]\b/i,
  /\bshiny\b/i, /\bcarta\b/i, /\bpok[eé]mon\b/i, /\bpack\b/i, /\bbooster\b/i,
  /\bmais forte\b/i, /\bop\b/i, /\bbugad[oa]\b/i, /\bquebrad[oa]\b/i,
  /\bplatina\b/i, /\bespecial\b/i, /\bnovo\b/i, /\bpremio\b/i, /\bpr[eê]mio\b/i,
];

// Comecar com isso significa que o corte pega o assunto pela metade.
const ABERTURA_RUIM = /^(ent[aã]o|mas|e|a[ií]|porque|por[eé]m|da[ií]|s[oó] que|tamb[eé]m|ou seja|isso|ele|ela|eles|elas|esse|essa)\b/i;

const FILLERS = /\b(n[eé]|tipo|assim|hum+|ahn+|sabe|entendeu|beleza)\b/gi;

// ---------------------------------------------------------------- utilidades

function contar(texto, lista) {
  let n = 0;
  for (const re of lista) if (re.test(texto)) n++;
  return n;
}

function normalizarTexto(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function mmss(s) {
  s = Math.max(0, Math.round(s || 0));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// ---------------------------------------------------------------- frases

/** Junta as palavras da transcricao numa lista unica e limpa. */
function achatarPalavras(transcricao) {
  const palavras = [];
  for (const seg of transcricao.segmentos || []) {
    for (const p of seg.palavras || []) {
      const texto = normalizarTexto(p.texto);
      if (!texto) continue;
      palavras.push({ inicio: p.inicio, fim: p.fim, texto, conf: p.conf == null ? 1 : p.conf });
    }
  }
  palavras.sort((a, b) => a.inicio - b.inicio);
  return palavras;
}

/** Quebra em frases por pontuacao final ou por pausa longa na fala. */
function montarFrases(palavras) {
  const frases = [];
  let atual = [];

  for (let i = 0; i < palavras.length; i++) {
    const p = palavras[i];
    const prox = palavras[i + 1];
    atual.push(p);

    const terminaPontuacao = /[.!?…]["')\]]?$/.test(p.texto);
    const pausa = prox ? prox.inicio - p.fim : Infinity;
    const longaDemais = atual.length >= 28;

    if (terminaPontuacao || pausa >= 0.7 || longaDemais || !prox) {
      frases.push({
        inicio: atual[0].inicio,
        fim: atual[atual.length - 1].fim,
        texto: normalizarTexto(atual.map((w) => w.texto).join(' ')),
        palavras: atual,
        terminaCompleta: terminaPontuacao,
        pausaDepois: pausa === Infinity ? 2 : pausa,
      });
      atual = [];
    }
  }
  return frases;
}

// ---------------------------------------------------------------- energia do audio

/**
 * RMS por segundo, normalizado de 0 a 1. Serve pra perceber onde a pessoa
 * levantou a voz, riu, enfatizou - costuma coincidir com o momento bom.
 */
function energiaDaJanela(energia, inicio, fim) {
  if (!energia || !energia.length) return { media: 0.5, pico: 0.5, variacao: 0.3 };
  const a = Math.max(0, Math.floor(inicio));
  const b = Math.min(energia.length - 1, Math.ceil(fim));
  if (b <= a) return { media: 0.5, pico: 0.5, variacao: 0.3 };

  let soma = 0, pico = 0, n = 0;
  for (let i = a; i <= b; i++) { soma += energia[i]; pico = Math.max(pico, energia[i]); n++; }
  const media = n ? soma / n : 0;

  let varSoma = 0;
  for (let i = a; i <= b; i++) varSoma += Math.pow(energia[i] - media, 2);
  const desvio = n ? Math.sqrt(varSoma / n) : 0;

  return { media, pico, variacao: desvio };
}

// ---------------------------------------------------------------- nota

function pontuar(janela, energia, perfil) {
  const texto = janela.texto;
  const primeira = janela.frases[0].texto;
  const segunda = janela.frases[1] ? janela.frases[1].texto : '';
  const motivos = [];
  let nota = 15; // base: um trecho neutro nao e zero, so nao e especial

  const kids = perfil !== "fala";   // reacao e auto atendem o publico de games
  const listaGancho = kids ? GANCHO_ABERTURA.concat(GANCHO_KIDS) : GANCHO_ABERTURA;
  const listaEmocao = kids ? EMOCAO.concat(EMOCAO_KIDS) : EMOCAO;

  // ---- o que TikTok, Shorts e Reels realmente medem ----
  // Os tres rankeiam por retencao: quanto do video a pessoa assistiu, se
  // reassistiu, se comentou. Nada disso acontece se os primeiros segundos
  // nao segurarem. Entao esses fatores pesam mais que qualquer outro.

  const todasPalavras = janela.frases.reduce((acc, f) => acc.concat(f.palavras), []);

  // Quanto tempo de silencio antes da primeira palavra do corte.
  // Comecar em silencio e a forma mais rapida de perder o espectador.
  const atrasoInicial = todasPalavras.length ? todasPalavras[0].inicio - janela.inicio : 0;

  // O que e dito nos 3 primeiros segundos - a janela que decide tudo.
  const limite3s = janela.inicio + 3;
  const texto3s = normalizarTexto(
    todasPalavras.filter((p) => p.inicio < limite3s).map((p) => p.texto).join(' ')
  );

  // Maior buraco de silencio no meio do corte.
  let maiorPausa = 0;
  for (let i = 1; i < todasPalavras.length; i++) {
    maiorPausa = Math.max(maiorPausa, todasPalavras[i].inicio - todasPalavras[i - 1].fim);
  }

  // 0a. Gancho nos 3 primeiros segundos - o fator numero um de retencao
  if (contar(texto3s, listaGancho) > 0) {
    nota += 14;
    motivos.push({ fator: 'Gancho nos 3 primeiros segundos', pontos: 14 });
  } else if (texto3s && (contar(texto3s, listaEmocao) > 0 || contar(texto3s, PERGUNTA) > 0 ||
                         /\d/.test(texto3s))) {
    nota += 6;
    motivos.push({ fator: 'Abre com impacto', pontos: 6 });
  }

  // 0b. Entra falando na hora
  if (atrasoInicial <= 0.35) {
    nota += 4;
    motivos.push({ fator: 'Entra falando na hora', pontos: 4 });
  } else if (atrasoInicial > 1.2) {
    nota -= 10;
    motivos.push({ fator: 'Comeca com silencio', pontos: -10 });
  }

  // 0c. Buraco de silencio no meio derruba a retencao
  if (maiorPausa > 2.2) {
    nota -= 9;
    motivos.push({ fator: 'Tem pausa morta no meio', pontos: -9 });
  } else if (maiorPausa > 1.5) {
    nota -= 4;
    motivos.push({ fator: 'Tem uma pausa longa', pontos: -4 });
  }

  // 0d. Energia dos primeiros segundos comparada ao resto do corte
  const e3 = energiaDaJanela(energia, janela.inicio, limite3s);
  const eTudo = energiaDaJanela(energia, janela.inicio, janela.fim);
  if (e3.media > eTudo.media * 1.08 && e3.media > 0.3) {
    nota += 6;
    motivos.push({ fator: 'Comeca com a voz no alto', pontos: 6 });
  }

  // 1. Gancho na abertura - o fator que mais decide se a pessoa fica.
  // Vale cheio se o gancho e a PRIMEIRA coisa dita; pela metade se vem na
  // segunda frase. Assim a janela que abre direto no gancho ganha da janela
  // que arrasta uma frase de enrolacao antes dele.
  const ganchoNaPrimeira = contar(primeira, listaGancho);
  const ganchoNaSegunda = contar(segunda, listaGancho);
  if (ganchoNaPrimeira > 0) {
    const p = Math.min(26, 14 + ganchoNaPrimeira * 7);
    nota += p;
    motivos.push({ fator: 'Abre direto no gancho', pontos: p });
  } else if (ganchoNaSegunda > 0) {
    const p = Math.min(11, 6 + ganchoNaSegunda * 3);
    nota += p;
    motivos.push({ fator: 'Gancho logo no comeco', pontos: p });
  }

  // 2. Curiosidade / revelacao
  const cur = contar(texto, CURIOSIDADE);
  if (cur > 0) {
    const p = Math.min(12, cur * 4);
    nota += p;
    motivos.push({ fator: 'Promete revelar algo', pontos: p });
  }

  // 3. Virada / contraste - quebra de expectativa segura o espectador
  const con = contar(texto, CONTRASTE);
  if (con > 0) {
    const p = Math.min(8, con * 3);
    nota += p;
    motivos.push({ fator: 'Tem virada de raciocinio', pontos: p });
  }

  // 4. Numero concreto
  const numeros = (texto.match(/\b\d+([.,]\d+)?\b/g) || []).length;
  const res = contar(texto, RESULTADO);
  if (numeros > 0 || res > 0) {
    const p = Math.min(10, numeros * 2 + res * 4);
    nota += p;
    motivos.push({ fator: 'Traz numero / resultado concreto', pontos: p });
  }

  // 5. Carga emocional
  const emo = contar(texto, listaEmocao);
  if (emo > 0) {
    const p = Math.min(10, Math.round(emo * 2.5));
    nota += p;
    motivos.push({ fator: 'Carga emocional alta', pontos: p });
  }

  // 6. Pergunta - puxa resposta mental e comentario
  const perg = contar(texto, PERGUNTA);
  if (perg > 0) {
    const p = Math.min(6, perg * 2);
    nota += p;
    motivos.push({ fator: 'Faz pergunta pro espectador', pontos: p });
  }

  // 7. Historia pessoal
  const hist = contar(texto, HISTORIA);
  if (hist > 0) {
    const p = Math.min(7, hist * 3);
    nota += p;
    motivos.push({ fator: 'Conta historia pessoal', pontos: p });
  }

  // 8. Conteudo acionavel
  const acao = contar(texto, ACIONAVEL);
  if (acao > 0) {
    const p = Math.min(7, Math.round(acao * 2.5));
    nota += p;
    motivos.push({ fator: 'Entrega algo aplicavel', pontos: p });
  }

  // 9. Energia da voz
  const e = energiaDaJanela(energia, janela.inicio, janela.fim);
  const bonusEnergia = e.media * 5 + e.variacao * 12;
  if (bonusEnergia > 2.5) {
    const p = Math.round(Math.min(8, bonusEnergia));
    nota += p;
    motivos.push({ fator: 'Voz com energia e variacao', pontos: p });
  }

  // 10. Ritmo de fala - muito lento cansa, muito rapido nao entra
  const totalPalavras = janela.frases.reduce((n, f) => n + f.palavras.length, 0);
  const ritmo = totalPalavras / Math.max(1, janela.fim - janela.inicio);
  if (ritmo >= 2.2 && ritmo <= 3.8) {
    nota += 5;
    motivos.push({ fator: 'Ritmo de fala bom', pontos: 5 });
  } else if (ritmo < 1.5) {
    nota -= 6;
    motivos.push({ fator: 'Fala arrastada demais', pontos: -6 });
  }

  // 11. Fecha a ideia em vez de cortar no meio
  if (janela.frases[janela.frases.length - 1].terminaCompleta) {
    nota += 6;
    motivos.push({ fator: 'Fecha a ideia por completo', pontos: 6 });
  } else {
    nota -= 5;
    motivos.push({ fator: 'Termina com a frase pela metade', pontos: -5 });
  }

  // 12. Duracao. Aqui a regra do algoritmo e contra-intuitiva: o que conta e a
  // porcentagem assistida, nao os segundos. Um corte de 30s terminado inteiro
  // entrega mais sinal que um de 60s abandonado na metade. Entao a curva premia
  // o mais curto e cobra caro do que passa de 50s.
  const dur = janela.fim - janela.inicio;
  let pDur;
  if (dur <= 40) pDur = Math.round(Math.max(0, 6 - Math.abs(dur - 30) * 0.22));
  else pDur = Math.round(Math.max(-8, 6 - (dur - 40) * 0.55));

  if (pDur !== 0) {
    nota += pDur;
    motivos.push({
      fator: pDur > 0 ? 'Duracao boa pra terminar (' + Math.round(dur) + 's)'
                      : 'Longo demais pra taxa de conclusao (' + Math.round(dur) + 's)',
      pontos: pDur,
    });
  }

  // 13. Fecho que puxa comentario - comentario e compartilhamento sao os sinais
  // que mais aceleram a distribuicao depois da retencao.
  const ultima = janela.frases[janela.frases.length - 1].texto;
  if (/\?/.test(ultima) || contar(ultima, PERGUNTA) > 0) {
    nota += 7;
    motivos.push({ fator: 'Termina puxando resposta', pontos: 7 });
  } else if (contar(ultima, listaEmocao) > 0 || /[!]/.test(ultima)) {
    nota += 4;
    motivos.push({ fator: 'Termina com impacto', pontos: 4 });
  }

  // -- penalidades --

  // Abre no meio do assunto - quem chega no corte nao viu o que veio antes
  if (ABERTURA_RUIM.test(primeira)) {
    nota -= 18;
    motivos.push({ fator: 'Comeca no meio do assunto', pontos: -18 });
  }

  // Primeira frase curta e sem gancho: quase sempre e sobra da fala anterior
  if (!ganchoNaPrimeira && primeira.split(/\s+/).length <= 6) {
    nota -= 7;
    motivos.push({ fator: 'Abre com frase solta', pontos: -7 });
  }

  // Vicio de linguagem demais
  const fillers = (texto.match(FILLERS) || []).length;
  const taxaFiller = fillers / Math.max(1, totalPalavras);
  if (taxaFiller > 0.045) {
    const p = -Math.min(10, Math.round(taxaFiller * 120));
    nota += p;
    motivos.push({ fator: 'Muito vicio de linguagem', pontos: p });
  }

  // Repeticao (o modelo travando ou a pessoa enrolando)
  const tokens = texto.toLowerCase().match(/[a-zà-ú]{4,}/g) || [];
  const unicos = new Set(tokens).size;
  const diversidade = unicos / Math.max(1, tokens.length);
  if (diversidade < 0.45) {
    nota -= 8;
    motivos.push({ fator: 'Repete muito as mesmas palavras', pontos: -8 });
  }

  // Transcricao insegura = provavel audio ruim ali
  const confMedia = janela.frases.reduce((s, f) => {
    const c = f.palavras.reduce((a, w) => a + (w.conf == null ? 1 : w.conf), 0) / Math.max(1, f.palavras.length);
    return s + c;
  }, 0) / Math.max(1, janela.frases.length);
  if (confMedia < 0.6) {
    nota -= 6;
    motivos.push({ fator: 'Audio confuso nesse trecho', pontos: -6 });
  }

  // Comprime a faixa alta em vez de cortar em 100: senao varios trechos bons
  // empatam no teto e o ranking, que e o ponto do sistema, perde o sentido.
  if (nota > 82) nota = 82 + (nota - 82) * 0.38;
  nota = Math.max(1, Math.min(99, Math.round(nota)));
  motivos.sort((a, b) => b.pontos - a.pontos);

  // Mostra os pontos fortes, mas sempre deixa a pior fraqueza aparecer -
  // e ela que explica por que um trecho bom nao pontuou mais.
  const bons = motivos.filter((m) => m.pontos > 0).slice(0, 4);
  const ruins = motivos.filter((m) => m.pontos < 0);
  const resumo = bons.concat(ruins.length ? [ruins[ruins.length - 1]] : []);

  return { nota, motivos: resumo, ritmo, energiaInfo: e };
}

// ---------------------------------------------------------------- momentos

// Quanto o acontecimento pesa em relacao ao que foi dito.
const PESO_DO_PERFIL = {
  fala: 0.35,      // aula, podcast, review falado: o argumento e o produto
  reacao: 1.15,    // abertura, sorteio, susto: a revelacao e o produto
  auto: 1.0,
};

/**
 * Premia a janela que contem um pico de verdade - e premia mais quando o pico
 * esta bem posicionado: com suspense antes pra criar expectativa, e com folga
 * depois pra caber a reacao. Pico logo no primeiro segundo nao funciona (a
 * pessoa nao teve tempo de se importar), e pico no fim tambem nao (ela desiste
 * antes de chegar la).
 */
function bonusDeMomento(janela, momentos, perfil) {
  const peso = PESO_DO_PERFIL[perfil] != null ? PESO_DO_PERFIL[perfil] : 1;
  if (!momentos || !momentos.length || peso === 0) return {};

  const dentro = momentos.filter((m) => m.tempo >= janela.inicio && m.tempo <= janela.fim);
  if (!dentro.length) return {};

  const dur = Math.max(1, janela.fim - janela.inicio);
  const extras = [];
  let ganho = 0;

  const principal = dentro.reduce((a, b) => (b.forca > a.forca ? b : a));
  const posicao = (principal.tempo - janela.inicio) / dur;

  // forca 1.9 a 3.0 vira 8 a 18 pontos
  let base = Math.min(15, 5 + (principal.forca - 2.3) * 11);

  // posicao: o ponto doce e entre 25% e 65% do corte
  if (posicao >= 0.25 && posicao <= 0.65) base *= 1.25;
  else if (posicao < 0.12) base *= 0.55;
  else if (posicao > 0.85) base *= 0.5;

  ganho += base * peso;
  extras.push({
    fator: principal.tipo === 'voz+cena' ? 'Tem o momento (voz e imagem)' : 'Tem pico de reacao',
    pontos: Math.round(base * peso),
  });

  // Suspense antes da explosao: e o que segura o dedo ate a revelacao
  if (principal.temSuspense) {
    const p = 6 * peso;
    ganho += p;
    extras.push({ fator: 'Suspense antes da revelacao', pontos: Math.round(p) });
  }

  // Mais de um pico no mesmo corte: o trecho e movimentado do inicio ao fim
  if (dentro.length >= 2) {
    const p = Math.min(7, dentro.length * 2) * peso;
    ganho += p;
    extras.push({ fator: dentro.length + ' momentos no mesmo corte', pontos: Math.round(p) });
  }

  let nota = janela.nota + ganho;
  if (nota > 82) nota = 82 + (nota - 82) * 0.38;
  nota = Math.max(1, Math.min(99, Math.round(nota)));

  const motivos = (janela.motivos || []).concat(extras)
    .sort((a, b) => b.pontos - a.pontos);
  const bons = motivos.filter((m) => m.pontos > 0).slice(0, 4);
  const ruins = motivos.filter((m) => m.pontos < 0);

  return {
    nota,
    rotulo: rotulo(nota),
    motivos: bons.concat(ruins.length ? [ruins[ruins.length - 1]] : []),
    momentoEm: Math.round(principal.tempo * 10) / 10,
  };
}

/**
 * O que a pessoa escreveu que queria. Vale bastante: e o unico lugar do
 * sistema onde ela diz o que importa NAQUELE video, e nao no geral.
 */
function bonusDeIntencao(janela, intencao) {
  if (!intencao) return {};
  const r = combinarIntencao(janela.texto, intencao);
  if (!r.pontos) return {};

  let nota = janela.nota + r.pontos;
  if (nota > 82) nota = 82 + (nota - 82) * 0.38;
  nota = Math.max(1, Math.min(99, Math.round(nota)));

  const extras = r.motivos.map(function (m) {
    return { fator: "E " + m.fator, pontos: m.pontos };
  });
  const todos = (janela.motivos || []).concat(extras).sort(function (a, b) { return b.pontos - a.pontos; });
  const bons = todos.filter(function (m) { return m.pontos > 0; }).slice(0, 4);
  const ruins = todos.filter(function (m) { return m.pontos < 0; });

  return { nota: nota, rotulo: rotulo(nota), motivos: bons.concat(ruins.length ? [ruins[ruins.length - 1]] : []) };
}

// ---------------------------------------------------------------- titulo

const PARADA = new Set(['que','para','com','uma','como','mais','dos','das','por','isso','aqui','esse','essa','você','voce','então','entao','muito','tem','não','nao','sim','vai','são','sao','pra','pro','the','and','seu','sua','meu','minha','ele','ela','nos','nós','tudo','todo','toda','ser','ter','fazer','está','esta','estão','foi','era','uns','umas','quando','porque','depois','agora','gente','coisa','coisas','fica','ficar','pode','vamos','sobre','cada','onde']);

/** Escolhe a frase mais chamativa do trecho e transforma em titulo curto. */
function gerarTitulo(janela) {
  let melhor = null;
  let melhorNota = -Infinity;

  for (const f of janela.frases.slice(0, 4)) {
    const t = f.texto;
    if (t.split(/\s+/).length < 4) continue;
    let n = 0;
    n += contar(t, GANCHO_ABERTURA) * 6;
    n += contar(t, CURIOSIDADE) * 4;
    n += contar(t, RESULTADO) * 4;
    n += contar(t, PERGUNTA) * 3;
    n += contar(t, EMOCAO) * 2;
    n += (t.match(/\b\d+\b/g) || []).length * 2;
    if (ABERTURA_RUIM.test(t)) n -= 3;
    if (n > melhorNota) { melhorNota = n; melhor = t; }
  }

  let base = melhor || janela.frases[0].texto;
  base = base.replace(/^(ent[aã]o|mas|e|a[ií]|porque|da[ií]|ou seja)[,\s]+/i, '');
  base = base.replace(/[.!?…]+$/, '').trim();

  if (base.length > 68) {
    const corte = base.slice(0, 68);
    const esp = corte.lastIndexOf(' ');
    base = (esp > 40 ? corte.slice(0, esp) : corte) + '...';
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Palavras-chave do trecho, pra virar hashtag/legenda. */
function gerarTags(janela) {
  const freq = new Map();
  const tokens = janela.texto.toLowerCase().match(/[a-zà-ú]{4,}/g) || [];
  for (const t of tokens) {
    if (PARADA.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((par) => par[0]);
}

function rotulo(nota) {
  if (nota >= 82) return { texto: 'Altissimo', cor: 'otimo' };
  if (nota >= 68) return { texto: 'Alto', cor: 'bom' };
  if (nota >= 54) return { texto: 'Medio', cor: 'medio' };
  return { texto: 'Baixo', cor: 'fraco' };
}

// ---------------------------------------------------------------- principal

/**
 * @param {object} transcricao  saida do transcrever.py
 * @param {number[]} energia    RMS por segundo (0..1)
 * @param {object} opcoes       { quantidade, minDur, maxDur }
 */
function encontrarCortes(transcricao, energia, opcoes) {
  opcoes = opcoes || {};
  const quantidade = opcoes.quantidade || 8;
  const minDur = opcoes.minDur || MIN_DUR;
  const maxDur = opcoes.maxDur || MAX_DUR;
  const momentos = opcoes.momentos || [];
  const perfil = opcoes.perfil || 'auto';

  const palavras = achatarPalavras(transcricao);
  const frases = montarFrases(palavras);
  if (!frases.length) return [];

  const janelas = [];
  const jaVi = new Set();

  function registrar(i, fim) {
    const chave = i + ':' + fim;
    if (jaVi.has(chave)) return;
    jaVi.add(chave);
    const grupo = frases.slice(i, fim + 1);
    janelas.push({
      inicio: frases[i].inicio,
      fim: frases[fim].fim,
      frases: grupo,
      texto: normalizarTexto(grupo.map((f) => f.texto).join(' ')),
    });
  }

  // Todas as janelas que comecam e terminam em frase inteira
  for (let i = 0; i < frases.length; i++) {
    let fim = i;
    while (fim < frases.length) {
      const dur = frases[fim].fim - frases[i].inicio;
      if (dur > maxDur) break;
      if (dur >= minDur) registrar(i, fim);
      fim++;
    }
  }

  // Janelas ancoradas nos picos. Numa abertura de carta, o corte certo nao
  // comeca numa frase bonita: comeca no suspense e termina depois da reacao.
  // Aqui a gente monta o corte em volta do acontecimento.
  for (const m of momentos.slice(0, 40)) {
    for (const antes of [6, 12, 20]) {
      const alvoInicio = m.tempo - antes;
      let i = 0;
      for (let k = 0; k < frases.length; k++) {
        if (frases[k].inicio <= alvoInicio) i = k; else break;
      }
      for (let fim = i; fim < frases.length; fim++) {
        const dur = frases[fim].fim - frases[i].inicio;
        if (dur > maxDur) break;
        // o pico precisa caber dentro, com folga pra reacao depois dele
        if (dur >= minDur && frases[fim].fim >= m.tempo + 4) { registrar(i, fim); break; }
      }
    }
  }

  if (!janelas.length) return [];

  for (const j of janelas) {
    Object.assign(j, pontuar(j, energia, perfil));
    Object.assign(j, bonusDeMomento(j, momentos, perfil));
    Object.assign(j, bonusDeIntencao(j, opcoes.intencao));
  }
  janelas.sort((a, b) => b.nota - a.nota);

  // Supressao de sobreposicao: dois cortes nao podem ser quase o mesmo trecho
  const escolhidos = [];
  for (const j of janelas) {
    const conflita = escolhidos.some((e) => {
      const sobrepoe = Math.min(e.fim, j.fim) - Math.max(e.inicio, j.inicio);
      if (sobrepoe <= 0) return false;
      const menor = Math.min(e.fim - e.inicio, j.fim - j.inicio);
      return sobrepoe / menor > 0.3;
    });
    if (!conflita) escolhidos.push(j);
    if (escolhidos.length >= quantidade) break;
  }

  // Devolve na ordem em que aparecem no video
  escolhidos.sort((a, b) => a.inicio - b.inicio);

  return escolhidos.map((j, idx) => ({
    numero: idx + 1,
    inicio: Math.round(j.inicio * 100) / 100,
    fim: Math.round(j.fim * 100) / 100,
    duracao: Math.round((j.fim - j.inicio) * 10) / 10,
    inicioTexto: mmss(j.inicio),
    fimTexto: mmss(j.fim),
    nota: j.nota,
    rotulo: rotulo(j.nota),
    titulo: gerarTitulo(j),
    tags: gerarTags(j),
    motivos: j.motivos,
    texto: j.texto,
    palavras: j.frases.reduce((acc, f) => acc.concat(f.palavras), []),
  }));
}

module.exports = { encontrarCortes, montarFrases, achatarPalavras, mmss, rotulo };
