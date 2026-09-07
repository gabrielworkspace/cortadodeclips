# Cortador Automático

Transforma vídeo longo em cortes verticais prontos para TikTok, Reels e Shorts.

Você joga um vídeo (ou cola um link do YouTube/Kick), e ele:

1. baixa o vídeo, se for link
2. separa o áudio e transcreve tudo, com marcação por palavra
3. procura os picos de reação — onde a voz explode e a imagem muda
4. escolhe os melhores trechos e dá uma **nota de engajamento** para cada um
5. corta, enquadra em 9:16, grava a legenda e o gancho na tela
6. entrega os clipes ordenados do melhor para o pior, com títulos sugeridos

Depois de pronto, cada clipe tem um botão **Ajustar**: dá para reescrever o
gancho que aparece na tela e esticar ou encurtar o corte, com o resultado
saindo em segundos — ele reaproveita a transcrição em vez de ouvir tudo
de novo.

Tudo roda na sua máquina. Sem mensalidade, sem enviar seus vídeos para lugar nenhum.

---

## Rodar no seu PC (Windows)

Primeira vez:

```
instalar.bat
```

Isso instala ffmpeg, Python, o baixador de vídeos e o modelo de transcrição.
Leva uns 10 minutos e só precisa ser feito uma vez.

Depois, sempre que for usar:

```
iniciar.bat
```

A janela do programa abre sozinha. **Deixe a janela preta aberta** enquanto usa.

Ele lembra o que voce ajustou — onde fica a webcam, a cor da linha, o
formato, a quantidade de cortes. Na proxima vez ja abre do jeito que voce
deixou.

---

## O que cada pasta é

| Pasta | O que tem |
|---|---|
| `src/` | o código do programa |
| `py/` | o script de transcrição (Python) |
| `saida/` | os clipes gerados — organizados por vídeo e data |
| `baixados/` | os vídeos baixados de link |
| `trabalho/` | cache de áudio e transcrição (pode apagar para liberar espaço) |
| `modelos/` | o modelo de reconhecimento de fala |

As quatro últimas não vão para o Git — são pesadas e são geradas de novo.

---

## Como a nota de engajamento é calculada

Ela mede o que TikTok, Reels e Shorts realmente premiam: retenção.

**Soma ponto**
- gancho nos 3 primeiros segundos
- entra falando na hora, sem silêncio
- pico de reação dentro do corte (voz explodindo, imagem mudando)
- suspense antes da revelação
- número concreto, raridade, carga emocional
- duração que favorece assistir até o fim (25-35s)
- fecha puxando resposta

**Perde ponto**
- começa no meio do assunto
- pausa morta no meio
- vício de linguagem demais
- longo demais para a taxa de conclusão

A nota é um **filtro**, não uma bola de cristal: serve para você olhar primeiro
os de nota alta em vez de assistir o vídeo inteiro. Ela ainda não recebe retorno
das plataformas — para calibrar de verdade, compare as views reais com as notas
e ajuste os pesos em `src/score.js`.

---

## Opcional: deixar a IA escolher

Em **Ajustes** (o botao no topo da tela) há um campo para a chave da API da Anthropic. Com ela, a Claude
lê a transcrição inteira e escolhe os trechos entendendo contexto, ironia e piada —
coisa que a análise por regras não pega.

Sem chave, tudo funciona offline com a análise local.
