@echo off
rem run-forever.cmd - TLSBot keeper: restarts the bot if it ever exits.
rem Exit 3 = another instance holds the singleton lock (a keeper already runs).
rem Exit 9 = bad token (retrying cannot help). Anything else = crash, restart.
cd /d z:\nada\lol-rank-bot
:loop
node bot.mjs >> bot.log 2>&1
if %errorlevel%==3 exit /b 0
if %errorlevel%==9 exit /b 9
timeout /t 5 /nobreak > NUL
goto loop
