@echo off
rem Garante o PATH basico do Windows - se ele vier quebrado, nada aqui funciona.
set "PATH=%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
chcp 65001 >nul 2>nul
title Cortador Automatico
cd /d "%~dp0"

echo.
echo   Iniciando o Cortador Automatico...
echo   A janela do programa abre sozinha em alguns segundos.
echo.
echo   NAO FECHE ESTA JANELA PRETA enquanto estiver usando.
echo.

rem Procura o Node: primeiro no PATH, depois nos lugares de sempre.
set "NODE="
node --version >nul 2>nul
if not errorlevel 1 set "NODE=node"

if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE goto semnode

if not exist "node_modules" (
  echo   Primeira vez rodando: instalando as bibliotecas...
  call npm install --silent
  echo.
)

"%NODE%" src\server.js
goto fim

:semnode
echo   [ERRO] Nao encontrei o Node.js nesta maquina.
echo.
echo   Baixe e instale em:  https://nodejs.org
echo   Depois abra este arquivo de novo.
echo.

:fim
echo.
echo   O programa foi encerrado.
pause
