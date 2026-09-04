'use strict';
/**
 * Camada opcional: a Claude le a transcricao inteira e revisa a escolha dos cortes.
 * So roda quando o usuario colou uma chave de API na janela. Sem chave, o sistema
 * usa apenas a analise local do score.js.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { mmss } = require('./score');

const MODELO = 'claude-opus-5';

const EsquemaCortes = z.object({
  cortes: z.array(z.object({
    inicio_segundos: z.number().describe('Segundo exato em que o corte deve comecar'),
    fim_segundos: z.number().describe('Segundo exato em que o corte deve terminar'),
    titulo: z.string().describe('Titulo curto e chamativo, em portugues, no maximo 70 caracteres'),
    gancho: z.string().describe('A primeira frase do corte, que segura o espectador'),
    nota_engajamento: z.number().describe('Nota de 0 a 100 do potencial de viralizar'),
    por_que: z.string().describe('Uma frase explicando por que esse trecho funciona'),
    hashtags: z.array(z.string()).describe('3 a 5 hashtags sem o simbolo #'),
  })),
});

const INSTRUCAO = [
  'Voce e um editor de cortes para TikTok, Reels e YouTube Shorts, especializado em conteudo em portugues do Brasil.',
  '',
  'Vou te dar a transcricao de um video longo, com o segundo de cada frase. Sua tarefa e escolher os melhores trechos para virarem cortes.',
  '',
  'Regras que nao podem ser quebradas:',
  '- Cada corte precisa durar entre 30 e 60 segundos.',
  '- O corte tem que comecar no comeco de uma frase e terminar no fim de uma frase. Nunca no meio.',
  '- Use apenas os tempos que aparecem na transcricao. Nao invente tempo que nao existe.',
  '- Os cortes nao podem se sobrepor.',
  '',
  'O que faz um corte funcionar:',
  '- Abre com um gancho: uma afirmacao forte, uma pergunta, um numero, uma promessa ou uma opiniao polemica.',
  '- Tem uma ideia completa, que se entende sozinha sem ter visto o resto do video.',
  '- Tem tensao ou virada: comeca de um jeito e termina de outro.',
  '- Termina com uma conclusao, nao com a pessoa mudando de assunto.',
  '- Evite trechos de saudacao, agradecimento, propaganda ou enrolacao.',
  '',
  'A nota de engajamento deve ser honesta: use 85+ so para trechos que voce apostaria que viralizam, e note abaixo de 60 o que e apenas razoavel.',
  'Escreva titulo, gancho, por_que e hashtags em portugues do Brasil.',
].join('\n');

/** Monta a transcricao em blocos com tempo, cabendo no contexto. */
function transcricaoMarcada(transcricao) {
  const linhas = [];
  for (const seg of transcricao.segmentos || []) {
    const t = (seg.texto || '').trim();
    if (!t) continue;
    linhas.push('[' + Math.round(seg.inicio) + 's | ' + mmss(seg.inicio) + '] ' + t);
  }
  return linhas.join('\n');
}

/**
 * @param {Array} cortesLocais  o que o score.js achou (serve de ponto de partida)
 * @param {object} transcricao
 * @param {string} chave        chave de API da Anthropic
 * @param {function} avisar
 */
async function revisarComIA(cortesLocais, transcricao, chave, avisar) {
  const client = new Anthropic({ apiKey: chave });

  const texto = transcricaoMarcada(transcricao);
  const quantidade = Math.max(4, Math.min(12, cortesLocais.length));

  if (avisar) avisar('Mandando a transcricao pra Claude analisar...');

  const resposta = await client.messages.parse({
    model: MODELO,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: INSTRUCAO,
    messages: [{
      role: 'user',
      content: [
        'Transcricao do video (o numero entre colchetes e o segundo em que a frase comeca):',
        '',
        texto,
        '',
        'Escolha os ' + quantidade + ' melhores trechos para virarem cortes.',
      ].join('\n'),
    }],
    output_config: {
      format: zodOutputFormat(EsquemaCortes),
    },
  });

  const saida = resposta.parsed_output;
  if (!saida || !Array.isArray(saida.cortes) || !saida.cortes.length) {
    throw new Error('a resposta veio vazia');
  }

  if (avisar) avisar('Claude escolheu ' + saida.cortes.length + ' trechos.');

  return alinharComATranscricao(saida.cortes, cortesLocais, transcricao);
}

/**
 * A IA acerta o trecho mas as vezes erra o segundo exato. Aqui a gente encaixa
 * o comeco e o fim na palavra real mais proxima, pra nao cortar no meio da silaba.
 */
function alinharComATranscricao(cortesIA, cortesLocais, transcricao) {
  const { achatarPalavras, montarFrases, rotulo } = require('./score');
  const frases = montarFrases(achatarPalavras(transcricao));
  if (!frases.length) return cortesLocais;

  const resultado = [];

  for (const c of cortesIA) {
    let ini = Number(c.inicio_segundos);
    let fim = Number(c.fim_segundos);
    if (!isFinite(ini) || !isFinite(fim) || fim <= ini) continue;

    // encaixa nas fronteiras de frase mais proximas
    const fInicio = maisProxima(frases, ini, 'inicio');
    const fFim = maisProxima(frases, fim, 'fim');
    ini = fInicio.inicio;
    fim = Math.max(fFim.fim, ini + 20);

    const dur = fim - ini;
    if (dur < 20 || dur > 75) continue;

    const palavras = [];
    let texto = [];
    for (const f of frases) {
      if (f.inicio >= ini - 0.05 && f.fim <= fim + 0.05) {
        palavras.push(...f.palavras);
        texto.push(f.texto);
      }
    }
    if (!palavras.length) continue;

    const nota = Math.max(1, Math.min(100, Math.round(Number(c.nota_engajamento) || 60)));

    resultado.push({
      inicio: Math.round(ini * 100) / 100,
      fim: Math.round(fim * 100) / 100,
      duracao: Math.round(dur * 10) / 10,
      inicioTexto: mmss(ini),
      fimTexto: mmss(fim),
      nota,
      rotulo: rotulo(nota),
      titulo: String(c.titulo || '').slice(0, 80) || 'Corte',
      tags: Array.isArray(c.hashtags) ? c.hashtags.slice(0, 5).map((h) => String(h).replace(/^#/, '')) : [],
      motivos: [{ fator: String(c.por_que || 'Escolhido pela IA'), pontos: nota }],
      texto: texto.join(' '),
      palavras,
      gancho: String(c.gancho || ''),
      porIA: true,
    });
  }

  if (!resultado.length) return cortesLocais;

  // tira sobreposicao que a IA por acaso tenha deixado
  resultado.sort((a, b) => b.nota - a.nota);
  const limpos = [];
  for (const r of resultado) {
    const bate = limpos.some((e) => Math.min(e.fim, r.fim) - Math.max(e.inicio, r.inicio) > 2);
    if (!bate) limpos.push(r);
  }

  limpos.sort((a, b) => a.inicio - b.inicio);
  limpos.forEach((c, i) => { c.numero = i + 1; });
  return limpos;
}

function maisProxima(frases, alvo, campo) {
  let melhor = frases[0];
  let dist = Infinity;
  for (const f of frases) {
    const d = Math.abs(f[campo] - alvo);
    if (d < dist) { dist = d; melhor = f; }
  }
  return melhor;
}

module.exports = { revisarComIA };
