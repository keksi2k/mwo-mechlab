@echo off
rem Starts the MWO Mechlab (API server and UI) and opens it in the browser.
rem On first start: installs dependencies and extracts the game data.
rem If Node.js is missing or too old, it offers to install the current LTS version.
setlocal
cd /d "%~dp0"
title MWO Mechlab

set "URL=http://127.0.0.1:5173"

call :findnode
if errorlevel 1 goto :nonode
call :checkversion
if errorlevel 1 goto :oldnode
goto :start

:nonode
echo.
echo Node.js was not found. The mechlab needs it to run.
goto :offer

:oldnode
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo.
echo Node.js %NODEVER% is too old, the mechlab needs 24 or newer.

:offer
echo It can be installed now: the current LTS version, from winget or nodejs.org.
echo This accepts the Node.js licence. Windows may ask for permission.
echo.
choice /c YN /m "Install Node.js now"
if errorlevel 2 goto :declined
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-node.ps1"
if errorlevel 1 goto :fail
rem The new PATH only reaches new windows; look in the install folders directly.
call :findnode
if errorlevel 1 goto :reopen
call :checkversion
if errorlevel 1 goto :reopen
echo.
echo Node.js is installed.

:start
if not exist "node_modules" (
  echo Installing dependencies ...
  call npm ci
  if errorlevel 1 goto :fail
)

rem No game data extracted yet? Do it now (after a patch: npm run extract).
dir /b /ad "data\build-*" >nul 2>nul
if not errorlevel 1 goto :run
rem Game folder: saved, or asked for here (npm run setup).
call npm run --silent setup -- --if-missing
if errorlevel 1 goto :nogamedir

:extract
echo Reading the game data from the MWO installation ...
call npm run --silent extract
if not errorlevel 1 goto :run
echo.
echo Reading the game data failed.
choice /c YN /m "Choose the MWO folder again"
if errorlevel 2 goto :fail
call npm run --silent setup
if errorlevel 1 goto :nogamedir
goto :extract

:run
echo.
echo Starting the mechlab at %URL%
echo Close this window or press Ctrl+C to stop it.
echo.
if not defined NO_BROWSER start "" cmd /c "timeout /t 4 /nobreak >nul & start %URL%"
call npm run dev
if errorlevel 1 goto :fail
exit /b 0

:nogamedir
echo.
echo No MWO folder set. Run start.bat again or set it with: npm run setup
pause
exit /b 1

:declined
echo.
echo Install the LTS version from https://nodejs.org and run start.bat again.
pause
exit /b 1

:reopen
echo.
echo Node.js was installed, but this window can't see it yet. Please run start.bat again.
pause
exit /b 1

:fail
echo.
echo Start failed. See README.md, section "Start".
pause
exit /b 1

rem ---- helpers -------------------------------------------------------------

rem Finds node.exe on PATH or in the usual install folders (adding them to PATH for this window).
:findnode
where node >nul 2>nul && exit /b 0
for %%d in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LocalAppData%\Programs\nodejs") do (
  if exist "%%~d\node.exe" (
    set "PATH=%%~d;%PATH%"
    exit /b 0
  )
)
exit /b 1

rem Succeeds when the found Node.js is 24 or newer ("call": node may be a .cmd shim from a version manager).
:checkversion
call node -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>nul
exit /b %errorlevel%
