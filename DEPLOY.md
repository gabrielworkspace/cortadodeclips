# Colocando o Cortador Automático online

## Por que não dá pra usar Vercel

Não é falta de configuração — é incompatibilidade de arquitetura. Este programa
não é um site: é um processador de vídeo. E cada característica dele bate de
frente com o que uma função serverless permite:

| O que o programa precisa | O que a Vercel oferece |
|---|---|
| Rodar por 5 a 20+ minutos numa chamada só | Função morre em 300s (Hobby) / até 1800s em beta (Pro) |
| Continuar processando depois de responder | A sandbox congela assim que a resposta é enviada |
| ffmpeg, yt-dlp e Python instalados | Nenhum dos três existe no runtime |
| Gravar e manter o vídeo em disco | Sistema de arquivos é somente leitura, exceto `/tmp` (efêmero) |
| Enviar um vídeo de centenas de MB | Limite de 4,5 MB por requisição |
| CPU 100% ocupada por minutos | Cobrança por CPU ativa — o pior caso pra esse tipo de carga |

A Vercel serviria, no máximo, pra hospedar uma página estática que aponta pra
um backend rodando em outro lugar. O backend em si precisa de um **processo
de longa duração com disco persistente** — ou seja, um container.

---

## Caminho rápido: testar num Docker qualquer

Funciona no seu PC, numa VPS, ou em qualquer lugar que rode Docker:

```bash
cp .env.example .env
# edite o .env e troque AUTH_SENHA por uma senha forte

docker compose up -d --build
```

Abra `http://localhost:8080` (ou `http://IP-DA-MAQUINA:8080` de outro
aparelho na mesma rede). A primeira build demora uns 5-10 minutos — ela baixa
o ffmpeg, o Python, as bibliotecas e o modelo de transcrição (~500 MB).

Os vídeos e clipes ficam no volume `dados`, que sobrevive a rebuilds.

---

## Deploy de verdade: Fly.io (recomendado)

É a plataforma que mais se encaixa nesse projeto: roda o `Dockerfile` como
está, sem reescrever nada, com CPU dedicada e disco persistente. O
`fly.toml` já vem pronto no repositório.

```bash
# 1. instale o flyctl
#    Windows (PowerShell):  pwsh -c "iwr https://fly.io/install.ps1 -useb | iex"
#    https://fly.io/docs/flyctl/install/

# 2. entre na sua conta
fly auth login

# 3. crie o app (ele detecta o fly.toml - responda "não" se perguntar
#    se quer sobrescrevê-lo)
fly launch --no-deploy

# 4. crie o disco persistente (40 GB dá pra uns 15-20 vídeos guardados)
fly volumes create dados --size 40 --region gru

# 5. defina a senha (OBRIGATÓRIO antes de ir ao ar)
fly secrets set AUTH_SENHA="sua-senha-forte-aqui"

# 6. deploy
fly deploy
```

Depois disso, `fly deploy` de novo é o que você roda a cada atualização de
código.

**Custo esperado** (setembro/2026): `performance-1x` (1 vCPU dedicada, 2 GB)
sai por volta de US$ 32/mês ligado 24 horas, mais ~US$ 6/mês pelo volume de
40 GB. Se aceitar que a máquina hiberne quando ninguém usa (economiza bastante,
mas tem a ressalva abaixo), o custo real de CPU cai pra uns US$ 3-10/mês.

**Duas armadilhas do Fly.io pra esse projeto específico:**

1. **Auto-stop no meio de um job.** O `fly.toml` já vem com
   `auto_stop_machines = false` — de propósito. Se você ligar isso pra
   economizar, a máquina pode ser desligada no meio de uma transcrição de
   15 minutos, e o job simplesmente some. Só ligue se aceitar esse risco.
2. **O volume monta vazio e como root.** O `Dockerfile` já resolve isso no
   entrypoint (ajusta o dono da pasta antes de rodar o programa) — não
   precisa fazer nada a mais.

---

## Outras plataformas que funcionam

Todas aceitam o `Dockerfile` como está.

| Plataforma | Por que | Custo aproximado/mês |
|---|---|---|
| **Fly.io** | Processo de longa duração, disco persistente, CPU dedicada | US$ 10-40 |
| **VPS (Hetzner CX43)** | Melhor custo por hora de CPU — o recurso que esse programa mais consome. Você vira o sysadmin (HTTPS, backups) | ~US$ 18 |
| **Railway** | Deploy mais simples, cobra por segundo de uso real | US$ 5-20 |
| **Render** | Gerenciado, mas caro nesse workload — plano de 1 CPU já deixa a transcrição bem mais lenta | US$ 25-85 |
| **Google Cloud Run Jobs** | Mais barato por job, mas exige reescrever a persistência pra GCS — não é "subir o Dockerfile e pronto" | variável |

Para reduzir os 5-20 minutos de transcrição pra 1-2 minutos, dá pra rodar
**só a transcrição** numa GPU alugada por hora (RunPod, Vast.ai) e manter o
resto num servidor barato — mas isso é uma segunda etapa, não o primeiro passo.

---

## O que só existe local (Windows) e por quê

Duas coisas do programa **não funcionam** quando ele roda em servidor, porque
dependem de estar na mesma máquina que você:

- **Escolher arquivo pelo diálogo do Windows.** Ele abriria uma janela no
  servidor, que ninguém vê. Em servidor, o único jeito de entrar com um vídeo
  do seu computador é fazer o **upload** pela própria página — que já
  funciona, com barra de progresso.
- **"Abrir a pasta" no Explorer.** Mesma lógica. Em servidor, o botão te dá o
  link de download do clipe em vez de abrir uma pasta que você não veria.

O link do YouTube/Kick/Twitch continua funcionando normalmente dos dois jeitos.

---

## Segurança — leia antes de ir ao ar

O programa **não tem senha nenhuma por padrão** — assim como sempre foi,
pra uso local isso nunca importou. No momento em que você expõe a porta pra
internet, isso muda: **qualquer pessoa que ache o endereço passa a usar a
CPU do seu servidor pra transcrever vídeo e o seu servidor como downloader de
YouTube.**

A variável `AUTH_SENHA` liga uma tela de login simples na frente de tudo.
**Defina ela sempre que for expor o servidor pra internet.** Sem ela, o
programa roda exatamente como sempre rodou — sem pedir nada a ninguém, porque
assume que só você tem acesso à máquina.

Outras proteções que já vêm prontas:
- Um vídeo processando por vez (evita duas transcrições brigando pela mesma CPU)
- Limite de tamanho de upload (`LIMITE_UPLOAD_MB`, padrão 8 GB)
- A rota que serve os clipes prontos (`/arquivo`) só entrega arquivos de
  dentro da pasta de saída — nada de fora dela, mesmo tentando escapar com
  `../`

---

## Depois do deploy: GitHub

```bash
git init
git add .
git commit -m "Cortador automático"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/cortador-automatico.git
git push -u origin main
```

O `.gitignore` já impede que os 6+ GB de vídeos, modelo e cache subam junto —
só o código vai (menos de 2 MB). Quem clonar o repositório builda a própria
imagem Docker e baixa o modelo na hora do build, exatamente como você fez.
